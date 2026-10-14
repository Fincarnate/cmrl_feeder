const { getDashboardSummary } = require("./dashboardServices");

async function getSummary(request, reply) {
    try {
        const summary = await getDashboardSummary();

        return reply.code(200).send(summary);
    } catch (error) {
        request.log.error(error);

        return reply.code(500).send({
            message: "Unable to load dashboard data."
        });
    }
}

module.exports = {
    getSummary
};
