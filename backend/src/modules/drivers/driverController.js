const service = require("./driverServices");
const { exportDemoTripHistory } = require("../drt/services/demoCsvExportService");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const driverId = request => request.identity.driverId || request.identity.identityId;

async function recordTelemetry(request, reply) {
    const body = request.body || {};
    const { tripId, latitude, longitude, speedKmph, headingDegrees, accuracyM } = body;
    if ((tripId !== undefined && (typeof tripId !== "string" || !UUID.test(tripId))) ||
        typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
        (speedKmph !== undefined && (typeof speedKmph !== "number" || !Number.isFinite(speedKmph) || speedKmph < 0 || speedKmph > 300)) ||
        (headingDegrees !== undefined && (typeof headingDegrees !== "number" || !Number.isFinite(headingDegrees) || headingDegrees < 0 || headingDegrees > 360)) ||
        (accuracyM !== undefined && (typeof accuracyM !== "number" || !Number.isFinite(accuracyM) || accuracyM < 0 || accuracyM > 10000))) {
        return reply.code(400).send({ message: "Provide valid latitude/longitude, and optional valid trip ID, speed, and heading." });
    }
    try {
        const record = await service.recordTelemetry(driverId(request), { tripId, latitude, longitude, speedKmph, headingDegrees, accuracyM });
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
        if (!result || result.error) return reply.code(409).send({message:result?.error==="ACTIVE_TRIP"?"You cannot go offline while a trip is active.":result?.error?"Save a service mode and fresh location before going online.":"Driver account was not found."});
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
        if(result.error) return reply.code(result.error==="TRIP_NOT_FOUND"||result.error==="STOP_NOT_FOUND"?404:409).send({message:result.error==="STOP_ORDER"?"Complete earlier stops first.":result.error==="LOCATION_REQUIRED"?"Refresh your GPS near this stop. A recent, accurate position is required to confirm arrival.":"Stop is not eligible for arrival confirmation."});
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
        const result=await service.completeStop(driverId(request),tripId,stopId,request.body||{});
        if(result.error) return reply.code(409).send({message:({PICKUP_NOT_RESOLVED:"All passengers at this pickup must board or reach their no-show outcome first.",NO_PASSENGER_CONFIRMATION_REQUIRED:"Confirm that no scheduled passenger is waiting at this service point.",STOP_ORDER:"Complete earlier stops first."})[result.error]||"Stop is not ready to complete."});
        if(result.completed) {
            try {
                const exported=await exportDemoTripHistory({tripId});
                if(exported.exported) request.log.info({event:"demo_trip_csv_refreshed",tripId,rows:exported.rows},"Refreshed demo trip history CSV.");
            } catch(error) {
                request.log.error({err:error,tripId},"Unable to refresh demo trip history CSV.");
            }
        }
        return reply.send(result);
    } catch(error) { request.log.error(error); return reply.code(500).send({message:"Unable to complete stop."}); }
}

async function verifyOtp(request, reply) {
    const {bookingId}=request.params;
    if(!UUID.test(bookingId)||typeof request.body?.otp!=="string"||!/^\d{6}$/.test(request.body.otp)) return reply.code(400).send({message:"Enter a valid six-digit boarding OTP."});
    try {
        const result=await service.verifyBoardingOtp(driverId(request),bookingId,request.body.otp);
        if(result.error) return reply.code(result.error==="NOT_FOUND"?404:409).send({message:({INVALID_OTP:"The boarding OTP is invalid.",EXPIRED:"The boarding deadline has expired.",OTP_UNAVAILABLE:"OTP is not available yet or has expired.",ATTEMPTS_EXCEEDED:"The maximum OTP attempts have been reached.",NOT_ELIGIBLE:"This booking is not currently boarding eligible."})[result.error]||"This booking is not eligible for OTP verification."});
        return reply.send({boarded:true,bookingId});
    } catch(error) { request.log.error(error); return reply.code(500).send({message:"Unable to verify boarding OTP."}); }
}

async function getServiceMode(request,reply){try{const data=await service.getServiceMode(driverId(request));if(!data)return reply.code(404).send({message:"Driver account was not found."});return reply.send(data);}catch(error){request.log.error(error);return reply.code(500).send({message:"Unable to load service mode."});}}
async function setServiceMode(request,reply){const mode=request.body?.mode;if(!["RESIDENTIAL_TO_METRO","METRO_TO_RESIDENTIAL"].includes(mode))return reply.code(400).send({message:"Choose a supported service mode."});try{const data=await service.setServiceMode(driverId(request),mode);if(!data)return reply.code(404).send({message:"Driver account was not found."});if(data.error)return reply.code(409).send({message:"Service mode cannot change during an active trip."});return reply.send(data);}catch(error){request.log.error(error);return reply.code(500).send({message:"Unable to save service mode."});}}
async function getCatalog(request,reply){try{return reply.send({zones:await service.getDriverCatalog(driverId(request))});}catch(error){request.log.error(error);return reply.code(500).send({message:"Unable to load service zones."});}}
async function setZone(request,reply){if(!UUID.test(request.body?.zoneId||""))return reply.code(400).send({message:"Choose a valid service zone."});try{const data=await service.setActiveZone(driverId(request),request.body.zoneId);if(!data)return reply.code(409).send({message:"Zone is unavailable or the driver has an active trip."});return reply.send(data);}catch(error){request.log.error(error);return reply.code(500).send({message:"Unable to save service zone."});}}

module.exports = { recordTelemetry, setAvailability, getAvailability, assignedTrips, arriveAtStop, startTrip, completeStop, verifyOtp,getServiceMode,setServiceMode,getCatalog,setZone };
