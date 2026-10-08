//Server related code.

const buildApp = require("./app");
const config = require("./config/env");

async function startServer() {
    const app = buildApp();

    try {
        await app.listen({
            port: Number(config.port),
            host: "0.0.0.0"
        });

        app.log.info(`Server running on port ${config.port}`);
    } catch (error) {
        app.log.error(error);
        process.exit(1);
    }
}

startServer();