//Server related code.

const buildApp = require("./app");
const config = require("./config/env");
const pool = require("./db/pool");
const { createWorker } = require("./modules/drt/services/workerService");
const { getDemoFleetService } = require("./modules/drt/services/demoFleetService");

async function startServer() {
    const app = buildApp();

    try {
        await app.listen({
            port: Number(config.port),
            host: "0.0.0.0"
        });

        const worker = createWorker({ logger: app.log, intervalMs: config.drtWorkerIntervalMs });
        worker.start();
        const demoFleet = getDemoFleetService({ logger: app.log });
        await demoFleet.start();
        let shuttingDown = false;
        const shutdown = async (signal) => {
            if (shuttingDown) return;
            shuttingDown = true;
            app.log.info({ signal }, "Shutting down CMRL Feeder services.");
            await demoFleet.stop();
            await worker.stop();
            await app.close();
            await pool.end();
        };
        process.once("SIGINT", () => shutdown("SIGINT").finally(() => process.exit(0)));
        process.once("SIGTERM", () => shutdown("SIGTERM").finally(() => process.exit(0)));

        app.log.info(`Server running on port ${config.port}`);
    } catch (error) {
        app.log.error(error);
        process.exit(1);
    }
}

startServer();
