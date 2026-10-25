const queries = require("../../db/queries/driverQueries");
const bcrypt = require("bcrypt");

async function recordTelemetry(driverId, input) {
    return queries.createTelemetry(driverId, input);
}

async function setAvailability(driverId, online) { return queries.setAvailability(driverId,online); }
async function getAvailability(driverId) { return queries.getAvailability(driverId); }
async function getAssignedTrips(driverId) { return queries.getAssignedTrips(driverId); }
async function arriveAtStop(driverId,tripId,stopId) { return queries.arriveAtStop(driverId,tripId,stopId); }
async function startTrip(driverId,tripId) { return queries.startTrip(driverId,tripId); }
async function completeStop(driverId,tripId,stopId) { return queries.completeStop(driverId,tripId,stopId); }
async function verifyBoardingOtp(driverId,bookingId,code) { return queries.verifyBoardingOtp(driverId,bookingId,code,bcrypt.compare); }

module.exports = { recordTelemetry, setAvailability, getAvailability, getAssignedTrips, arriveAtStop, startTrip, completeStop, verifyBoardingOtp };
