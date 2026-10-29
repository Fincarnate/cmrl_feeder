const pool = require("../../../db/pool");
const { assertTransition } = require("../services/bookingStates");

const ACTIVE_BOOKING_STATES = "('REQUESTED','ASSIGNED','BOARDING','IN_PROGRESS')";
// Never return OTP hashes, idempotency keys, or internal delivery metadata to clients.
const PASSENGER_BOOKING_COLUMNS = `b.booking_id,b.trip_id,b.start_point_id,b.group_point_id,b.seats_reserved,
  b.fare_amount,b.final_fare,b.booking_status,b.direction,b.station_id,b.zone_id,b.service_point_id,
  b.fare_breakdown,b.fare_policy_version,b.distance_km,b.distance_source,b.fare_currency,
  b.requested_at,b.driver_arrived_at,b.boarding_deadline,b.boarding_policy,b.boarded_at,b.completed_at,b.cancelled_at,b.booking_intent`;

async function getServiceAreas() {
    const { rows } = await pool.query(`
      SELECT ms.station_id, ms.station_name, ST_AsGeoJSON(ms.station_coords)::json AS station_geometry,
             ST_AsGeoJSON(ms.service_boundary_polygon)::json AS station_boundary,
             ST_AsGeoJSON(ms.service_area_polygon)::json AS station_service_area,
             ms.service_radius_km AS station_service_radius_km,ms.station_geofence_radius_m,
             ms.station_geofence_source,ms.service_area_source,ms.station_center_source,
             sz.zone_id, sz.zone_name, ST_AsGeoJSON(sz.boundary_polygon)::json AS zone_boundary,
             ST_AsGeoJSON(sz.center_coords)::json AS zone_center,sz.service_radius_km AS zone_radius_km,
             sz.boundary_source AS zone_boundary_source,
             EXISTS(SELECT 1 FROM service_zone other WHERE other.station_id=sz.station_id AND other.zone_id<>sz.zone_id
               AND other.is_active AND ST_Overlaps(other.boundary_polygon,sz.boundary_polygon)) AS zone_overlaps,
             sp.point_id, sp.point_name, ST_AsGeoJSON(sp.location_coords)::json AS point_geometry,
             sp.verification_status AS point_verification_status,sp.coordinate_source AS point_coordinate_source,
             sp.is_active AS point_is_active,
             COALESCE(sp.is_active=TRUE AND sp.verification_status='VERIFIED' AND sp.location_coords IS NOT NULL
               AND ST_Covers(sz.boundary_polygon,sp.location_coords),FALSE) AS is_bookable
      FROM metro_station ms JOIN service_zone sz ON sz.station_id=ms.station_id
      LEFT JOIN service_point sp ON sp.zone_id=sz.zone_id
      WHERE ms.is_active=TRUE AND sz.is_active=TRUE
        AND ms.station_coords IS NOT NULL AND ms.service_area_polygon IS NOT NULL
        AND sz.boundary_polygon IS NOT NULL AND sz.center_coords IS NOT NULL
        AND ST_IsValid(ms.service_area_polygon) AND ST_IsValid(sz.boundary_polygon)
        AND ST_Covers(ms.service_area_polygon,sz.center_coords)
      ORDER BY ms.station_name, sz.zone_name, sp.point_name
    `);
    return rows;
}

async function getJourneyContext(client, { stationId, zoneId, servicePointId }) {
    const { rows } = await client.query(`
      SELECT ms.station_id, ms.station_name, ST_AsGeoJSON(ms.station_coords)::json AS station_geometry,
             sp.point_id, sp.point_name, ST_AsGeoJSON(sp.location_coords)::json AS point_geometry, sz.zone_id, sz.zone_name,
             sp.verification_status,sp.coordinate_source
      FROM metro_station ms
      JOIN service_zone sz ON sz.station_id=ms.station_id AND sz.zone_id=$2
      JOIN service_point sp ON sp.zone_id=sz.zone_id AND sp.point_id=$3
      WHERE ms.station_id=$1 AND ms.is_active=TRUE AND sz.is_active=TRUE AND sp.is_active=TRUE
        AND sp.verification_status='VERIFIED'
        AND ms.station_coords IS NOT NULL AND ms.service_area_polygon IS NOT NULL
        AND sz.boundary_polygon IS NOT NULL AND sp.location_coords IS NOT NULL
        AND ST_IsValid(ms.service_area_polygon) AND ST_IsValid(sz.boundary_polygon)
        AND ST_Covers(ms.service_area_polygon,sz.center_coords)
        AND ST_Covers(sz.boundary_polygon, sp.location_coords)
      LIMIT 1
    `, [stationId, zoneId, servicePointId]);
    return rows[0] || null;
}

