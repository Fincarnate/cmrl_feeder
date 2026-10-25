const pool = require("../pool");
const { assertTransition } = require("../../modules/drt/services/bookingStates");

async function createTelemetry(driverId, input) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        if (input.tripId) {
            const trip = await client.query("SELECT trip_id FROM trip WHERE trip_id=$1 AND driver_id=$2 AND trip_status IN ('DISPATCHED','IN_PROGRESS') FOR UPDATE", [input.tripId, driverId]);
            if (!trip.rows[0]) { await client.query("ROLLBACK"); return null; }
        }
        const location = await client.query(`UPDATE driver SET current_location=ST_SetSRID(ST_MakePoint($2,$3),4326),location_recorded_at=clock_timestamp() WHERE driver_id=$1 RETURNING location_recorded_at`, [driverId,input.longitude,input.latitude]);
        if (!location.rows[0]) { await client.query("ROLLBACK"); return null; }
        if (input.tripId) await client.query(`INSERT INTO driver_telemetry(trip_id,current_location,speed_kmph,heading_degrees) VALUES($1,ST_SetSRID(ST_MakePoint($2,$3),4326),$4,$5)`, [input.tripId,input.longitude,input.latitude,input.speedKmph ?? null,input.headingDegrees ?? null]);
        await client.query("COMMIT");
        return { recorded_at: location.rows[0].location_recorded_at };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
}

async function setAvailability(driverId, online) {
    const { rows } = await pool.query(`UPDATE driver SET is_online=$2,shift_status=CASE
        WHEN EXISTS(SELECT 1 FROM trip WHERE driver_id=$1 AND trip_status IN ('DISPATCHED','IN_PROGRESS')) THEN 'BUSY'
        WHEN $2 THEN 'AVAILABLE' ELSE 'OFFLINE' END
        WHERE driver_id=$1 AND ($2=TRUE OR NOT EXISTS(SELECT 1 FROM trip WHERE driver_id=$1 AND trip_status IN ('DISPATCHED','IN_PROGRESS')))
        RETURNING is_online,shift_status`, [driverId,online]);
    return rows[0] || null;
}

async function getAvailability(driverId) {
    const { rows }=await pool.query("SELECT is_online,shift_status,location_recorded_at FROM driver WHERE driver_id=$1",[driverId]);
    return rows[0]||null;
}

async function getAssignedTrips(driverId) {
    const { rows } = await pool.query(`SELECT t.trip_id,t.trip_direction,t.trip_status,t.station_id,ms.station_name,t.dispatch_deadline,t.seat_capacity,
        COALESCE((SELECT SUM(b.seats_reserved) FROM booking b WHERE b.trip_id=t.trip_id AND UPPER(b.booking_status) IN ('ASSIGNED','BOARDING','IN_PROGRESS')),0)::int AS occupied_seats,
        COALESCE((SELECT json_agg(json_build_object('id',s.stop_id,'sequence',s.stop_sequence,'type',s.stop_type,'name',COALESCE(sp.point_name,ms2.station_name),'status',s.stop_status,'arrivedAt',s.arrived_at) ORDER BY s.stop_sequence) FROM trip_stop_sequence s LEFT JOIN service_point sp ON sp.point_id=s.point_id LEFT JOIN metro_station ms2 ON ms2.station_id=s.station_id WHERE s.trip_id=t.trip_id),'[]'::json) AS stops,
        COALESCE((SELECT json_agg(json_build_object('id',b.booking_id,'status',b.booking_status,'seats',b.seats_reserved,'point',sp.point_name,'passengerName',u.full_name,'passengerPhone',u.phone_number) ORDER BY b.requested_at) FROM booking b LEFT JOIN service_point sp ON sp.point_id=b.service_point_id JOIN users u ON u.user_id=b.user_id WHERE b.trip_id=t.trip_id AND UPPER(b.booking_status) IN ('ASSIGNED','BOARDING','IN_PROGRESS')),'[]'::json) AS bookings
        FROM trip t LEFT JOIN metro_station ms ON ms.station_id=t.station_id WHERE t.driver_id=$1 AND t.trip_status IN ('DISPATCHED','IN_PROGRESS') ORDER BY t.dispatched_at`, [driverId]);
    return rows;
}

