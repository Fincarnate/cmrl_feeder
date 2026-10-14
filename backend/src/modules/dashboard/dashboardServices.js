const dashboardQueries = require("../../db/queries/dashboardQueries");

async function getDashboardSummary() {
    return dashboardQueries.getDashboardSummary();
}

module.exports = {
    getDashboardSummary
};
