const pool = require("../../../db/pool");
const policyQueries = require("../queries/policyQueries");
const bookingQueries = require("../queries/bookingQueries");
const { calculateFare, straightLineDistanceKm } = require("./fareCalculator");
const { snapshotFor } = require("./operatingPolicy");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const config = require("../../../config/env");
const driverQueries = require("../../../db/queries/driverQueries");

const DIRECTIONS = ["RESIDENTIAL_TO_METRO", "METRO_TO_RESIDENTIAL"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalid(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

function validateIdentifiers(input) {
    if (!DIRECTIONS.includes(input.direction)) throw invalid("Unsupported travel direction.");
    for (const field of ["stationId", "zoneId", "servicePointId"]) if (typeof input[field] !== "string" || !UUID.test(input[field])) throw invalid(`${field} must be a valid ID.`);
    const seats = input.seatsRequested ?? 1;
    if (!Number.isInteger(seats) || seats < 1 || seats > 8) throw invalid("seatsRequested must be from 1 to 8.");
    if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 100)) throw invalid("Idempotency-Key must be 8 to 100 characters.");
    return seats;
}

async function loadContext(client, input) {
    const context = await bookingQueries.getJourneyContext(client, input);
    if (!context) throw invalid("The selected station, zone, and service point are outside the active service area.", 422);
    return context;
}

async function buildQuote(client, input) {
    const context = await loadContext(client, input);
    const point = context.point_geometry.coordinates;
    const station = context.station_geometry.coordinates;
    const pointCoordinates = { latitude: Number(point[1]), longitude: Number(point[0]) };
    const stationCoordinates = { latitude: Number(station[1]), longitude: Number(station[0]) };
    const distanceKm = straightLineDistanceKm(pointCoordinates, stationCoordinates);
    const nowResult = await client.query("SELECT clock_timestamp() AS authoritative_now");
    const farePolicy = await policyQueries.activeFare(client, true);
    const operatingPolicy = await policyQueries.activeOperating(client, true);
    const effectivePolicy = snapshotFor(nowResult.rows[0].authoritative_now, operatingPolicy);
    const fare = calculateFare({ distanceKm, policy: farePolicy, direction: input.direction, isPeak: effectivePolicy.period === "PEAK" });
    return { context, fare, effectivePolicy, farePolicy, authoritativeNow: nowResult.rows[0].authoritative_now };
}

async function previewFare(input) {
    validateIdentifiers(input);
    const client = await pool.connect();
    try { return (await buildQuote(client, input)).fare; }
    finally { client.release(); }
}

async function createBooking(userId, input) {
    const seats = validateIdentifiers(input);
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        if (input.idempotencyKey) {
            await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`idempotency:${userId}:${input.idempotencyKey}`]);
            const existing = await bookingQueries.findIdempotentBooking(client, userId, input.idempotencyKey);
            if (existing) { await client.query("COMMIT"); return existing; }
        }
        const { context, fare, effectivePolicy } = await buildQuote(client, input);
        if (seats > effectivePolicy.maximumVehicleCapacity) throw invalid("Requested seats exceed the configured maximum vehicle capacity.");
        const trip = await bookingQueries.getOrCreateWaitingTrip(client, {
            direction: input.direction,
            stationId: input.stationId,
            zoneId: context.zone_id,
            seats,
            policySnapshot: effectivePolicy,
            maxCapacity: effectivePolicy.maximumVehicleCapacity
        });
        const booking = await bookingQueries.insertBooking(client, {
            userId, tripId: trip.tripId, servicePointId: context.point_id, seats,
            direction: input.direction, stationId: context.station_id, zoneId: context.zone_id,
            fare, idempotencyKey: input.idempotencyKey
        });
        await client.query("INSERT INTO drt_engine_event(event_type,trip_id,booking_id,actor_role,details) VALUES('BOOKING_REQUESTED',$1,$2,'PASSENGER',$3::jsonb)", [trip.tripId,booking.booking_id,JSON.stringify({direction:input.direction,seats})]);
        await client.query("COMMIT");
        return booking;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
}

function validateBookingId(value) { if (typeof value !== "string" || !UUID.test(value)) throw invalid("Booking ID is invalid."); }

async function getOwnOtp(userId, bookingId) {
    validateBookingId(bookingId);
    if (config.otpDeliveryMode !== "development") throw invalid("OTP delivery is not configured for this environment.", 503);
    const policy = await policyQueries.activeOperating();
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6,"0");
    const otpHash = await bcrypt.hash(code, 12);
    const result = await driverQueries.issueBoardingOtp(userId,bookingId,otpHash,Number(policy.otp_validity_minutes));
    if (result.error === "NOT_FOUND") throw invalid("Booking was not found.",404);
    if (result.error === "NOT_ELIGIBLE") throw invalid("OTP is available only after the driver confirms arrival.",409);
    if (result.error === "EXPIRED") throw invalid("The boarding deadline has expired.",409);
    return { otp:code,expiresAt:result.expiresAt,deliveryMode:"DEVELOPMENT_RETRIEVAL" };
}

module.exports = { previewFare, createBooking, validateBookingId, validateIdentifiers, getOwnOtp };
