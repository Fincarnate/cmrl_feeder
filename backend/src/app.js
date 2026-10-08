// Application-related code

const Fastify = require("fastify");
const cors = require("@fastify/cors");

const authRoutes = require("./modules/auth/authRoutes");

function buildApp() {
    const app = Fastify({       // Creates server appplication with logger enabled.
        logger: true
    });

    app.register(cors, {        // @fastify/cors allows your development frontend at http://localhost:5173 to make browser requests.
        origin: "http://localhost:5173"
    });

    app.get("/health", async () => {        // checking if it works
        return {
            status: "ok"
        };
    });

    app.register(authRoutes, {
        prefix: "/api/auth"
    });

    return app;
}

module.exports = buildApp;