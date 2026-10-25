// Application-related code

const Fastify = require("fastify");
const cors = require("@fastify/cors");

const authRoutes = require("./modules/auth/authRoutes");
const dashboardRoutes = require("./modules/dashboard/dashboardRoutes");
const driverRoutes = require("./modules/drivers/driverRoutes");
const bookingRoutes = require("./modules/drt/routes/bookingRoutes");
const config = require("./config/env");

function buildApp() {
    const app = Fastify({       // Creates server appplication with logger enabled.
        logger: true
    });

    if (!config.jwt.secret) {
        throw new Error("JWT_SECRET must be configured before starting the API.");
    }

    app.register(cors, {        // @fastify/cors allows your development frontend at http://localhost:5173 to make browser requests.
        origin: config.frontendOrigin
    });

    app.get("/health", async () => {        // checking if it works
        return {
            status: "ok"
        };
    });

    app.register(authRoutes, {
        prefix: "/api/auth"
    });

    app.register(dashboardRoutes, {
        prefix: "/api/dashboard"
    });

    app.register(driverRoutes, { prefix: "/api/drivers" });
    app.register(bookingRoutes, { prefix: "/api/bookings" });

    return app;
}

module.exports = buildApp;