async function arriveAtStop(driverId, tripId, stopId) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const trip = await client.query("SELECT * FROM trip WHERE trip_id=$1 AND driver_id=$2 AND trip_status IN ('DISPATCHED','IN_PROGRESS') FOR UPDATE", [tripId,driverId]);
        if (!trip.rows[0]) { await client.query("ROLLBACK"); return { error: "TRIP_NOT_FOUND" }; }
        const stop = await client.query("SELECT * FROM trip_stop_sequence WHERE stop_id=$1 AND trip_id=$2 FOR UPDATE", [stopId,tripId]);
        if (!stop.rows[0]) { await client.query("ROLLBACK"); return { error: "STOP_NOT_FOUND" }; }
        if (stop.rows[0].arrived_at) { await client.query("COMMIT"); return { stop:stop.rows[0], bookings:[] }; }
        const earlier = await client.query("SELECT 1 FROM trip_stop_sequence WHERE trip_id=$1 AND stop_sequence<$2 AND completed_at IS NULL LIMIT 1", [tripId,stop.rows[0].stop_sequence]);
        if (earlier.rows[0]) { await client.query("ROLLBACK"); return { error: "STOP_ORDER" }; }
        const fallbackPolicy = (await client.query("SELECT * FROM drt_operating_policy WHERE is_active=TRUE ORDER BY version DESC LIMIT 1")).rows[0];
        const now = (await client.query("SELECT clock_timestamp() AS now")).rows[0].now;
        const snapshot = require("../services/operatingPolicy").snapshotFor(now,fallbackPolicy);
        const isPickup = (trip.rows[0].trip_direction === "METRO_TO_RESIDENTIAL" && stop.rows[0].stop_type === "STATION") ||
            (trip.rows[0].trip_direction === "RESIDENTIAL_TO_METRO" && stop.rows[0].stop_type === "SERVICE_POINT");
        const relevant = stop.rows[0].stop_type === "STATION"
            ? await client.query(`SELECT booking_id FROM booking WHERE trip_id=$1 AND station_id=$2 AND UPPER(booking_status)=$3 FOR UPDATE`, [tripId,stop.rows[0].station_id,isPickup?"ASSIGNED":"IN_PROGRESS"])
            : await client.query(`SELECT booking_id FROM booking WHERE trip_id=$1 AND service_point_id=$2 AND UPPER(booking_status)=$3 FOR UPDATE`, [tripId,stop.rows[0].point_id,isPickup?"ASSIGNED":"IN_PROGRESS"]);
        if (!relevant.rows.length) { await client.query("ROLLBACK"); return { error: "NO_BOOKINGS_AT_STOP" }; }
        await client.query("UPDATE trip_stop_sequence SET arrived_at=COALESCE(arrived_at,clock_timestamp()),stop_status='ARRIVED' WHERE stop_id=$1", [stopId]);
        const results = [];
        for (const booking of (isPickup ? relevant.rows : [])) {
            assertTransition("ASSIGNED", "BOARDING");
            const boardingPolicy = { version:snapshot.version,period:snapshot.period,graceMinutes:snapshot.boardingGraceMinutes,otpValidityMinutes:snapshot.otpValidityMinutes,otpMaxAttempts:snapshot.otpMaxAttempts };
            const updated = await client.query(`UPDATE booking SET booking_status='BOARDING',driver_arrived_at=clock_timestamp(),boarding_deadline=clock_timestamp()+($2::int*interval '1 minute'),boarding_policy=$3::jsonb
                WHERE booking_id=$1 RETURNING booking_id,boarding_deadline`, [booking.booking_id,snapshot.boardingGraceMinutes,JSON.stringify(boardingPolicy)]);
            await client.query("INSERT INTO drt_engine_event(event_type,trip_id,booking_id,actor_role,details) VALUES('DRIVER_ARRIVED',$1,$2,'DRIVER',$3::jsonb)", [tripId,booking.booking_id,JSON.stringify(boardingPolicy)]);
            results.push(updated.rows[0]);
        }
        await client.query("COMMIT");
        return { stop: stop.rows[0], bookings: results };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
}

