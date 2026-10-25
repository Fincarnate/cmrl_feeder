const bookingService = require("../services/bookingService");
const queries = require("../queries/bookingQueries");

function userId(request) { return request.identity.userId || request.identity.identityId; }

async function serviceAreas(request, reply) {
    try { return reply.send(await queries.getServiceAreas()); }
    catch(error) { request.log.error(error); return reply.code(500).send({message:"Unable to load service areas."}); }
}

async function previewFare(request, reply) {
    try { return reply.send(await bookingService.previewFare(request.body || {})); }
    catch(error) { return reply.code(error.statusCode || 500).send({message:error.statusCode?error.message:"Unable to calculate fare."}); }
}

async function createBooking(request, reply) {
    try {
        const booking = await bookingService.createBooking(userId(request),{...(request.body||{}),idempotencyKey:request.headers["idempotency-key"]});
        return reply.code(201).send({booking});
    } catch(error) {
        if (!error.statusCode) request.log.error(error);
        return reply.code(error.statusCode || 500).send({message:error.statusCode?error.message:"Unable to create booking."});
    }
}

async function listBookings(request, reply) {
    try { return reply.send({bookings:await queries.listMyBookings(userId(request))}); }
    catch(error) { request.log.error(error); return reply.code(500).send({message:"Unable to load bookings."}); }
}

async function getBooking(request, reply) {
    try {
        bookingService.validateBookingId(request.params.id);
        const booking = await queries.getMyBooking(userId(request),request.params.id);
        if (!booking) return reply.code(404).send({message:"Booking was not found."});
        return reply.send({booking});
    } catch(error) { return reply.code(error.statusCode || 500).send({message:error.statusCode?error.message:"Unable to load booking."}); }
}

async function cancelBooking(request, reply) {
    try {
        bookingService.validateBookingId(request.params.id);
        const booking = await queries.cancelMyBooking(userId(request),request.params.id);
        if (!booking) return reply.code(404).send({message:"Booking was not found."});
        return reply.send({booking});
    } catch(error) { return reply.code(error.statusCode || 500).send({message:error.statusCode?error.message:"Unable to cancel booking."}); }
}

async function getOtp(request, reply) {
    try { return reply.send(await bookingService.getOwnOtp(userId(request),request.params.id)); }
    catch(error) { return reply.code(error.statusCode || 500).send({message:error.statusCode?error.message:"Unable to retrieve boarding OTP."}); }
}

module.exports = { serviceAreas, previewFare, createBooking, listBookings, getBooking, cancelBooking, getOtp };
