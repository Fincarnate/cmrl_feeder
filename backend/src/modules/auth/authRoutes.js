const authController = require("./authController");

async function authRoutes(fastify) {
    // Entry point for the login page
    fastify.get("/login", async (request, reply) => {
        return reply.redirect("http://localhost:5173/login");
    });

    // API endpoint for admin authentication
    fastify.post("/login", authController.login);
}

module.exports = authRoutes;