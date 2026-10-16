
const userServices = require("./userServices");

async function getServiceOptions(request, reply) {
    try {
        const { direction, source, destination } = request.body || {};

        // Determine which endpoint represents the residential location.
        let residentialLocation;

        if (direction === "RESIDENTIAL_TO_METRO") {
            residentialLocation = source;
        } else if (direction === "METRO_TO_RESIDENTIAL") {
            residentialLocation = destination;
        } else {
            return reply.code(400).send({
                success: false,
                code: "INVALID_DIRECTION",
                message:
                    "Direction must be RESIDENTIAL_TO_METRO or METRO_TO_RESIDENTIAL."
            });
        }

        // The residential endpoint must provide coordinates.
        if (
            !residentialLocation ||
            typeof residentialLocation.latitude !== "number" ||
            typeof residentialLocation.longitude !== "number"
        ) {
            return reply.code(400).send({
                success: false,
                code: "INVALID_RESIDENTIAL_LOCATION",
                message:
                    "Valid residential location coordinates are required."
            });
        }

        // Delegate business validation and serviceability lookup.
        const result = await userServices.getServiceOptions({
            direction,
            latitude: residentialLocation.latitude,
            longitude: residentialLocation.longitude
        });

        return reply.code(200).send({
            success: true,
            ...result
        });
    } catch (error) {
        if (error.statusCode === 400) {
            return reply.code(400).send({
                success: false,
                code: error.code || "INVALID_REQUEST",
                message: error.message
            });
        }

        request.log.error(error);

        return reply.code(500).send({
            success: false,
            code: "INTERNAL_SERVER_ERROR",
            message: "Unable to retrieve service options."
        });
    }
}

module.exports = {
    getServiceOptions
};
