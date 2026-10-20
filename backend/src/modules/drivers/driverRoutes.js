const controller = require("./driverController");
const authenticateIdentity = require("../../middleware/identityAuth");

async function driverRoutes(fastify) {
    const authenticateDriver = authenticateIdentity("DRIVER");

    fastify.get(
        "/me",
        { preHandler: authenticateDriver },
        controller.getProfile
    );

    fastify.patch(
        "/me/mode",
        { preHandler: authenticateDriver },
        controller.changeMode
    );

    fastify.post(
        "/me/validate-passenger",
        { preHandler: authenticateDriver },
        controller.validatePassenger
    );

    fastify.post(
        "/me/terminate-service",
        { preHandler: authenticateDriver },
        controller.terminateService
    );
}

module.exports = driverRoutes;