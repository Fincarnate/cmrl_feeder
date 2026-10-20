const queries = require("../../db/queries/driverQueries");

const VALID_MODES = ["WAITING", "PICKUP"];

function serviceError(code, message, statusCode = 400) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

async function getProfile(driverId) {
    const driver = await queries.getDriverById(driverId);

    if (!driver) {
        throw serviceError("DRIVER_NOT_FOUND", "Driver not found.", 404);
    }

    return driver;
}

async function changeMode(driverId, mode) {
    if (!VALID_MODES.includes(mode)) {
        throw serviceError(
            "INVALID_MODE",
            "Mode must be WAITING or PICKUP."
        );
    }

    const result = await queries.updateDriverMode(driverId, mode);

    const errors = {
        DRIVER_NOT_FOUND: [
            404,
            "Driver not found."
        ],
        DRIVER_NOT_ON_SHIFT: [
            409,
            "Driver must be on shift before switching modes."
        ],
        ACTIVE_TRIP_EXISTS: [
            409,
            "Mode cannot be changed while a trip is active."
        ]
    };

    if (result.error) {
        const [status, message] = errors[result.error];

        throw serviceError(result.error, message, status);
    }

    return result.driver;
}

async function validatePassenger(driverId, bookingId, otp) {
    if (
        typeof bookingId !== "string" ||
        typeof otp !== "string" ||
        !bookingId.trim() ||
        !otp.trim()
    ) {
        throw serviceError(
            "MISSING_VALIDATION_DATA",
            "bookingId and OTP are required."
        );
    }

    return queries.validatePassengerBooking(
        driverId,
        bookingId.trim(),
        otp.trim()
    );
}

async function terminateService(driverId, tripId) {
    if (typeof tripId !== "string" || !tripId.trim()) {
        throw serviceError("INVALID_TRIP_ID", "A trip ID is required.");
    }

    const result = await queries.terminateTrip(driverId, tripId.trim());

    if (result.error === "TRIP_NOT_FOUND") {
        throw serviceError("TRIP_NOT_FOUND", "Trip not found.", 404);
    }

    if (result.error === "TRIP_NOT_ACTIVE") {
        throw serviceError(
            "TRIP_NOT_ACTIVE",
            "Only an active trip can be completed.",
            409
        );
    }

    return result;
}

module.exports = {
    getProfile,
    changeMode,
    validatePassenger,
    terminateService
};