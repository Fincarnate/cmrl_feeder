const crypto = require("node:crypto");
const bcrypt = require("bcrypt");
const pool = require("../../../db/pool");
const config = require("../../../config/env");
const driverQueries = require("../../../db/queries/driverQueries");
const { exportDemoTripHistory } = require("./demoCsvExportService");

const ACTIVE_BOOKING_STATES = "('REQUESTED','ASSIGNED','BOARDING','IN_PROGRESS')";

async function getSyntheticTrips(database) {
    const { rows } = await database.query(`
      SELECT t.trip_id,t.driver_id,t.trip_direction,t.trip_status
      FROM trip t JOIN driver d ON d.driver_id=t.driver_id AND d.is_demo=TRUE
      WHERE t.trip_status IN ('DISPATCHED','IN_PROGRESS')
        AND EXISTS(SELECT 1 FROM booking b JOIN users u ON u.user_id=b.user_id
          WHERE b.trip_id=t.trip_id AND u.is_demo=TRUE AND b.idempotency_key LIKE 'demo-ghost:%'
            AND b.booking_status IN ${ACTIVE_BOOKING_STATES})
        AND NOT EXISTS(SELECT 1 FROM booking b LEFT JOIN users u ON u.user_id=b.user_id
          WHERE b.trip_id=t.trip_id AND b.booking_status IN ${ACTIVE_BOOKING_STATES}
            AND (u.is_demo IS DISTINCT FROM TRUE OR COALESCE(b.idempotency_key,'') NOT LIKE 'demo-ghost:%'))
      ORDER BY t.dispatched_at,t.trip_id LIMIT 50
    `);
    return rows;
}

async function getNextStop(database, tripId) {
    const { rows } = await database.query(`
      SELECT s.stop_id,s.stop_sequence,s.stop_type,s.point_id,s.station_id,
        ST_X(CASE WHEN s.stop_type='STATION' THEN ms.station_coords ELSE sp.location_coords END) AS longitude,
        ST_Y(CASE WHEN s.stop_type='STATION' THEN ms.station_coords ELSE sp.location_coords END) AS latitude
      FROM trip_stop_sequence s LEFT JOIN metro_station ms ON ms.station_id=s.station_id
      LEFT JOIN service_point sp ON sp.point_id=s.point_id
      WHERE s.trip_id=$1 AND s.completed_at IS NULL
      ORDER BY s.stop_sequence LIMIT 1
    `, [tripId]);
    return rows[0] || null;
}

async function boardSyntheticPassengers(database, trip, fallbackOtpValidityMinutes, logger) {
    const { rows } = await database.query(`
      SELECT b.booking_id,b.user_id
      FROM booking b JOIN users u ON u.user_id=b.user_id JOIN trip t ON t.trip_id=b.trip_id
      WHERE b.trip_id=$1 AND u.is_demo=TRUE AND b.idempotency_key LIKE 'demo-ghost:%'
        AND b.booking_status='BOARDING'
        AND EXISTS(SELECT 1 FROM trip_stop_sequence s WHERE s.trip_id=t.trip_id AND s.arrived_at IS NOT NULL
          AND ((t.trip_direction='RESIDENTIAL_TO_METRO' AND s.stop_type='SERVICE_POINT' AND s.point_id=b.service_point_id)
            OR (t.trip_direction='METRO_TO_RESIDENTIAL' AND s.stop_type='STATION' AND s.station_id=b.station_id)))
      ORDER BY b.requested_at,b.booking_id
    `, [trip.trip_id]);

    for (const booking of rows) {
        const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
        const otpHash = await bcrypt.hash(code, 12);
        const issued = await driverQueries.issueBoardingOtp(booking.user_id, booking.booking_id, otpHash,
            fallbackOtpValidityMinutes, database);
        if (issued.error) {
            logger?.warn({ event: "demo_trip_otp_not_issued", tripId: trip.trip_id, bookingId: booking.booking_id, reason: issued.error },
                "Could not issue the internal boarding OTP for a synthetic demo passenger.");
            continue;
        }
        const verified = await driverQueries.verifyBoardingOtp(trip.driver_id, booking.booking_id, code, bcrypt.compare, database);
        if (verified.error) throw new Error(`Synthetic demo passenger boarding failed: ${verified.error}.`);
    }
    return rows.length;
}