async function resolvePassengerLocation(client, { direction, latitude, longitude }) {
    const coordinate = [longitude, latitude];
    if (direction === "RESIDENTIAL_TO_METRO") {
        const { rows } = await client.query(`
          WITH location AS (SELECT ST_SetSRID(ST_MakePoint($1,$2),4326) AS geom),
          eligible AS (
            SELECT ms.station_id,ms.station_name,ST_AsGeoJSON(ms.station_coords)::json AS station_geometry,
              ST_AsGeoJSON(ms.service_boundary_polygon)::json AS station_boundary,
              ST_AsGeoJSON(ms.service_area_polygon)::json AS station_service_area,
              sz.zone_id,sz.zone_name,ST_AsGeoJSON(sz.boundary_polygon)::json AS zone_boundary,
              sp.point_id,sp.point_name,ST_AsGeoJSON(sp.location_coords)::json AS point_geometry,
              ST_Covers(sz.boundary_polygon,location.geom) AS inside_zone,
              ST_Distance(sz.boundary_polygon::geography,location.geom::geography) AS zone_distance,
              ST_Distance(sp.location_coords::geography,location.geom::geography) AS point_distance
            FROM location CROSS JOIN service_zone sz
            JOIN metro_station ms ON ms.station_id=sz.station_id
            JOIN service_point sp ON sp.zone_id=sz.zone_id
            WHERE ms.is_active=TRUE AND sz.is_active=TRUE AND sp.is_active=TRUE
              AND ms.station_coords IS NOT NULL AND ms.service_area_polygon IS NOT NULL
              AND sz.boundary_polygon IS NOT NULL AND sp.location_coords IS NOT NULL
              AND sp.verification_status='VERIFIED'
              AND ST_IsValid(ms.service_area_polygon) AND ST_IsValid(sz.boundary_polygon)
              AND sz.center_coords IS NOT NULL AND ST_Covers(ms.service_area_polygon,sz.center_coords)
              AND ST_Covers(sz.boundary_polygon,sp.location_coords)
          )
          SELECT * FROM eligible
          ORDER BY inside_zone DESC, zone_distance ASC, point_distance ASC, zone_id,point_id LIMIT 1
        `, coordinate);
        const match = rows[0];
        if (!match) return { result: "UNAVAILABLE" };
        let containingZones = [];
        if (match.inside_zone) {
            const contained = await client.query(`
              WITH location AS (SELECT ST_SetSRID(ST_MakePoint($1,$2),4326) AS geom)
              SELECT sz.zone_id,sz.zone_name,ms.station_id,ms.station_name,sp.point_id,sp.point_name,
                ST_Distance(sp.location_coords::geography,location.geom::geography) AS point_distance
              FROM location JOIN service_zone sz ON sz.is_active=TRUE AND sz.boundary_polygon IS NOT NULL
              JOIN metro_station ms ON ms.station_id=sz.station_id AND ms.is_active=TRUE
              JOIN LATERAL (SELECT p.point_id,p.point_name,p.location_coords FROM service_point p
                WHERE p.zone_id=sz.zone_id AND p.is_active=TRUE AND p.verification_status='VERIFIED'
                  AND p.location_coords IS NOT NULL AND ST_Covers(sz.boundary_polygon,p.location_coords)
                ORDER BY ST_Distance(p.location_coords::geography,location.geom::geography),p.point_id LIMIT 1) sp ON TRUE
              WHERE ST_IsValid(sz.boundary_polygon) AND ST_Covers(sz.boundary_polygon,location.geom)
                AND sz.center_coords IS NOT NULL AND ms.service_area_polygon IS NOT NULL
                AND ST_Covers(ms.service_area_polygon,sz.center_coords)
              ORDER BY point_distance,sz.zone_name,sz.zone_id
            `, coordinate);
            containingZones = contained.rows;
        }
        return { result: match.inside_zone ? "IN_ZONE" : "NEARBY_RECOMMENDATION", ...match,
          containingZones, distanceMeters: Math.round(Number(match.zone_distance)), pointDistanceMeters: Math.round(Number(match.point_distance)) };
    }
    const { rows } = await client.query(`
      WITH location AS (SELECT ST_SetSRID(ST_MakePoint($1,$2),4326) AS geom)
      SELECT ms.station_id,ms.station_name,ST_AsGeoJSON(ms.station_coords)::json AS station_geometry,
        ST_AsGeoJSON(ms.service_boundary_polygon)::json AS station_boundary,
        ST_Distance(ms.service_boundary_polygon::geography,location.geom::geography) AS boundary_distance
      FROM location CROSS JOIN metro_station ms
      WHERE ms.is_active=TRUE AND ms.station_coords IS NOT NULL AND ms.service_boundary_polygon IS NOT NULL
        AND ms.service_area_polygon IS NOT NULL AND ms.station_geofence_source IN ('VERIFIED','OFFICIAL','CONFIGURED_APPROXIMATE_GEOFENCE')
        AND ST_IsValid(ms.service_boundary_polygon) AND ST_Covers(ms.service_boundary_polygon,location.geom)
        AND EXISTS(SELECT 1 FROM service_zone sz JOIN service_point sp ON sp.zone_id=sz.zone_id
          WHERE sz.station_id=ms.station_id AND sz.is_active AND sp.is_active AND sp.verification_status='VERIFIED'
            AND sz.boundary_polygon IS NOT NULL AND sp.location_coords IS NOT NULL AND ST_IsValid(sz.boundary_polygon)
            AND sz.center_coords IS NOT NULL AND ST_Covers(ms.service_area_polygon,sz.center_coords)
            AND ST_Covers(sz.boundary_polygon,sp.location_coords))
      ORDER BY ms.station_id
    `, coordinate);
    return rows.length ? { result: "AT_SUPPORTED_STATION", stations: rows } : { result: "OUTSIDE_STATION" };
}

