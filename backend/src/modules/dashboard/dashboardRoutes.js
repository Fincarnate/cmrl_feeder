const authenticateAdmin = require("../../middleware/authMiddleware");
const dashboardController = require("./dashboardController");

async function dashboardRoutes(fastify) {
    fastify.get(
        "/summary",
        { preHandler: authenticateAdmin },
        dashboardController.getSummary
    );
    fastify.get("/map-data", { preHandler: authenticateAdmin }, dashboardController.getMapData);
    fastify.get("/operations", { preHandler: authenticateAdmin }, dashboardController.getOperations);
    fastify.get("/policies", { preHandler: authenticateAdmin }, dashboardController.getPolicies);
    fastify.patch("/policies/fare", { preHandler: authenticateAdmin }, dashboardController.patchFarePolicy);
    fastify.patch("/policies/operating", { preHandler: authenticateAdmin }, dashboardController.patchOperatingPolicy);
}

module.exports = dashboardRoutes;
