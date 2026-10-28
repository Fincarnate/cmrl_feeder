const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");

const enabled=process.env.DRT_WORKFLOW_INTEGRATION_TESTS==="1";

test("isolated recurring schedule, driver dispatch, manual location, Direct Booking, and cancellation workflow",{skip:!enabled},async t=>{
    process.env.JWT_SECRET ||= "cmrl-feeder-workflow-integration-test-secret";
    const pool=require("../src/db/pool");
    const buildApp=require("../src/app");
    const {generateToken}=require("../src/utils/jwt");
    const {materializeOneDueSchedule}=require("../src/modules/drt/services/scheduleService");
    const {dispatchOne}=require("../src/modules/drt/services/dispatchService");
    const app=buildApp();
    const ids={bookingIds:[],tripIds:[],scheduleId:null,userId:null,driverId:null,vehicleId:null,stationId:null,zoneId:null,pointId:null};
    const tag=crypto.randomUUID();

    async function cleanup(){
        const client=await pool.connect();
        try{
            await client.query("BEGIN");
            const discovered=await client.query(`SELECT array_agg(DISTINCT b.booking_id) AS ids,
              array_agg(DISTINCT b.trip_id) FILTER(WHERE b.trip_id IS NOT NULL) AS trips
              FROM booking b WHERE b.user_id=$1`,[ids.userId]);
            ids.bookingIds.push(...(discovered.rows[0]?.ids||[]));
            ids.tripIds.push(...(discovered.rows[0]?.trips||[]));
            if(ids.scheduleId){
                const occ=await client.query("SELECT booking_id,trip_id FROM recurring_booking_occurrence WHERE schedule_id=$1",[ids.scheduleId]);
                ids.bookingIds.push(...occ.rows.map(row=>row.booking_id).filter(Boolean));
                ids.tripIds.push(...occ.rows.map(row=>row.trip_id).filter(Boolean));
                await client.query("DELETE FROM drt_engine_event WHERE details->>'scheduleId'=$1",[ids.scheduleId]);
                await client.query("DELETE FROM recurring_booking_occurrence WHERE schedule_id=$1",[ids.scheduleId]);
                await client.query("DELETE FROM recurring_booking_schedule WHERE schedule_id=$1",[ids.scheduleId]);
            }
            ids.bookingIds=[...new Set(ids.bookingIds)];
            ids.tripIds=[...new Set(ids.tripIds)];
            if(ids.tripIds.length){
                await client.query("DELETE FROM drt_engine_event WHERE trip_id=ANY($1::uuid[]) OR booking_id=ANY($2::uuid[])",[ids.tripIds,ids.bookingIds]);
                await client.query("DELETE FROM trip_stop_sequence WHERE trip_id=ANY($1::uuid[])",[ids.tripIds]);
                await client.query("DELETE FROM driver_telemetry WHERE trip_id=ANY($1::uuid[])",[ids.tripIds]);
            }
            if(ids.bookingIds.length)await client.query("DELETE FROM booking WHERE booking_id=ANY($1::uuid[])",[ids.bookingIds]);
            if(ids.tripIds.length)await client.query("DELETE FROM trip WHERE trip_id=ANY($1::uuid[])",[ids.tripIds]);
            if(ids.driverId){await client.query("DELETE FROM vehicle WHERE vehicle_id=$1",[ids.vehicleId]);await client.query("DELETE FROM driver WHERE driver_id=$1",[ids.driverId]);}
            if(ids.pointId)await client.query("DELETE FROM service_point WHERE point_id=$1",[ids.pointId]);
            if(ids.zoneId)await client.query("DELETE FROM service_zone WHERE zone_id=$1",[ids.zoneId]);
            if(ids.stationId)await client.query("DELETE FROM metro_station WHERE station_id=$1",[ids.stationId]);
            if(ids.userId)await client.query("DELETE FROM users WHERE user_id=$1",[ids.userId]);
            await client.query("COMMIT");
        }catch(error){await client.query("ROLLBACK");throw error;}
        finally{client.release();}
    }

    try{
        await app.ready();
        const geo=(await pool.query(`WITH p AS(SELECT ST_SetSRID(ST_MakePoint(80.2000,13.0800),4326) AS geom)
          INSERT INTO metro_station(station_name,station_coords,service_boundary_polygon,service_area_polygon,
            station_geofence_radius_m,service_area_source,station_geofence_source,is_active)
          SELECT $1,geom,ST_Buffer(geom::geography,500)::geometry(Polygon,4326),
            ST_Buffer(geom::geography,10000)::geometry(Polygon,4326),500,'INTEGRATION_TEST','CONFIGURED_APPROXIMATE_GEOFENCE',TRUE
          FROM p RETURNING station_id`,[`Codex integration ${tag}`])).rows[0];
        ids.stationId=geo.station_id;
        const zone=(await pool.query(`WITH p AS(SELECT ST_SetSRID(ST_MakePoint(80.2100,13.0800),4326) AS geom)
          INSERT INTO service_zone(station_id,zone_name,zone_type,boundary_polygon,center_coords,service_radius_km,
            boundary_source,center_source,is_active)
          SELECT $1,$2,'RESIDENTIAL',ST_Buffer(geom::geography,1500)::geometry(Polygon,4326),geom,1.5,'INTEGRATION_TEST','INTEGRATION_TEST',TRUE
          FROM p RETURNING zone_id`,[ids.stationId,`Codex zone ${tag}`])).rows[0];
        ids.zoneId=zone.zone_id;
        ids.pointId=(await pool.query(`INSERT INTO service_point(zone_id,point_name,location_coords,road_access_status,
          is_hub_stop,is_active,verification_status,coordinate_source)
          VALUES($1,$2,ST_SetSRID(ST_MakePoint(80.2100,13.0800),4326),'TEST',FALSE,TRUE,'VERIFIED','INTEGRATION_TEST') RETURNING point_id`,
        [ids.zoneId,`Codex point ${tag}`])).rows[0].point_id;

        const passengerPhone=`+91${crypto.randomInt(1000000000,9999999999)}`;
        ids.userId=(await pool.query(`INSERT INTO users(full_name,email,phone_number,password_hash)
          VALUES($1,$2,$3,'integration-test-only') RETURNING user_id`,[`Codex passenger ${tag}`,`codex-${tag}@example.test`,passengerPhone])).rows[0].user_id;
        const driver=(await pool.query(`INSERT INTO driver(full_name,email,phone_number,password_hash,driving_license_no,
          active_zone_id,current_service_mode,shift_status,is_online,current_location,location_recorded_at,location_accuracy_m)
          VALUES($1,$2,$3,'integration-test-only',$4,$5,'M2R','AVAILABLE',TRUE,
            ST_SetSRID(ST_MakePoint(80.2000,13.0800),4326),clock_timestamp(),5) RETURNING driver_id`,
        [`Codex driver ${tag}`,`driver-${tag}@example.test`,`+91${crypto.randomInt(1000000000,9999999999)}`,`TEST-${tag}`,ids.zoneId])).rows[0];
        ids.driverId=driver.driver_id;
        const vehicleRegistration=`CI${tag.replaceAll("-","").slice(0,18)}`;
        ids.vehicleId=(await pool.query(`INSERT INTO vehicle(driver_id,registration_no,max_capacity,is_active,is_frozen_until)
          VALUES($1,$2,2,TRUE,FALSE) RETURNING vehicle_id`,[ids.driverId,vehicleRegistration])).rows[0].vehicle_id;

        const token=generateToken({id:ids.userId,email:`codex-${tag}@example.test`,role:"PASSENGER"});
        const headers={authorization:`Bearer ${token}`};
        const journey={direction:"RESIDENTIAL_TO_METRO",stationId:ids.stationId,zoneId:ids.zoneId,
          servicePointId:ids.pointId,seatsRequested:1,bookingIntent:"BOOKING",dailyDepartureTime:"23:59",
          originLocationSource:"MANUAL",latitude:null,longitude:null,pickupAcknowledged:false};

        const preview=await app.inject({method:"POST",url:"/api/bookings/fare-preview",headers,payload:journey});
        assert.equal(preview.statusCode,200,preview.body);
        const noGpsPreview=await app.inject({method:"POST",url:"/api/bookings/fare-preview",headers,
          payload:{...journey,bookingIntent:"DIRECT",originLocationSource:"GPS",latitude:0,longitude:0}});
        assert.equal(noGpsPreview.statusCode,422,"GPS outside the fixture station should be rejected");
        const manualPreview=await app.inject({method:"POST",url:"/api/bookings/fare-preview",headers,
          payload:{...journey,bookingIntent:"DIRECT",originLocationSource:"MANUAL",latitude:null,longitude:null}});
        assert.equal(manualPreview.statusCode,200,manualPreview.body);

        const scheduled=await app.inject({method:"POST",url:"/api/bookings/schedules",headers:{...headers,"Idempotency-Key":`schedule-${tag}`},
          payload:{...journey,quoteToken:preview.json().quoteToken}});
        assert.equal(scheduled.statusCode,201,scheduled.body);
        ids.scheduleId=scheduled.json().schedule.schedule_id;
        const before=await pool.query("SELECT COUNT(*)::int AS count FROM booking WHERE user_id=$1",[ids.userId]);
        assert.equal(before.rows[0].count,0,"saving a recurring schedule must not make a trip/booking occurrence immediately");

        await pool.query(`UPDATE recurring_booking_schedule SET next_service_date=(clock_timestamp() AT TIME ZONE timezone)::date,
          next_departure_at=clock_timestamp()-interval '2 seconds' WHERE schedule_id=$1`,[ids.scheduleId]);
        const materialized=await materializeOneDueSchedule(pool,ids.scheduleId);
        assert.equal(materialized.outcome,"SCHEDULE_MATERIALIZED");
        const occurrence=(await pool.query(`SELECT o.*,b.booking_status,t.trip_status FROM recurring_booking_occurrence o
          JOIN booking b ON b.booking_id=o.booking_id JOIN trip t ON t.trip_id=o.trip_id WHERE o.schedule_id=$1`,[ids.scheduleId])).rows[0];
        assert.ok(occurrence);
        assert.equal(occurrence.booking_status,"REQUESTED");
        ids.bookingIds.push(occurrence.booking_id);ids.tripIds.push(occurrence.trip_id);

        await pool.query(`UPDATE trip SET dispatch_deadline=clock_timestamp()-interval '1 second',
          dispatch_policy=jsonb_set(dispatch_policy,'{minimumDispatchPassengers}','1'::jsonb,TRUE) WHERE trip_id=$1`,[occurrence.trip_id]);
        const mismatch=await dispatchOne(pool,occurrence.trip_id);
        assert.equal(mismatch.outcome,"NO_DRIVER","wrong driver direction must not be assigned");
        await pool.query(`UPDATE driver SET current_service_mode='R2M',location_accuracy_m=5,
          location_recorded_at=clock_timestamp(),shift_status='AVAILABLE',is_online=TRUE WHERE driver_id=$1`,[ids.driverId]);
        await pool.query("UPDATE trip SET dispatch_deadline=clock_timestamp()-interval '1 second' WHERE trip_id=$1",[occurrence.trip_id]);
        const [firstAttempt,secondAttempt]=await Promise.all([dispatchOne(pool,occurrence.trip_id),dispatchOne(pool,occurrence.trip_id)]);
        assert.ok([firstAttempt.outcome,secondAttempt.outcome].includes("DISPATCHED"),JSON.stringify({attempts:[firstAttempt,secondAttempt],state:(await pool.query(`SELECT t.trip_status,t.trip_direction,t.dispatch_deadline,t.dispatch_policy->>'maximumVehicleCapacity' AS cap,d.current_service_mode,d.shift_status,d.is_online,d.location_accuracy_m,d.location_recorded_at,v.max_capacity FROM trip t CROSS JOIN driver d JOIN vehicle v ON v.driver_id=d.driver_id WHERE t.trip_id=$1 AND d.driver_id=$2`,[occurrence.trip_id,ids.driverId])).rows[0]}));
        const assigned=(await pool.query(`SELECT t.driver_id,t.vehicle_id,t.trip_status,b.booking_status,d.full_name AS driver_name,
          v.registration_no FROM trip t JOIN booking b ON b.trip_id=t.trip_id JOIN driver d ON d.driver_id=t.driver_id
          JOIN vehicle v ON v.vehicle_id=t.vehicle_id WHERE t.trip_id=$1`,[occurrence.trip_id])).rows[0];
        assert.equal(assigned.driver_id,ids.driverId);
        assert.equal(assigned.vehicle_id,ids.vehicleId);
        assert.equal(assigned.trip_status,"DISPATCHED");
        assert.equal(assigned.booking_status,"ASSIGNED");
        assert.ok(assigned.driver_name&&assigned.registration_no);

        const schedules=await app.inject({method:"GET",url:"/api/bookings/schedules",headers});
        assert.equal(schedules.statusCode,200);
        assert.equal(schedules.json().schedules[0].occurrences[0].tripStatus,"DISPATCHED");
        assert.equal(schedules.json().schedules[0].occurrences[0].driverName,assigned.driver_name);

        await pool.query("UPDATE booking SET booking_status='COMPLETED',completed_at=clock_timestamp() WHERE booking_id=$1",[occurrence.booking_id]);
        await pool.query("UPDATE trip SET trip_status='COMPLETED',completed_at=clock_timestamp() WHERE trip_id=$1",[occurrence.trip_id]);
        await pool.query("UPDATE driver SET shift_status='AVAILABLE' WHERE driver_id=$1",[ids.driverId]);
        const directInput={...journey,bookingIntent:"DIRECT",dailyDepartureTime:undefined,originLocationSource:"MANUAL",latitude:0,longitude:0};
        let directPreview=await app.inject({method:"POST",url:"/api/bookings/fare-preview",headers,payload:directInput});
        assert.equal(directPreview.statusCode,200,directPreview.body);
        await pool.query("UPDATE driver SET current_service_mode='M2R' WHERE driver_id=$1",[ids.driverId]);
        const wrongQuote=(await app.inject({method:"POST",url:"/api/bookings/fare-preview",headers,payload:{...directInput,seatsRequested:1}})).json();
        const wrongMode=await app.inject({method:"POST",url:"/api/bookings",headers:{...headers,"Idempotency-Key":`wrong-mode-${tag}`},
          payload:{...directInput,seatsRequested:1,quoteToken:wrongQuote.quoteToken}});
        assert.equal(wrongMode.statusCode,409,"wrong-direction driver must not be assigned to Direct Booking");
        const {drtStopArrivalRadiusM}=require("../src/config/env");
        await pool.query("UPDATE driver SET current_service_mode='R2M',location_accuracy_m=$2 WHERE driver_id=$1",[ids.driverId,drtStopArrivalRadiusM+1]);
        const inaccurateQuote=(await app.inject({method:"POST",url:"/api/bookings/fare-preview",headers,payload:{...directInput,seatsRequested:1}})).json();
        const inaccurate=await app.inject({method:"POST",url:"/api/bookings",headers:{...headers,"Idempotency-Key":`inaccurate-${tag}`},payload:{...directInput,seatsRequested:1,quoteToken:inaccurateQuote.quoteToken}});
        assert.equal(inaccurate.statusCode,409,"inaccurate driver location must not be assigned");
        await pool.query("UPDATE driver SET location_accuracy_m=5,location_recorded_at=clock_timestamp()-interval '5 minutes' WHERE driver_id=$1",[ids.driverId]);
        const staleQuote=(await app.inject({method:"POST",url:"/api/bookings/fare-preview",headers,payload:{...directInput,seatsRequested:1}})).json();
        const stale=await app.inject({method:"POST",url:"/api/bookings",headers:{...headers,"Idempotency-Key":`stale-${tag}`},payload:{...directInput,seatsRequested:1,quoteToken:staleQuote.quoteToken}});
        assert.equal(stale.statusCode,409,"stale driver location must not be assigned");
        await pool.query("UPDATE driver SET location_recorded_at=clock_timestamp() WHERE driver_id=$1",[ids.driverId]);
        const goodQuoteResponse=await app.inject({method:"POST",url:"/api/bookings/fare-preview",headers,payload:{...directInput,seatsRequested:2}});
        assert.equal(goodQuoteResponse.statusCode,200,goodQuoteResponse.body);
        const goodQuote=goodQuoteResponse.json();
        const overCapacity=await app.inject({method:"POST",url:"/api/bookings",headers,payload:{...directInput,seatsRequested:3,
          quoteToken:(await app.inject({method:"POST",url:"/api/bookings/fare-preview",headers,payload:{...directInput,seatsRequested:3}})).json().quoteToken}});
        assert.equal(overCapacity.statusCode,409,"vehicle capacity must be enforced for Direct Booking");
        const direct=await app.inject({method:"POST",url:"/api/bookings",headers:{...headers,"Idempotency-Key":`direct-${tag}`},payload:{...directInput,seatsRequested:2,
          quoteToken:goodQuote.quoteToken}});
        assert.equal(direct.statusCode,201,direct.body);
        assert.equal(direct.json().booking.booking_status,"ASSIGNED");
        assert.equal(direct.json().booking.trip_status,"DISPATCHED");
        assert.equal(direct.json().booking.driver_id,ids.driverId);
        assert.equal(direct.json().booking.vehicle_id,ids.vehicleId);
        const persistedOrigin=await pool.query("SELECT origin_location IS NULL AS is_null,origin_location_source FROM booking WHERE booking_id=$1",[direct.json().booking.booking_id]);
        assert.equal(persistedOrigin.rows[0].is_null,true,"manual location must discard stale GPS coordinates");
        assert.equal(persistedOrigin.rows[0].origin_location_source,"MANUAL");
        const directStops=await pool.query("SELECT COUNT(*)::int AS count FROM trip_stop_sequence WHERE trip_id=$1",[direct.json().booking.trip_id]);
        assert.equal(directStops.rows[0].count,2);
        ids.bookingIds.push(direct.json().booking.booking_id);ids.tripIds.push(direct.json().booking.trip_id);

        const cancelled=await app.inject({method:"POST",url:`/api/bookings/schedules/${ids.scheduleId}/cancel`,headers});
        assert.equal(cancelled.statusCode,200);
        assert.equal(cancelled.json().schedule.schedule_status,"CANCELLED");
        const history=await pool.query("SELECT COUNT(*)::int AS count FROM recurring_booking_occurrence WHERE schedule_id=$1",[ids.scheduleId]);
        assert.equal(history.rows[0].count,1,"cancelling a schedule must preserve generated occurrence history");
        assert.equal(await materializeOneDueSchedule(pool,ids.scheduleId).then(result=>result.processed),false,
          "a cancelled schedule must not generate another occurrence");
    }finally{
        await app.close().catch(()=>{});
        try{await cleanup();}finally{await pool.end();}
    }
});
