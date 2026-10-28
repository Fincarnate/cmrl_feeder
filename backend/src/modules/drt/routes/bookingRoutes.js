const authenticateIdentity = require("../../../middleware/identityAuth");
const controller = require("../controllers/bookingController");

async function bookingRoutes(fastify) {
    fastify.get("/service-areas", { preHandler:authenticateIdentity("PASSENGER") }, controller.serviceAreas);
    fastify.get("/schedules", { preHandler:authenticateIdentity("PASSENGER") }, controller.listSchedules);
    fastify.post("/schedules", { preHandler:authenticateIdentity("PASSENGER") }, controller.createSchedule);
    fastify.post("/schedules/:id/cancel", { preHandler:authenticateIdentity("PASSENGER") }, controller.cancelSchedule);
    fastify.post("/location-resolution", { preHandler:authenticateIdentity("PASSENGER") }, controller.resolveLocation);
    fastify.post("/fare-preview", { preHandler:authenticateIdentity("PASSENGER") }, controller.previewFare);
    fastify.post("/", { preHandler:authenticateIdentity("PASSENGER") }, controller.createBooking);
    fastify.get("/", { preHandler:authenticateIdentity("PASSENGER") }, controller.listBookings);
    fastify.get("/:id", { preHandler:authenticateIdentity("PASSENGER") }, controller.getBooking);
    fastify.post("/:id/cancel", { preHandler:authenticateIdentity("PASSENGER") }, controller.cancelBooking);
    fastify.get("/:id/otp", { preHandler:authenticateIdentity("PASSENGER") }, controller.getOtp);
}

module.exports = bookingRoutes;