async function findIdempotentBooking(client, userId, key) {
    if (!key) return null;
    const { rows } = await client.query(`SELECT ${PASSENGER_BOOKING_COLUMNS},t.trip_status,t.driver_id,t.vehicle_id,t.dispatch_deadline,
      d.full_name AS driver_name,v.registration_no FROM booking b LEFT JOIN trip t ON t.trip_id=b.trip_id
      LEFT JOIN driver d ON d.driver_id=t.driver_id LEFT JOIN vehicle v ON v.vehicle_id=t.vehicle_id
      WHERE b.user_id=$1 AND b.idempotency_key=$2 LIMIT 1`, [userId, key]);
    return rows[0] || null;
}

async function getOrCreateWaitingTrip(client, { direction, stationId, zoneId, seats, policySnapshot, maxCapacity, syntheticDemo=false }) {
    const lockKey = `drt:${direction}:${stationId}:${zoneId}`;
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);
    const { rows: trips } = await client.query(`
      SELECT trip_id, dispatch_policy, dispatch_deadline FROM trip
      WHERE trip_direction=$1 AND station_id=$2 AND zone_id=$3 AND trip_status='WAITING_FOR_PASSENGERS'
        AND NOT EXISTS(SELECT 1 FROM booking b JOIN users u ON u.user_id=b.user_id
          WHERE b.trip_id=trip.trip_id AND UPPER(b.booking_status) IN ${ACTIVE_BOOKING_STATES}
            AND (COALESCE(u.is_demo,FALSE) AND COALESCE(b.idempotency_key LIKE 'demo-ghost:%',FALSE)) IS DISTINCT FROM $4::boolean)
      ORDER BY dispatch_started_at ASC LIMIT 1 FOR UPDATE
    `, [direction, stationId, zoneId, Boolean(syntheticDemo)]);
    if (trips[0]) {
        const used = await client.query(`SELECT COALESCE(SUM(seats_reserved),0)::int AS seats FROM booking WHERE trip_id=$1 AND UPPER(booking_status) IN ${ACTIVE_BOOKING_STATES}`, [trips[0].trip_id]);
        if (Number(used.rows[0].seats) + seats <= maxCapacity) return { tripId: trips[0].trip_id, created: false };
    }
    const trip = await client.query(`
      INSERT INTO trip(zone_id, station_id, trip_direction, trip_status, dispatch_started_at, dispatch_deadline, dispatch_policy, available_seats)
      VALUES($1,$2,$3,'WAITING_FOR_PASSENGERS',clock_timestamp(),clock_timestamp()+($4::int * interval '1 minute'),$5::jsonb,$6)
      RETURNING trip_id
    `, [zoneId, stationId, direction, policySnapshot.dispatchWaitMinutes, JSON.stringify(policySnapshot), maxCapacity]);
    return { tripId: trip.rows[0].trip_id, created: true };
}

