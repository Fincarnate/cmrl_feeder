const pool = require("../../../db/pool");
const policyQueries = require("../queries/policyQueries");
const { dispatchDecision } = require("./dispatchRules");
const { assertTransition } = require("./bookingStates");
const config = require("../../../config/env");

async function dispatchOne() {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const candidate = await client.query(`
          WITH demand AS (SELECT trip_id,COALESCE(SUM(seats_reserved),0)::int AS demand_seats,COUNT(*)::int AS passenger_count
            FROM booking WHERE UPPER(booking_status)='REQUESTED' GROUP BY trip_id)
          SELECT t.*,COALESCE(demand.demand_seats,0)::int AS demand_seats,COALESCE(demand.passenger_count,0)::int AS passenger_count,
            clock_timestamp() AS db_now
          FROM trip t LEFT JOIN demand ON demand.trip_id=t.trip_id
          WHERE t.trip_status='WAITING_FOR_PASSENGERS' AND (t.dispatch_deadline<=clock_timestamp() OR EXISTS(
            SELECT 1 FROM driver d JOIN vehicle v ON v.driver_id=d.driver_id
            WHERE d.is_online=TRUE AND UPPER(COALESCE(d.shift_status,'')) IN ('AVAILABLE','ONLINE')
              AND (CASE UPPER(TRIM(d.current_service_mode)) WHEN 'R2M' THEN 'RESIDENTIAL_TO_METRO' WHEN 'M2R' THEN 'METRO_TO_RESIDENTIAL' ELSE UPPER(TRIM(d.current_service_mode)) END)=t.trip_direction
              AND d.current_location IS NOT NULL AND d.location_recorded_at>clock_timestamp()-(COALESCE((t.dispatch_policy->>'driverLocationMaxAgeSeconds')::int,90)*interval '1 second')
              AND d.location_accuracy_m IS NOT NULL AND d.location_accuracy_m<=${Number(config.drtStopArrivalRadiusM)}
              AND v.is_active=TRUE AND COALESCE(v.is_frozen_until,FALSE)=FALSE
              AND v.max_capacity>=COALESCE(demand.demand_seats,0)
              AND v.max_capacity<=COALESCE((t.dispatch_policy->>'maximumVehicleCapacity')::int,8)
              AND NOT EXISTS(SELECT 1 FROM trip x WHERE x.driver_id=d.driver_id AND x.trip_status IN ('DISPATCHED','IN_PROGRESS'))
          )) ORDER BY t.dispatch_deadline,t.dispatch_started_at
          FOR UPDATE OF t SKIP LOCKED LIMIT 1
        `);
        const trip = candidate.rows[0];
        if (!trip) { await client.query("COMMIT"); return { processed:false }; }
        if (Number(trip.demand_seats) < 1) {
            await client.query("UPDATE trip SET trip_status='CANCELLED',updated_at=clock_timestamp() WHERE trip_id=$1",[trip.trip_id]);
            await client.query("COMMIT"); return { processed:true, outcome:"EMPTY_TRIP_CANCELLED" };
        }
        const policy = trip.dispatch_policy || await policyQueries.activeOperating(client);
        if (Number(trip.passenger_count) < Number(policy.minimumDispatchPassengers || 1)) {
            await failOrRetry(client,trip,policy,"Minimum passenger count was not met.");
            await client.query("COMMIT"); return { processed:true,outcome:"MINIMUM_NOT_MET" };
        }
        const drivers = await client.query(`
          SELECT d.driver_id,v.vehicle_id,v.max_capacity,d.current_location,
            (SELECT COUNT(*) FROM trip old WHERE old.driver_id=d.driver_id AND old.dispatched_at>clock_timestamp()-interval '1 day') AS assignments_today,
            ST_Distance(d.current_location::geography,pickup.geom::geography) AS pickup_distance
          FROM driver d JOIN vehicle v ON v.driver_id=d.driver_id JOIN metro_station ms ON ms.station_id=$1
          CROSS JOIN LATERAL (SELECT CASE WHEN $5='RESIDENTIAL_TO_METRO' THEN
              COALESCE((SELECT ST_Centroid(ST_Collect(sp.location_coords)) FROM booking b JOIN service_point sp ON sp.point_id=b.service_point_id WHERE b.trip_id=$6 AND b.booking_status='REQUESTED'),ms.station_coords)
              ELSE ms.station_coords END AS geom) pickup
          WHERE d.is_online=TRUE AND UPPER(COALESCE(d.shift_status,'')) IN ('AVAILABLE','ONLINE')
            AND (CASE UPPER(TRIM(d.current_service_mode)) WHEN 'R2M' THEN 'RESIDENTIAL_TO_METRO' WHEN 'M2R' THEN 'METRO_TO_RESIDENTIAL' ELSE UPPER(TRIM(d.current_service_mode)) END)=$7
            AND d.current_location IS NOT NULL
            AND d.location_accuracy_m IS NOT NULL AND d.location_accuracy_m<=${Number(config.drtStopArrivalRadiusM)}
            AND d.location_recorded_at>clock_timestamp()-($2::int*interval '1 second')
            AND v.is_active=TRUE AND COALESCE(v.is_frozen_until,FALSE)=FALSE
            AND v.max_capacity>=$3 AND v.max_capacity<=$4
            AND NOT EXISTS(SELECT 1 FROM trip x WHERE (x.driver_id=d.driver_id OR x.vehicle_id=v.vehicle_id) AND x.trip_status IN ('DISPATCHED','IN_PROGRESS'))
          ORDER BY v.max_capacity ASC,assignments_today ASC,pickup_distance ASC,d.driver_id
          FOR UPDATE OF d,v SKIP LOCKED LIMIT 1
        `,[trip.station_id,Number(policy.driverLocationMaxAgeSeconds||90),Number(trip.demand_seats),Number(policy.maximumVehicleCapacity||8),trip.trip_direction,trip.trip_id,trip.trip_direction]);
        const assignment = drivers.rows[0];
        if (!assignment) {
            await failOrRetry(client,trip,policy,"No online driver with a fresh location and suitable vehicle was available.");
            await client.query("COMMIT"); return { processed:true,outcome:"NO_DRIVER" };
        }
        const isExpired = new Date(trip.dispatch_deadline) <= new Date(trip.db_now);
        const decision = dispatchDecision({passengerCount:Number(trip.passenger_count),occupiedSeats:Number(trip.demand_seats),capacity:Number(assignment.max_capacity),deadlineExpired:isExpired,minimumPassengers:Number(policy.minimumDispatchPassengers||1)});
        if (decision === "EMPTY" || decision === "MINIMUM_NOT_MET" || decision === "OVER_CAPACITY") {
            await failOrRetry(client,trip,policy,decision);
            await client.query("COMMIT"); return {processed:true,outcome:decision};
        }
        const atCapacity = decision === "DISPATCH_FULL";
        if (!atCapacity && decision !== "DISPATCH_PARTIAL") { await client.query("COMMIT"); return { processed:false }; }
        assertTransition("REQUESTED", "ASSIGNED");
        await client.query(`UPDATE trip SET driver_id=$2,vehicle_id=$3,seat_capacity=$4,available_seats=$4-$5,
            trip_status='DISPATCHED',dispatched_at=clock_timestamp(),updated_at=clock_timestamp() WHERE trip_id=$1`,
            [trip.trip_id,assignment.driver_id,assignment.vehicle_id,assignment.max_capacity,trip.demand_seats]);
        await client.query("UPDATE driver SET shift_status='BUSY' WHERE driver_id=$1",[assignment.driver_id]);
        await client.query("UPDATE booking SET booking_status='ASSIGNED' WHERE trip_id=$1 AND booking_status='REQUESTED'",[trip.trip_id]);
        await createStopSequence(client,trip,assignment.driver_id);
        await client.query("INSERT INTO drt_engine_event(event_type,trip_id,actor_role,details) VALUES('TRIP_DISPATCHED',$1,'SYSTEM',$2::jsonb)",
            [trip.trip_id,JSON.stringify({driverId:assignment.driver_id,vehicleId:assignment.vehicle_id,seatCapacity:assignment.max_capacity,occupiedSeats:trip.demand_seats,partial:!atCapacity})]);
        await client.query("COMMIT");
        return { processed:true,outcome:"DISPATCHED",tripId:trip.trip_id };
    } catch(error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
}

