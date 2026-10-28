const pool = require("../db/pool");
const { exportDemoTripHistory } = require("../modules/drt/services/demoCsvExportService");

exportDemoTripHistory()
    .then(result => console.log(`Exported ${result.rows} demo booking rows to ${result.path}`))
    .catch(error => {
        console.error(`Unable to export demo trip history: ${error.message}`);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