async function advanceOneTrip(database, trip, fallbackOtpValidityMinutes, logger) {
    const stop = await getNextStop(database, trip.trip_id);
    if (!stop) return { advanced: false, completed: false };
    if (stop.latitude == null || stop.longitude == null || !Number.isFinite(Number(stop.latitude)) || !Number.isFinite(Number(stop.longitude))) {
        throw new Error(`Trip ${trip.trip_id} has a stop without valid coordinates.`);
    }

    const accuracyM = Math.min(10, Number(config.drtStopArrivalRadiusM));
    const location = await driverQueries.createTelemetry(trip.driver_id, {
        tripId: trip.trip_id,
        latitude: Number(stop.latitude),
        longitude: Number(stop.longitude),
        accuracyM
    }, database);
    if (!location) throw new Error(`Demo driver location could not be moved to stop ${stop.stop_id}.`);

    const arrival = await driverQueries.arriveAtStop(trip.driver_id, trip.trip_id, stop.stop_id, database);
    if (arrival.error) throw new Error(`Demo driver could not arrive at stop ${stop.stop_id}: ${arrival.error}.`);

    await boardSyntheticPassengers(database, trip, fallbackOtpValidityMinutes, logger);

    const tripState = await database.query("SELECT trip_status FROM trip WHERE trip_id=$1", [trip.trip_id]);
    if (tripState.rows[0]?.trip_status === "DISPATCHED") {
        const boarded = await database.query(`SELECT 1 FROM booking WHERE trip_id=$1 AND booking_status='IN_PROGRESS' LIMIT 1`, [trip.trip_id]);
        if (boarded.rows[0]) {
            const started = await driverQueries.startTrip(trip.driver_id, trip.trip_id, database);
            if (started.error) throw new Error(`Demo trip could not start: ${started.error}.`);
        }
    }

    const completed = await driverQueries.completeStop(trip.driver_id, trip.trip_id, stop.stop_id,
        { confirmNoScheduledPassenger: true }, database);
    if (completed.error) throw new Error(`Demo driver could not complete stop ${stop.stop_id}: ${completed.error}.`);
    if (completed.tripCompleted) {
        try {
            const exported = await exportDemoTripHistory({ database });
            logger?.info({ event: "demo_synthetic_trip_completed", tripId: trip.trip_id, exportedRows: exported.rows },
                "Completed a synthetic demo passenger trip and refreshed trip history.");
        } catch (error) {
            logger?.error({ err: error, tripId: trip.trip_id }, "Synthetic demo trip completed but trip history CSV refresh failed.");
        }
    }
    return { advanced: true, completed: completed.tripCompleted };
}

async function advanceSyntheticDemoTrips({ database = pool, settings = config.demo, logger } = {}) {
    if (!settings.enabled || !settings.autoCompleteTrips || !settings.movementEnabled) return { advanced: 0, completed: 0, lastError: null };
    const policy = await database.query("SELECT otp_validity_minutes FROM drt_operating_policy WHERE is_active=TRUE ORDER BY version DESC LIMIT 1");
    const fallbackOtpValidityMinutes = Number(policy.rows[0]?.otp_validity_minutes || 3);
    const trips = await getSyntheticTrips(database);
    let advanced = 0, completed = 0, lastError = null;
    for (const trip of trips) {
        try {
            const result = await advanceOneTrip(database, trip, fallbackOtpValidityMinutes, logger);
            if (result.advanced) advanced++;
            if (result.completed) completed++;
        } catch (error) {
            lastError = error.message;
            logger?.error({ err: error, tripId: trip.trip_id }, "Unable to advance a synthetic demo passenger trip; it will be retried.");
        }
    }
    return { advanced, completed, lastError };
}

module.exports = { advanceSyntheticDemoTrips };
