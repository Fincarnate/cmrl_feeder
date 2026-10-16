const queries = require("../../db/queries/userQueries");

const DIRECTIONS = [
    "RESIDENTIAL_TO_METRO",
    "METRO_TO_RESIDENTIAL"
];

const REQUEST_TYPES = ["BOOKING", "IMMEDIATE"];

function validationError(message, code = "INVALID_REQUEST") {
    const error = new Error(message);
    error.statusCode = 400;
    error.code = code;
    return error;
}

function validateCoordinates(location) {
    return location &&
        typeof location.latitude === "number" &&
        Number.isFinite(location.latitude) &&
        location.latitude >= -90 &&
        location.latitude <= 90 &&
        typeof location.longitude === "number" &&
        Number.isFinite(location.longitude) &&
        location.longitude >= -180 &&
        location.longitude <= 180;
}

async function getServiceOptions({ direction, source, destination }) {
    if (!DIRECTIONS.includes(direction)) {
        throw validationError("Invalid travel direction.", "INVALID_DIRECTION");
    }

    const residentialLocation =
        direction === "RESIDENTIAL_TO_METRO" ? source : destination;

    if (!validateCoordinates(residentialLocation)) {
        throw validationError(
            "Valid residential-side coordinates are required.",
            "INVALID_COORDINATES"
        );
    }

    const options = await queries.findServiceOptionsForLocation(
        residentialLocation.latitude,
        residentialLocation.longitude
    );

    return {
        serviceable: options.length > 0,
        direction,
        residentialLocationSide:
            direction === "RESIDENTIAL_TO_METRO" ? "SOURCE" : "DESTINATION",
        message: options.length
            ? "Service is available for this location."
            : "Your residential location is not serviceable.",
        options
    };
}

async function createRequest(userId, input) {
    if (!REQUEST_TYPES.includes(input.requestType)) {
        throw validationError(
            "requestType must be BOOKING or IMMEDIATE."
        );
    }

    if (!DIRECTIONS.includes(input.direction)) {
        throw validationError("Invalid travel direction.", "INVALID_DIRECTION");
    }

    if (!input.stationId || !input.zoneId) {
        throw validationError("stationId and zoneId are required.");
    }

    const seats = input.seatsRequested ?? 1;

    if (!Number.isInteger(seats) || seats < 1) {
        throw validationError("seatsRequested must be a positive integer.");
    }

    if (
        input.residentialPointId !== undefined &&
        input.residentialPointId !== null &&
        typeof input.residentialPointId !== "string"
    ) {
        throw validationError("residentialPointId must be a valid ID.");
    }

    const source = input.source || null;
    const destination = input.destination || null;

    if (input.direction === "RESIDENTIAL_TO_METRO") {
        if (!validateCoordinates(source)) {
            throw validationError("Valid residential source coordinates are required.");
        }
    } else if (!validateCoordinates(destination)) {
        throw validationError("Valid residential destination coordinates are required.");
    }

    // Check serviceability before creating the request.
    const serviceability = await getServiceOptions({
        direction: input.direction,
        source,
        destination
    });

    if (!serviceability.serviceable) {
        const error = validationError(
            "Residential location is not serviceable.",
            "UNSERVICEABLE_LOCATION"
        );
        error.statusCode = 422;
        throw error;
    }

    const matchingOption = serviceability.options.find(
        option =>
            option.station_id === input.stationId &&
            option.zone_id === input.zoneId
    );

    if (!matchingOption) {
        throw validationError(
            "The selected station and zone are not valid for this location.",
            "INVALID_SERVICE_SELECTION"
        );
    }

    // The point must belong to the selected zone and be in the query results.
    if (
        input.residentialPointId &&
        !matchingOption.pickup_points.some(
            point => point.point_id === input.residentialPointId
        )
    ) {
        throw validationError(
            "The selected pickup point is not valid for this zone.",
            "INVALID_PICKUP_POINT"
        );
    }

    const request = await queries.createServiceRequest({
        userId,
        requestType: input.requestType,
        direction: input.direction,
        stationId: input.stationId,
        zoneId: input.zoneId,
        residentialPointId: input.residentialPointId || null,
        sourceDescription: input.sourceDescription || null,
        destinationDescription: input.destinationDescription || null,
        sourceLatitude: source?.latitude ?? null,
        sourceLongitude: source?.longitude ?? null,
        destinationLatitude: destination?.latitude ?? null,
        destinationLongitude: destination?.longitude ?? null,
        seatsRequested: seats
    });

    if (!request) {
        const error = validationError(
            "Service selection is no longer valid.",
            "INVALID_SERVICE_SELECTION"
        );
        error.statusCode = 422;
        throw error;
    }

    return {
        request,
        fare: null,
        message: "Request recorded. Fare calculation and fulfilment are pending Dispatch Engine integration."
    };
}

async function getRequest(requestId, userId) {
    return queries.findRequestById(requestId, userId);
}

module.exports = {
    getServiceOptions,
    createRequest,
    getRequest
};