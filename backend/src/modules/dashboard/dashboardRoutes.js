const authenticateAdmin = require("../../middleware/authMiddleware");
const dashboardController = require("./dashboardController");

async function dashboardRoutes(fastify) {
    fastify.get(
        "/summary",
        { preHandler: authenticateAdmin },
        dashboardController.getSummary
    );
}

module.exports = dashboardRoutes;