async function completeStop(driverId, tripId, stopId) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const trip = await client.query("SELECT * FROM trip WHERE trip_id=$1 AND driver_id=$2 AND trip_status='IN_PROGRESS' FOR UPDATE", [tripId,driverId]);
        if (!trip.rows[0]) { await client.query("ROLLBACK"); return { error: "TRIP_NOT_FOUND" }; }
        const stop = await client.query("SELECT * FROM trip_stop_sequence WHERE stop_id=$1 AND trip_id=$2 FOR UPDATE", [stopId,tripId]);
        if (!stop.rows[0] || !stop.rows[0].arrived_at || stop.rows[0].completed_at) { await client.query("ROLLBACK"); return { error: "INVALID_STOP_STATE" }; }
        const pendingPickup = await client.query(`SELECT 1 FROM booking WHERE trip_id=$1 AND UPPER(booking_status) IN ('ASSIGNED','BOARDING') AND
            (($2='RESIDENTIAL_TO_METRO' AND $3='SERVICE_POINT' AND service_point_id=$4) OR ($2='METRO_TO_RESIDENTIAL' AND $3='STATION' AND station_id=$5)) LIMIT 1`,
            [tripId,trip.rows[0].trip_direction,stop.rows[0].stop_type,stop.rows[0].point_id,stop.rows[0].station_id]);
        if (pendingPickup.rows[0]) { await client.query("ROLLBACK"); return { error:"PICKUP_NOT_RESOLVED" }; }
        if (stop.rows[0].stop_type === "SERVICE_POINT" && trip.rows[0].trip_direction === "METRO_TO_RESIDENTIAL") {
            assertTransition("IN_PROGRESS", "COMPLETED");
            await client.query("UPDATE booking SET booking_status='COMPLETED',completed_at=clock_timestamp() WHERE trip_id=$1 AND service_point_id=$2 AND booking_status='IN_PROGRESS'", [tripId,stop.rows[0].point_id]);
        }
        await client.query("UPDATE trip_stop_sequence SET completed_at=clock_timestamp(),stop_status='COMPLETED' WHERE stop_id=$1", [stopId]);
        const remaining = await client.query("SELECT 1 FROM trip_stop_sequence WHERE trip_id=$1 AND completed_at IS NULL LIMIT 1", [tripId]);
        if (!remaining.rows[0]) {
            assertTransition("IN_PROGRESS", "COMPLETED");
            await client.query("UPDATE booking SET booking_status='COMPLETED',completed_at=clock_timestamp() WHERE trip_id=$1 AND booking_status='IN_PROGRESS'", [tripId]);
            await client.query("UPDATE trip SET trip_status='COMPLETED',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE trip_id=$1", [tripId]);
            await client.query("UPDATE driver SET shift_status=CASE WHEN is_online THEN 'AVAILABLE' ELSE 'OFFLINE' END WHERE driver_id=$1", [driverId]);
        }
        await client.query("INSERT INTO drt_engine_event(event_type,trip_id,actor_role,details) VALUES('STOP_COMPLETED',$1,'DRIVER',jsonb_build_object('stopId',$2::text))", [tripId,stopId]);
        await client.query("COMMIT");
        return { completed: true, tripCompleted: !remaining.rows[0] };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
}

