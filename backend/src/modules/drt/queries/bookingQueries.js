const pool = require("../../../db/pool");
const { assertTransition } = require("../services/bookingStates");

const ACTIVE_BOOKING_STATES = "('REQUESTED','ASSIGNED','BOARDING','IN_PROGRESS')";
// Never return OTP hashes, idempotency keys, or internal delivery metadata to clients.
const PASSENGER_BOOKING_COLUMNS = `b.booking_id,b.trip_id,b.start_point_id,b.group_point_id,b.seats_reserved,
  b.fare_amount,b.final_fare,b.booking_status,b.direction,b.station_id,b.zone_id,b.service_point_id,
  b.fare_breakdown,b.fare_policy_version,b.distance_km,b.distance_source,b.fare_currency,
  b.requested_at,b.driver_arrived_at,b.boarding_deadline,b.boarding_policy,b.boarded_at,b.completed_at,b.cancelled_at`;

async function getServiceAreas() {
    const { rows } = await pool.query(`
      SELECT ms.station_id, ms.station_name, ST_AsGeoJSON(ms.station_coords)::json AS station_geometry,
             ST_AsGeoJSON(ms.service_boundary_polygon)::json AS station_boundary,
             sz.zone_id, sz.zone_name, ST_AsGeoJSON(sz.boundary_polygon)::json AS zone_boundary,
             sp.point_id, sp.point_name, ST_AsGeoJSON(sp.location_coords)::json AS point_geometry
      FROM metro_station ms JOIN service_zone sz ON sz.station_id=ms.station_id
      JOIN service_point sp ON sp.zone_id=sz.zone_id
      WHERE ms.is_active=TRUE AND sz.is_active=TRUE AND sp.is_active=TRUE
        AND ms.station_coords IS NOT NULL AND ms.service_boundary_polygon IS NOT NULL
        AND sz.boundary_polygon IS NOT NULL AND sp.location_coords IS NOT NULL
        AND ST_Covers(ms.service_boundary_polygon, sz.boundary_polygon)
        AND ST_Covers(sz.boundary_polygon, sp.location_coords)
      ORDER BY ms.station_name, sz.zone_name, sp.point_name
    `);
    return rows;
}

async function getJourneyContext(client, { stationId, zoneId, servicePointId }) {
    const { rows } = await client.query(`
      SELECT ms.station_id, ms.station_name, ST_AsGeoJSON(ms.station_coords)::json AS station_geometry,
             sp.point_id, sp.point_name, ST_AsGeoJSON(sp.location_coords)::json AS point_geometry, sz.zone_id, sz.zone_name
      FROM metro_station ms
      JOIN service_zone sz ON sz.station_id=ms.station_id AND sz.zone_id=$2
      JOIN service_point sp ON sp.zone_id=sz.zone_id AND sp.point_id=$3
      WHERE ms.station_id=$1 AND ms.is_active=TRUE AND sz.is_active=TRUE AND sp.is_active=TRUE
        AND ms.station_coords IS NOT NULL AND ms.service_boundary_polygon IS NOT NULL
        AND sz.boundary_polygon IS NOT NULL AND sp.location_coords IS NOT NULL
        AND ST_Covers(ms.service_boundary_polygon, sz.boundary_polygon)
        AND ST_Covers(sz.boundary_polygon, sp.location_coords)
      LIMIT 1
    `, [stationId, zoneId, servicePointId]);
    return rows[0] || null;
}

async function findIdempotentBooking(client, userId, key) {
    if (!key) return null;
    const { rows } = await client.query(`SELECT ${PASSENGER_BOOKING_COLUMNS} FROM booking b WHERE b.user_id=$1 AND b.idempotency_key=$2 LIMIT 1`, [userId, key]);
    return rows[0] || null;
}

async function getOrCreateWaitingTrip(client, { direction, stationId, zoneId, seats, policySnapshot, maxCapacity }) {
    const lockKey = `drt:${direction}:${stationId}:${zoneId}`;
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);
    const { rows: trips } = await client.query(`
      SELECT trip_id, dispatch_policy, dispatch_deadline FROM trip
      WHERE trip_direction=$1 AND station_id=$2 AND zone_id=$3 AND trip_status='WAITING_FOR_PASSENGERS'
      ORDER BY dispatch_started_at ASC LIMIT 1 FOR UPDATE
    `, [direction, stationId, zoneId]);
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
        fare_breakdown, fare_policy_version, distance_km, distance_source, fare_currency, idempotency_key)
      VALUES($1,$2,$3,$3,$4,$5,'REQUESTED',$6,$7,$8,$3,$9::jsonb,$10,$11,$12,$13,$14)
      RETURNING booking_id,trip_id,start_point_id,group_point_id,seats_reserved,fare_amount,booking_status,
        direction,station_id,zone_id,service_point_id,fare_breakdown,fare_policy_version,distance_km,
        distance_source,fare_currency,requested_at
    `, [input.userId,input.tripId,input.servicePointId,input.seats,input.fare.fare,input.direction,input.stationId,input.zoneId,
        JSON.stringify(input.fare.breakdown),input.fare.policyVersion,input.fare.distanceKm,input.fare.distanceSource,input.fare.currency,input.idempotencyKey || null]);
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
          WHERE trip_id=$1 AND point_id=$2 AND stop_type='SERVICE_POINT' AND arrived_at IS NULL`, [booking.trip_id,booking.service_point_id]);
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

module.exports = { getServiceAreas, getJourneyContext, findIdempotentBooking, getOrCreateWaitingTrip, insertBooking, listMyBookings, getMyBooking, cancelMyBooking };
