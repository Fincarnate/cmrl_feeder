const authController = require("./authController");

async function authRoutes(fastify) {
    fastify.post("/login", authController.login);
}

module.exports = authRoutes;