async function insertBooking(client, input) {
    const { rows } = await client.query(`
      INSERT INTO booking(user_id, trip_id, start_point_id, group_point_id, seats_reserved,
        fare_amount, booking_status, direction, station_id, zone_id, service_point_id,
        fare_breakdown, fare_policy_version, distance_km, distance_source, fare_currency, idempotency_key, booking_intent,
        origin_location,origin_location_source,gps_verified_at,pickup_acknowledged)
      VALUES($1,$2,$3,$3,$4,$5,'REQUESTED',$6,$7,$8,$3,$9::jsonb,$10,$11,$12,$13,$14,$15,
        CASE WHEN $16::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($16,$17),4326) END,$18,
        CASE WHEN $18::varchar='GPS' THEN clock_timestamp() ELSE NULL END,$19)
      RETURNING booking_id,trip_id,start_point_id,group_point_id,seats_reserved,fare_amount,booking_status,
        direction,station_id,zone_id,service_point_id,fare_breakdown,fare_policy_version,distance_km,
        distance_source,fare_currency,requested_at
    `, [input.userId,input.tripId,input.servicePointId,input.seats,input.fare.fare,input.direction,input.stationId,input.zoneId,
        JSON.stringify(input.fare.breakdown),input.fare.policyVersion,input.fare.distanceKm,input.fare.distanceSource,input.fare.currency,input.idempotencyKey || null,input.bookingIntent || "BOOKING",
        input.longitude ?? null,input.latitude ?? null,input.originLocationSource || "MANUAL",Boolean(input.pickupAcknowledged)]);
    await refreshAvailableSeats(client, input.tripId);
    return rows[0];
}

async function refreshAvailableSeats(client, tripId) {
    await client.query(`UPDATE trip t SET available_seats=GREATEST(0,
      COALESCE(t.seat_capacity,NULLIF((t.dispatch_policy->>'maximumVehicleCapacity')::int,0),t.available_seats,0)-
      COALESCE((SELECT SUM(b.seats_reserved) FROM booking b WHERE b.trip_id=t.trip_id AND UPPER(b.booking_status) IN ${ACTIVE_BOOKING_STATES}),0))
      WHERE t.trip_id=$1`, [tripId]);
}

async function listMyBookings(userId) {
    const { rows } = await pool.query(`SELECT ${PASSENGER_BOOKING_COLUMNS},t.trip_status,t.driver_id,t.vehicle_id,t.dispatch_deadline,
      d.full_name AS driver_name, v.registration_no
      FROM booking b LEFT JOIN trip t ON t.trip_id=b.trip_id
      LEFT JOIN driver d ON d.driver_id=t.driver_id LEFT JOIN vehicle v ON v.vehicle_id=t.vehicle_id
      WHERE b.user_id=$1 ORDER BY b.requested_at DESC`, [userId]);
    return rows;
}