async function failOrRetry(client,trip,policy,reason) {
    const attempts=Number(trip.dispatch_attempts)+1;
    if(attempts>=Number(policy.dispatchMaxAttempts||8)) {
        assertTransition("REQUESTED", "FAILED");
        await client.query("UPDATE trip SET trip_status='CANCELLED',dispatch_attempts=$2,updated_at=clock_timestamp() WHERE trip_id=$1",[trip.trip_id,attempts]);
        await client.query("UPDATE booking SET booking_status='FAILED' WHERE trip_id=$1 AND booking_status='REQUESTED'",[trip.trip_id]);
        await client.query("INSERT INTO drt_engine_event(event_type,trip_id,actor_role,details) VALUES('DISPATCH_FAILED',$1,'SYSTEM',$2::jsonb)",[trip.trip_id,JSON.stringify({reason,attempts})]);
        return;
    }
    await client.query("UPDATE trip SET dispatch_attempts=$2,dispatch_deadline=clock_timestamp()+($3::int*interval '1 minute'),updated_at=clock_timestamp() WHERE trip_id=$1",[trip.trip_id,attempts,Number(policy.dispatchRetryMinutes||1)]);
    await client.query("INSERT INTO drt_engine_event(event_type,trip_id,actor_role,details) VALUES('DISPATCH_RETRY_SCHEDULED',$1,'SYSTEM',$2::jsonb)",[trip.trip_id,JSON.stringify({reason,attempts})]);
}

