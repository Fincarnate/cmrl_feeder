const services = require("./driverServices");

function handleError(request, reply, error) {
    if (error.statusCode && error.statusCode < 500) {
        return reply.code(error.statusCode).send({
            success: false,
            code: error.code || "REQUEST_ERROR",
            message: error.message
        });
    }

    request.log.error(error);

    return reply.code(500).send({
        success: false,
        message: "An unexpected server error occurred."
    });
}

async function getProfile(request, reply) {
    try {
        const driver = await services.getProfile(request.identity.id);

        return reply.send({
            success: true,
            driver
        });
    } catch (error) {
        return handleError(request, reply, error);
    }
}

async function changeMode(request, reply) {
    try {
        const { mode } = request.body || {};

        const driver = await services.changeMode(
            request.identity.id,
            mode
        );

        return reply.send({
            success: true,
            message: "Driver mode updated.",
            driver
        });
    } catch (error) {
        return handleError(request, reply, error);
    }
}

async function validatePassenger(request, reply) {
    try {
        const { bookingId, otp } = request.body || {};

        const result = await services.validatePassenger(
            request.identity.id,
            bookingId,
            otp
        );

        if (!result.valid) {
            return reply.code(422).send({
                success: false,
                message: "Passenger validation failed.",
                reason: result.reason
            });
        }

        return reply.send({
            success: true,
            message: "Passenger booking validated.",
            booking: result.booking
        });
    } catch (error) {
        return handleError(request, reply, error);
    }
}

async function terminateService(request, reply) {
    try {
        const { tripId } = request.body || {};

        const result = await services.terminateService(
            request.identity.id,
            tripId
        );

        return reply.send({
            success: true,
            message: "Trip completed.",
            result
        });
    } catch (error) {
        return handleError(request, reply, error);
    }
}

module.exports = {
    getProfile,
    changeMode,
    validatePassenger,
    terminateService
};