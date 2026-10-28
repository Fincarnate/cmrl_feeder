const bookingService = require("../services/bookingService");
const queries = require("../queries/bookingQueries");
const scheduleQueries = require("../queries/scheduleQueries");

function userId(request) { return request.identity.userId || request.identity.identityId; }

async function serviceAreas(request, reply) {
    try { return reply.send(await queries.getServiceAreas()); }
    catch(error) { request.log.error(error); return reply.code(500).send({message:"Unable to load service areas."}); }
}

async function previewFare(request, reply) {
    try { return reply.send(await bookingService.previewFare(request.body || {})); }
    catch(error) { if(!error.statusCode)request.log.error(error); return reply.code(error.statusCode || 500).send({message:error.statusCode?error.message:"Unable to calculate fare."}); }
}

async function resolveLocation(request, reply) {
    try { return reply.send(await bookingService.resolveLocation(request.body || {})); }
    catch(error) { return reply.code(error.statusCode || 500).send({message:error.statusCode?error.message:"Unable to validate this location."}); }
}

async function createBooking(request, reply) {
    try {
        const input={...(request.body||{}),idempotencyKey:request.headers["idempotency-key"]};
        if(input.bookingIntent!=="DIRECT"){
            const schedule=await bookingService.createRecurringSchedule(userId(request),{...input,bookingIntent:"BOOKING"});
            return reply.code(201).send({schedule});
        }
        const booking = await bookingService.createBooking(userId(request),input);
        return reply.code(201).send({booking:await queries.getMyBooking(userId(request),booking.booking_id)||booking});
    } catch(error) {
        if (!error.statusCode) request.log.error(error);
        return reply.code(error.statusCode || 500).send({message:error.statusCode?error.message:"Unable to create booking."});
    }
}

async function createSchedule(request,reply){
    try{
        const schedule=await bookingService.createRecurringSchedule(userId(request),{...(request.body||{}),
            bookingIntent:"BOOKING",idempotencyKey:request.headers["idempotency-key"]});
        return reply.code(201).send({schedule});
    }catch(error){if(!error.statusCode)request.log.error(error);return reply.code(error.statusCode||500).send({message:error.statusCode?error.message:"Unable to create recurring schedule."});}
}

async function listSchedules(request,reply){
    try{return reply.send({schedules:await scheduleQueries.listMySchedules(userId(request))});}
    catch(error){request.log.error(error);return reply.code(500).send({message:"Unable to load recurring schedules."});}
}

async function cancelSchedule(request,reply){
    try{
        bookingService.validateBookingId(request.params.id);
        const schedule=await scheduleQueries.cancelSchedule(userId(request),request.params.id);
        if(!schedule)return reply.code(404).send({message:"Recurring schedule was not found."});
        return reply.send({schedule});
    }catch(error){return reply.code(error.statusCode||500).send({message:error.statusCode?error.message:"Unable to cancel recurring schedule."});}
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

module.exports = { serviceAreas, resolveLocation, previewFare, createBooking, createSchedule, listSchedules, cancelSchedule, listBookings, getBooking, cancelBooking, getOtp };
