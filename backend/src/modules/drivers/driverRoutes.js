const authenticateIdentity = require("../../middleware/identityAuth");
const controller = require("./driverController");

async function driverRoutes(fastify) {
    fastify.post("/telemetry", { preHandler: authenticateIdentity("DRIVER") }, controller.recordTelemetry);
    fastify.post("/availability", { preHandler: authenticateIdentity("DRIVER") }, controller.setAvailability);
    fastify.get("/availability", { preHandler: authenticateIdentity("DRIVER") }, controller.getAvailability);
    fastify.get("/trips", { preHandler: authenticateIdentity("DRIVER") }, controller.assignedTrips);
    fastify.post("/trips/:tripId/start", { preHandler: authenticateIdentity("DRIVER") }, controller.startTrip);
    fastify.post("/trips/:tripId/stops/:stopId/arrival", { preHandler: authenticateIdentity("DRIVER") }, controller.arriveAtStop);
    fastify.post("/trips/:tripId/stops/:stopId/complete", { preHandler: authenticateIdentity("DRIVER") }, controller.completeStop);
    fastify.post("/bookings/:bookingId/verify-otp", { preHandler: authenticateIdentity("DRIVER") }, controller.verifyOtp);
}

module.exports = driverRoutes;
