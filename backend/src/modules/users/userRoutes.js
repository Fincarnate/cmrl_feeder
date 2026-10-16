const controller = require("./userController");
const authenticateIdentity = require("../../middleware/identityAuth");

async function userRoutes(fastify) {
    const authenticatePassenger = authenticateIdentity("PASSENGER");

    // Serviceability is public to this API, but does not expose passenger data.
    fastify.post("/service-options", controller.getServiceOptions);

    // The remaining endpoints require a passenger identity.
    fastify.post(
        "/requests",
        { preHandler: authenticatePassenger },
        controller.createRequest
    );

    fastify.get(
        "/requests/:id",
        { preHandler: authenticatePassenger },
        controller.getRequest
    );
}

module.exports = userRoutes;