async function createStopSequence(client,trip,driverId) {
    const points=trip.trip_direction==='RESIDENTIAL_TO_METRO'
        ? await client.query(`SELECT sp.point_id,sp.point_name,ST_X(sp.location_coords) AS longitude,ST_Y(sp.location_coords) AS latitude
            FROM service_point sp JOIN service_zone sz ON sz.zone_id=sp.zone_id JOIN metro_station ms ON ms.station_id=sz.station_id
            WHERE sp.zone_id=$1 AND sz.station_id=$2 AND ms.is_active=TRUE AND sz.is_active=TRUE AND sp.is_active=TRUE
              AND sp.verification_status='VERIFIED' AND sp.location_coords IS NOT NULL
              AND ms.service_area_polygon IS NOT NULL AND ms.station_coords IS NOT NULL AND sz.boundary_polygon IS NOT NULL
              AND sz.center_coords IS NOT NULL AND ST_Covers(ms.service_area_polygon,sz.center_coords)
              AND ST_Covers(sz.boundary_polygon,sp.location_coords)
            ORDER BY sp.point_name,sp.point_id`,[trip.zone_id,trip.station_id])
        : await client.query(`SELECT DISTINCT sp.point_id,sp.point_name,ST_X(sp.location_coords) AS longitude,ST_Y(sp.location_coords) AS latitude
            FROM booking b JOIN service_point sp ON sp.point_id=b.service_point_id JOIN service_zone sz ON sz.zone_id=sp.zone_id
            JOIN metro_station ms ON ms.station_id=sz.station_id
            WHERE b.trip_id=$1 AND b.zone_id=$2 AND sp.zone_id=$2 AND b.booking_status='ASSIGNED' AND sp.is_active=TRUE
              AND sp.verification_status='VERIFIED' AND sp.location_coords IS NOT NULL AND sz.is_active=TRUE AND ms.is_active=TRUE
              AND ms.service_area_polygon IS NOT NULL AND sz.boundary_polygon IS NOT NULL AND sz.center_coords IS NOT NULL
              AND ST_Covers(ms.service_area_polygon,sz.center_coords) AND ST_Covers(sz.boundary_polygon,sp.location_coords)
            ORDER BY sp.point_name,sp.point_id`,[trip.trip_id,trip.zone_id]);
    if(trip.trip_direction==='RESIDENTIAL_TO_METRO') {
        const start=await client.query("SELECT ST_X(current_location) AS longitude,ST_Y(current_location) AS latitude FROM driver WHERE driver_id=$1",[driverId]);
        points.rows=orderNearestNeighbor(points.rows,start.rows[0]);
    }
    let sequence=1;
    if(trip.trip_direction==='METRO_TO_RESIDENTIAL') {
        await client.query("INSERT INTO trip_stop_sequence(trip_id,station_id,stop_sequence,stop_status,stop_type) VALUES($1,$2,$3,'PENDING','STATION')",[trip.trip_id,trip.station_id,sequence++]);
        for(const point of points.rows) await client.query("INSERT INTO trip_stop_sequence(trip_id,point_id,stop_sequence,stop_status,stop_type) VALUES($1,$2,$3,'PENDING','SERVICE_POINT')",[trip.trip_id,point.point_id,sequence++]);
    } else {
        for(const point of points.rows) await client.query("INSERT INTO trip_stop_sequence(trip_id,point_id,stop_sequence,stop_status,stop_type) VALUES($1,$2,$3,'PENDING','SERVICE_POINT')",[trip.trip_id,point.point_id,sequence++]);
        await client.query("INSERT INTO trip_stop_sequence(trip_id,station_id,stop_sequence,stop_status,stop_type) VALUES($1,$2,$3,'PENDING','STATION')",[trip.trip_id,trip.station_id,sequence]);
    }
}

function geoDistance(a,b) {
    const rad=x=>x*Math.PI/180, lat1=rad(Number(a.latitude)),lat2=rad(Number(b.latitude));
    const dLat=lat2-lat1,dLon=rad(Number(b.longitude)-Number(a.longitude));
    const h=Math.sin(dLat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
    return 6371000*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));
}

function orderNearestNeighbor(points,start){
    const remaining=points.slice(),ordered=[];let current=start;
    while(remaining.length){remaining.sort((a,b)=>geoDistance(current,a)-geoDistance(current,b)||a.point_id.localeCompare(b.point_id));const next=remaining.shift();ordered.push(next);current=next;}
    return ordered;
}

module.exports={dispatchOne,orderNearestNeighbor};
