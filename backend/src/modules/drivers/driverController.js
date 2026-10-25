const service = require("./driverServices");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const driverId = request => request.identity.driverId || request.identity.identityId;

async function recordTelemetry(request, reply) {
    const body = request.body || {};
    const { tripId, latitude, longitude, speedKmph, headingDegrees } = body;
    if ((tripId !== undefined && (typeof tripId !== "string" || !UUID.test(tripId))) ||
        typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
        (speedKmph !== undefined && (typeof speedKmph !== "number" || !Number.isFinite(speedKmph) || speedKmph < 0 || speedKmph > 300)) ||
        (headingDegrees !== undefined && (typeof headingDegrees !== "number" || !Number.isFinite(headingDegrees) || headingDegrees < 0 || headingDegrees > 360))) {
        return reply.code(400).send({ message: "Provide valid latitude/longitude, and optional valid trip ID, speed, and heading." });
    }
    try {
        const record = await service.recordTelemetry(driverId(request), { tripId, latitude, longitude, speedKmph, headingDegrees });
        if (!record) return reply.code(404).send({ message: "Driver or assigned trip was not found." });
        return reply.code(201).send({ message: "Location recorded.", recordedAt: record.recorded_at });
    } catch (error) {
        request.log.error(error);
        return reply.code(500).send({ message: "Unable to record location." });
    }
}

async function setAvailability(request, reply) {
    if (typeof request.body?.online !== "boolean") return reply.code(400).send({message:"online must be true or false."});
    try {
        const result = await service.setAvailability(driverId(request),request.body.online);
        if (!result) return reply.code(409).send({message:"Availability cannot be changed during an active trip, or the driver account was not found."});
        return reply.send({availability:result});
    } catch(error) { request.log.error(error); return reply.code(500).send({message:"Unable to update availability."}); }
}

async function getAvailability(request,reply) {
    try { const availability=await service.getAvailability(driverId(request));if(!availability)return reply.code(404).send({message:"Driver account was not found."});return reply.send({availability}); }
    catch(error) { request.log.error(error);return reply.code(500).send({message:"Unable to load availability."}); }
}

async function assignedTrips(request, reply) {
    try { return reply.send({trips:await service.getAssignedTrips(driverId(request))}); }
    catch(error) { request.log.error(error); return reply.code(500).send({message:"Unable to load assigned trips."}); }
}

async function arriveAtStop(request, reply) {
    const {tripId,stopId}=request.params;
    if(!UUID.test(tripId)||!UUID.test(stopId)) return reply.code(400).send({message:"Trip or stop ID is invalid."});
    try {
        const result=await service.arriveAtStop(driverId(request),tripId,stopId);
        if(result.error) return reply.code(result.error==="TRIP_NOT_FOUND"||result.error==="STOP_NOT_FOUND"?404:409).send({message:result.error==="STOP_ORDER"?"Complete earlier stops first.":"Stop is not eligible for arrival confirmation."});
        return reply.send({arrivalRecorded:true,boarding:result.bookings});
    } catch(error) { request.log.error(error); return reply.code(500).send({message:"Unable to record stop arrival."}); }
}

async function startTrip(request, reply) {
    if(!UUID.test(request.params.tripId)) return reply.code(400).send({message:"Trip ID is invalid."});
    try {
        const result=await service.startTrip(driverId(request),request.params.tripId);
        if(result.error) return reply.code(409).send({message:"Trip can start after an authorized first-stop arrival and at least one passenger boards."});
        return reply.send({started:true});
    } catch(error) { request.log.error(error); return reply.code(500).send({message:"Unable to start trip."}); }
}

async function completeStop(request, reply) {
    const {tripId,stopId}=request.params;
    if(!UUID.test(tripId)||!UUID.test(stopId)) return reply.code(400).send({message:"Trip or stop ID is invalid."});
    try {
        const result=await service.completeStop(driverId(request),tripId,stopId);
        if(result.error) return reply.code(409).send({message:result.error==="PICKUP_NOT_RESOLVED"?"All passengers at this pickup must board or reach their no-show outcome first.":"Stop is not ready to complete."});
        return reply.send(result);
    } catch(error) { request.log.error(error); return reply.code(500).send({message:"Unable to complete stop."}); }
}

async function verifyOtp(request, reply) {
    const {bookingId}=request.params;
    if(!UUID.test(bookingId)||typeof request.body?.otp!=="string"||!/^\d{6}$/.test(request.body.otp)) return reply.code(400).send({message:"Enter a valid six-digit boarding OTP."});
    try {
        const result=await service.verifyBoardingOtp(driverId(request),bookingId,request.body.otp);
        if(result.error) return reply.code(result.error==="NOT_FOUND"?404:409).send({message:result.error==="INVALID_OTP"?"The boarding OTP is invalid.":"This booking is not eligible for OTP verification."});
        return reply.send({boarded:true,bookingId});
    } catch(error) { request.log.error(error); return reply.code(500).send({message:"Unable to verify boarding OTP."}); }
}

module.exports = { recordTelemetry, setAvailability, getAvailability, assignedTrips, arriveAtStop, startTrip, completeStop, verifyOtp };
