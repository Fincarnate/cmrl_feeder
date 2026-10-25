const queries = require("../../db/queries/driverQueries");
const bcrypt = require("bcrypt");

async function recordTelemetry(driverId, input) {
    return queries.createTelemetry(driverId, input);
}
async function getServiceMode(id){return queries.getServiceMode(id);}
async function setServiceMode(id,mode){return queries.setServiceMode(id,mode);}
async function getDriverCatalog(id){return queries.getDriverCatalog(id);}
async function setActiveZone(id,zoneId){return queries.setActiveZone(id,zoneId);}

async function setAvailability(driverId, online) { return queries.setAvailability(driverId,online); }
async function getAvailability(driverId) { return queries.getAvailability(driverId); }
async function getAssignedTrips(driverId) { return queries.getAssignedTrips(driverId); }
async function arriveAtStop(driverId,tripId,stopId) { return queries.arriveAtStop(driverId,tripId,stopId); }
async function startTrip(driverId,tripId) { return queries.startTrip(driverId,tripId); }
async function completeStop(driverId,tripId,stopId,body) { return queries.completeStop(driverId,tripId,stopId,body); }
async function verifyBoardingOtp(driverId,bookingId,code) { return queries.verifyBoardingOtp(driverId,bookingId,code,bcrypt.compare); }

module.exports = { recordTelemetry, setAvailability, getAvailability, getAssignedTrips, arriveAtStop, startTrip, completeStop, verifyBoardingOtp,getServiceMode,setServiceMode,getDriverCatalog,setActiveZone };