async function startTrip(driverId, tripId) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const trip = await client.query("SELECT * FROM trip WHERE trip_id=$1 AND driver_id=$2 FOR UPDATE", [tripId,driverId]);
        if (!trip.rows[0] || trip.rows[0].trip_status !== "DISPATCHED") { await client.query("ROLLBACK"); return { error:"TRIP_NOT_DISPATCHED" }; }
        const firstStop = await client.query("SELECT 1 FROM trip_stop_sequence WHERE trip_id=$1 AND stop_sequence=1 AND arrived_at IS NOT NULL", [tripId]);
        const boarded = await client.query("SELECT 1 FROM booking WHERE trip_id=$1 AND booking_status='IN_PROGRESS' LIMIT 1", [tripId]);
        if (!firstStop.rows[0] || !boarded.rows[0]) { await client.query("ROLLBACK"); return { error:"BOARDING_REQUIRED" }; }
        await client.query("UPDATE trip SET trip_status='IN_PROGRESS',updated_at=clock_timestamp() WHERE trip_id=$1", [tripId]);
        await client.query("INSERT INTO drt_engine_event(event_type,trip_id,actor_role) VALUES('TRIP_STARTED',$1,'DRIVER')", [tripId]);
        await client.query("COMMIT"); return { started:true };
    } catch(error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

async function issueBoardingOtp(userId, bookingId, otpHash, validityMinutes) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const { rows } = await client.query("SELECT booking_id,booking_status,boarding_deadline,boarding_policy FROM booking WHERE booking_id=$1 AND user_id=$2 FOR UPDATE", [bookingId,userId]);
        const booking = rows[0];
        if (!booking) { await client.query("ROLLBACK"); return { error:"NOT_FOUND" }; }
        if (booking.booking_status !== "BOARDING") { await client.query("ROLLBACK"); return { error:"NOT_ELIGIBLE" }; }
        const snapshotValidity = Number(booking.boarding_policy?.otpValidityMinutes || validityMinutes);
        const { rows: issued } = await client.query(`UPDATE booking SET otp_hash=$2,otp_created_at=clock_timestamp(),
            otp_expires_at=LEAST(clock_timestamp()+($3::int*interval '1 minute'),boarding_deadline)
            WHERE booking_id=$1 AND boarding_deadline>clock_timestamp() RETURNING otp_expires_at`, [bookingId,otpHash,snapshotValidity]);
        if (!issued[0]) { await client.query("ROLLBACK"); return { error:"EXPIRED" }; }
        await client.query("COMMIT"); return { expiresAt:issued[0].otp_expires_at };
    } catch(error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

async function verifyBoardingOtp(driverId, bookingId, code, compareHash) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const { rows } = await client.query(`SELECT b.*,t.driver_id AS assigned_driver FROM booking b JOIN trip t ON t.trip_id=b.trip_id WHERE b.booking_id=$1 FOR UPDATE OF b`, [bookingId]);
        const booking = rows[0];
        if (!booking || booking.assigned_driver !== driverId) { await client.query("ROLLBACK"); return { error:"NOT_FOUND" }; }
        if (booking.booking_status !== "BOARDING" || !booking.boarding_deadline) { await client.query("ROLLBACK"); return { error:"NOT_ELIGIBLE" }; }
        const policy = booking.boarding_policy || {};
        const maxAttempts = Number(policy.otpMaxAttempts || 5);
        if (Number(booking.otp_attempts) >= maxAttempts) { await client.query("ROLLBACK"); return { error:"ATTEMPTS_EXCEEDED" }; }
        const time = await client.query("SELECT clock_timestamp() AS now");
        if (new Date(booking.boarding_deadline) <= new Date(time.rows[0].now)) { await client.query("ROLLBACK"); return { error:"EXPIRED" }; }
        if (!booking.otp_hash || !booking.otp_expires_at || new Date(booking.otp_expires_at) <= new Date(time.rows[0].now)) { await client.query("ROLLBACK"); return { error:"OTP_UNAVAILABLE" }; }
        if (!await compareHash(code, booking.otp_hash)) {
            const attempts = Number(booking.otp_attempts)+1;
            await client.query("UPDATE booking SET otp_attempts=$2,otp_hash=CASE WHEN $2 >= $3 THEN NULL ELSE otp_hash END WHERE booking_id=$1", [bookingId,attempts,maxAttempts]);
            await client.query("INSERT INTO drt_engine_event(event_type,trip_id,booking_id,actor_role,details) VALUES('OTP_REJECTED',$1,$2,'DRIVER',jsonb_build_object('attempt',$3::int))", [booking.trip_id,bookingId,attempts]);
            await client.query("COMMIT"); return { error:attempts >= maxAttempts ? "ATTEMPTS_EXCEEDED" : "INVALID_OTP" };
        }
        assertTransition("BOARDING", "IN_PROGRESS");
        await client.query("UPDATE booking SET booking_status='IN_PROGRESS',boarded_at=clock_timestamp(),otp_used_at=clock_timestamp(),otp_hash=NULL WHERE booking_id=$1", [bookingId]);
        await client.query("INSERT INTO drt_engine_event(event_type,trip_id,booking_id,actor_role) VALUES('PASSENGER_BOARDED',$1,$2,'DRIVER')", [booking.trip_id,bookingId]);
        await client.query("COMMIT"); return { boarded:true,bookingId };
    } catch(error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

module.exports = { createTelemetry, setAvailability, getAvailability, getAssignedTrips, arriveAtStop, completeStop, startTrip, issueBoardingOtp, verifyBoardingOtp };
