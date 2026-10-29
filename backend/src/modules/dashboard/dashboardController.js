const services = require("./dashboardServices");
const analyticsService = require("./analyticsService");

async function getAnalytics(request, reply) {
    try { return reply.send(await analyticsService.getAnalytics()); }
    catch(error) {
        request.log.error(error);
        return reply.code(error.statusCode || 500).send({message:error.statusCode?error.message:"Unable to load analytics."});
    }
}

async function predictAnalytics(request, reply) {
    try { return reply.send(await analyticsService.predictScenario(request.body || {})); }
    catch(error) {
        if(!error.statusCode) request.log.error(error);
        return reply.code(error.statusCode || 500).send({message:error.statusCode?error.message:"Unable to calculate analytics prediction."});
    }
}

async function getSummary(request, reply) {
    try {
        const summary = await services.getDashboardSummary();

        return reply.code(200).send(summary);
    } catch (error) {
        request.log.error(error);

        return reply.code(500).send({
            message: "Unable to load dashboard data."
        });
    }
}

async function getMapData(request, reply) {
    try { return reply.code(200).send(await services.getDashboardMapData()); }
    catch (error) {
        request.log.error(error);
        return reply.code(500).send({ message: "Unable to load map data." });
    }
}

async function getOperations(request,reply) {
    try { return reply.send(await services.getDashboardOperations()); }
    catch(error) { request.log.error(error); return reply.code(500).send({message:"Unable to load operational data."}); }
}

async function getDemoFleet(request,reply) {
    try { return reply.send(await services.getDemoFleet()); }
    catch(error) { request.log.error(error); return reply.code(500).send({message:"Unable to load demo fleet status."}); }
}

async function getPolicies(request,reply) {
    try { return reply.send(await services.getPolicies()); }
    catch(error) { request.log.error(error); return reply.code(500).send({message:"Unable to load policies."}); }
}

async function patchFarePolicy(request,reply) {
    try { return reply.send({fare:await services.updateFarePolicy(request.body||{})}); }
    catch(error) { if(!error.statusCode)request.log.error(error); return reply.code(error.statusCode||500).send({message:error.statusCode?error.message:"Unable to update fare policy."}); }
}

async function patchOperatingPolicy(request,reply) {
    try { return reply.send({operating:await services.updateOperatingPolicy(request.body||{})}); }
    catch(error) { if(!error.statusCode)request.log.error(error); return reply.code(error.statusCode||500).send({message:error.statusCode?error.message:"Unable to update operating policy."}); }
}

module.exports = {
    getSummary,
    getMapData,
    getOperations,
    getDemoFleet,
    getAnalytics,
    predictAnalytics,
    getPolicies,
    patchFarePolicy,
    patchOperatingPolicy
};
