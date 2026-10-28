const dashboardQueries = require("../../db/queries/dashboardQueries");
const policyQueries = require("../../modules/drt/queries/policyQueries");
const { getDemoFleetService } = require("../../modules/drt/services/demoFleetService");

async function getDashboardSummary() {
    return dashboardQueries.getDashboardSummary();
}

async function getDashboardMapData() {
    return dashboardQueries.getDashboardMapData();
}

async function getDashboardOperations() { return dashboardQueries.getDashboardOperations(); }
async function getPolicies() { return policyQueries.listPolicies(); }
async function updateFarePolicy(input) { return policyQueries.updateFare(input); }
async function updateOperatingPolicy(input) { return policyQueries.updateOperating(input); }
async function getDemoFleet() { return getDemoFleetService().getStatus(); }

module.exports = {
    getDashboardSummary,
    getDashboardMapData,
    getDashboardOperations,
    getPolicies,
    updateFarePolicy,
    updateOperatingPolicy,
    getDemoFleet
};