async function getMyBooking(userId, bookingId) {
    const { rows } = await pool.query(`SELECT ${PASSENGER_BOOKING_COLUMNS},t.trip_status,t.driver_id,t.vehicle_id,t.dispatch_deadline,
      d.full_name AS driver_name,v.registration_no
      FROM booking b LEFT JOIN trip t ON t.trip_id=b.trip_id
      LEFT JOIN driver d ON d.driver_id=t.driver_id LEFT JOIN vehicle v ON v.vehicle_id=t.vehicle_id
      WHERE b.user_id=$1 AND b.booking_id=$2`, [userId, bookingId]);
    return rows[0] || null;
}

async function cancelMyBooking(userId, bookingId) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const { rows } = await client.query("SELECT * FROM booking WHERE user_id=$1 AND booking_id=$2 FOR UPDATE", [userId, bookingId]);
        const booking = rows[0];
        if (!booking) { await client.query("ROLLBACK"); return null; }
        if (!["REQUESTED","ASSIGNED"].includes(String(booking.booking_status).toUpperCase())) {
            throw Object.assign(new Error("This booking can no longer be cancelled."), { statusCode: 409 });
        }
        assertTransition(String(booking.booking_status).toUpperCase(), "CANCELLED");
        await client.query("UPDATE booking SET booking_status='CANCELLED',cancelled_at=clock_timestamp(),otp_hash=NULL WHERE booking_id=$1", [bookingId]);
        await refreshAvailableSeats(client, booking.trip_id);
        const remainingAtPoint = await client.query(`SELECT 1 FROM booking WHERE trip_id=$1 AND service_point_id=$2
          AND UPPER(booking_status) IN ${ACTIVE_BOOKING_STATES} LIMIT 1`, [booking.trip_id,booking.service_point_id]);
        if (!remainingAtPoint.rows[0]) await client.query(`UPDATE trip_stop_sequence SET completed_at=clock_timestamp(),stop_status='SKIPPED'
          WHERE trip_id=$1 AND point_id=$2 AND stop_type='SERVICE_POINT' AND arrived_at IS NULL
            AND EXISTS(SELECT 1 FROM trip t WHERE t.trip_id=trip_stop_sequence.trip_id AND t.trip_direction='METRO_TO_RESIDENTIAL')`, [booking.trip_id,booking.service_point_id]);
        const remaining = await client.query(`SELECT COUNT(*)::int AS count FROM booking WHERE trip_id=$1 AND UPPER(booking_status) IN ${ACTIVE_BOOKING_STATES}`, [booking.trip_id]);
        if (Number(remaining.rows[0].count) === 0) {
            await client.query("UPDATE trip SET trip_status='CANCELLED',updated_at=clock_timestamp() WHERE trip_id=$1 AND trip_status IN ('WAITING_FOR_PASSENGERS','READY_TO_DISPATCH','DISPATCHED')", [booking.trip_id]);
            await client.query("UPDATE trip_stop_sequence SET completed_at=COALESCE(completed_at,clock_timestamp()),stop_status='SKIPPED' WHERE trip_id=$1 AND completed_at IS NULL", [booking.trip_id]);
            await client.query("UPDATE driver SET shift_status=CASE WHEN is_online THEN 'AVAILABLE' ELSE 'OFFLINE' END WHERE driver_id=(SELECT driver_id FROM trip WHERE trip_id=$1)", [booking.trip_id]);
        }
        await client.query("INSERT INTO drt_engine_event(event_type,trip_id,booking_id,actor_role) VALUES('BOOKING_CANCELLED',$1,$2,'PASSENGER')", [booking.trip_id,bookingId]);
        await client.query("COMMIT");
        return getMyBooking(userId, bookingId);
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
}

module.exports = { getServiceAreas, getJourneyContext, resolvePassengerLocation, findIdempotentBooking, getOrCreateWaitingTrip, insertBooking, listMyBookings, getMyBooking, cancelMyBooking };
