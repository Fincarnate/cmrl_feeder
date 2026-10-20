const pool = require("../pool");

async function getDriverById(driverId) {
    const result = await pool.query(
        `SELECT
            d.driver_id,
            d.full_name,
            d.phone_number,
            d.active_zone_id,
            d.current_service_mode,
            d.shift_status,
            d.kyc_type
         FROM driver d
         WHERE d.driver_id = $1`,
        [driverId]
    );

    return result.rows[0] || null;
}

async function updateDriverMode(driverId, mode) {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const driverResult = await client.query(
            `SELECT driver_id, shift_status
             FROM driver
             WHERE driver_id = $1
             FOR UPDATE`,
            [driverId]
        );

        const driver = driverResult.rows[0];

        if (!driver) {
            await client.query("ROLLBACK");
            return { error: "DRIVER_NOT_FOUND" };
        }

        if (driver.shift_status !== "ON_SHIFT") {
            await client.query("ROLLBACK");
            return { error: "DRIVER_NOT_ON_SHIFT" };
        }

        const activeTrip = await client.query(
            `SELECT trip_id
             FROM trip
             WHERE driver_id = $1
               AND UPPER(COALESCE(trip_status, '')) IN ('ACTIVE', 'IN_PROGRESS')
             LIMIT 1`,
            [driverId]
        );

        if (activeTrip.rows.length) {
            await client.query("ROLLBACK");
            return { error: "ACTIVE_TRIP_EXISTS" };
        }

        const result = await client.query(
            `UPDATE driver
             SET current_service_mode = $2
             WHERE driver_id = $1
             RETURNING driver_id, current_service_mode, shift_status`,
            [driverId, mode]
        );

        await client.query("COMMIT");
        return { driver: result.rows[0] };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

async function validatePassengerBooking(driverId, bookingId, otp) {
    const result = await pool.query(
        `SELECT
            b.booking_id,
            b.booking_status,
            b.trip_id,
            t.trip_status,
            t.driver_id,
            b.user_id
         FROM booking b
         JOIN trip t ON t.trip_id = b.trip_id
         WHERE b.booking_id = $1
           AND t.driver_id = $2
           AND b.booking_otp = $3
         LIMIT 1`,
        [bookingId, driverId, otp]
    );

    const booking = result.rows[0];

    if (!booking) {
        return { valid: false, reason: "BOOKING_OR_OTP_INVALID" };
    }

    if (!["CONFIRMED", "BOOKED"].includes(
        String(booking.booking_status || "").toUpperCase()
    )) {
        return { valid: false, reason: "BOOKING_NOT_CONFIRMABLE" };
    }

    if (!["ACTIVE", "IN_PROGRESS"].includes(
        String(booking.trip_status || "").toUpperCase()
    )) {
        return { valid: false, reason: "TRIP_NOT_ACTIVE" };
    }

    return {
        valid: true,
        booking: {
            bookingId: booking.booking_id,
            userId: booking.user_id,
            tripId: booking.trip_id
        }
    };
}

async function terminateTrip(driverId, tripId) {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const tripResult = await client.query(
            `SELECT trip_id, trip_status
             FROM trip
             WHERE trip_id = $1
               AND driver_id = $2
             FOR UPDATE`,
            [tripId, driverId]
        );

        const trip = tripResult.rows[0];

        if (!trip) {
            await client.query("ROLLBACK");
            return { error: "TRIP_NOT_FOUND" };
        }

        const status = String(trip.trip_status || "").toUpperCase();

        if (!["ACTIVE", "IN_PROGRESS"].includes(status)) {
            await client.query("ROLLBACK");
            return { error: "TRIP_NOT_ACTIVE" };
        }

        await client.query(
            `UPDATE trip
             SET trip_status = 'COMPLETED'
             WHERE trip_id = $1`,
            [tripId]
        );

        await client.query(
            `UPDATE booking
             SET booking_status = 'COMPLETED'
             WHERE trip_id = $1
               AND UPPER(COALESCE(booking_status, '')) IN ('CONFIRMED', 'BOOKED', 'IN_PROGRESS')`,
            [tripId]
        );

        await client.query("COMMIT");

        return {
            tripId,
            tripStatus: "COMPLETED"
        };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {
    getDriverById,
    updateDriverMode,
    validatePassengerBooking,
    terminateTrip
};