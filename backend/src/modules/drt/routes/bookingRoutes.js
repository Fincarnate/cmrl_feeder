const authenticateIdentity = require("../../../middleware/identityAuth");
const controller = require("../controllers/bookingController");

async function bookingRoutes(fastify) {
    fastify.get("/service-areas", { preHandler:authenticateIdentity("PASSENGER") }, controller.serviceAreas);
    fastify.post("/fare-preview", { preHandler:authenticateIdentity("PASSENGER") }, controller.previewFare);
    fastify.post("/", { preHandler:authenticateIdentity("PASSENGER") }, controller.createBooking);
    fastify.get("/", { preHandler:authenticateIdentity("PASSENGER") }, controller.listBookings);
    fastify.get("/:id", { preHandler:authenticateIdentity("PASSENGER") }, controller.getBooking);
    fastify.post("/:id/cancel", { preHandler:authenticateIdentity("PASSENGER") }, controller.cancelBooking);
    fastify.get("/:id/otp", { preHandler:authenticateIdentity("PASSENGER") }, controller.getOtp);
}

module.exports = bookingRoutes;
