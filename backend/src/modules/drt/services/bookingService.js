const pool = require("../../../db/pool");
const policyQueries = require("../queries/policyQueries");
const bookingQueries = require("../queries/bookingQueries");
const { calculateFare, straightLineDistanceKm } = require("./fareCalculator");
const { snapshotFor } = require("./operatingPolicy");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const config = require("../../../config/env");
const driverQueries = require("../../../db/queries/driverQueries");
const scheduleQueries = require("../queries/scheduleQueries");

const DIRECTIONS = ["RESIDENTIAL_TO_METRO", "METRO_TO_RESIDENTIAL"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAILY_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function invalid(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

function originCoordinates(input) {
    return (input.originLocationSource || "MANUAL") === "GPS"
        ? { latitude:input.latitude,longitude:input.longitude }
        : { latitude:null,longitude:null };
}

function validateIdentifiers(input) {
    if (!DIRECTIONS.includes(input.direction)) throw invalid("Unsupported travel direction.");
    for (const field of ["stationId", "zoneId", "servicePointId"]) if (typeof input[field] !== "string" || !UUID.test(input[field])) throw invalid(`${field} must be a valid ID.`);
    const seats = input.seatsRequested ?? 1;
    if (!Number.isInteger(seats) || seats < 1 || seats > 8) throw invalid("seatsRequested must be from 1 to 8.");
    if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 100)) throw invalid("Idempotency-Key must be 8 to 100 characters.");
    if (input.bookingIntent !== undefined && !["BOOKING", "DIRECT"].includes(input.bookingIntent)) throw invalid("Unsupported booking intent.");
    if (input.originLocationSource !== undefined && !["GPS", "MANUAL"].includes(input.originLocationSource)) throw invalid("Unsupported location source.");
    if ((input.originLocationSource || "MANUAL") === "GPS") {
        if (!Number.isFinite(input.latitude) || input.latitude < -90 || input.latitude > 90 || !Number.isFinite(input.longitude) || input.longitude < -180 || input.longitude > 180) throw invalid("Valid GPS coordinates are required.");
    }
    return seats;
}

async function loadContext(client, input) {
    const context = await bookingQueries.getJourneyContext(client, input);
    if (!context) throw invalid("The selected station, zone, and service point are outside the active service area.", 422);
    return context;
}

async function buildQuote(client, input, options = {}) {
    const context = await loadContext(client, input);
    const source = input.originLocationSource || "MANUAL";
    if (source === "GPS") {
        const resolution = await bookingQueries.resolvePassengerLocation(client, { direction: input.direction, latitude: input.latitude, longitude: input.longitude });
        if (input.direction === "RESIDENTIAL_TO_METRO") {
            if (resolution.result === "UNAVAILABLE") throw invalid("Feeder service is unavailable because there are no configured residential service points.", 422);
            if (resolution.result === "IN_ZONE" && !(resolution.containingZones || []).some(zone => zone.zone_id === input.zoneId)) throw invalid("The selected residential zone does not contain your verified location.", 422);
            if (resolution.result === "NEARBY_RECOMMENDATION" && (resolution.zone_id !== input.zoneId || resolution.point_id !== input.servicePointId || !input.pickupAcknowledged)) throw invalid("Confirm the suggested pickup point before continuing.", 422);
        } else {
            const supported = (resolution.stations || []).some(station => station.station_id === input.stationId);
            if (!supported) throw invalid("Your verified location is outside every supported metro station boundary.", 422);
        }
    }
    const point = context.point_geometry.coordinates;
    const station = context.station_geometry.coordinates;
    const pointCoordinates = { latitude: Number(point[1]), longitude: Number(point[0]) };
    const stationCoordinates = { latitude: Number(station[1]), longitude: Number(station[0]) };
    const distanceKm = straightLineDistanceKm(pointCoordinates, stationCoordinates);
    const nowResult = await client.query("SELECT clock_timestamp() AS authoritative_now");
    const farePolicy = await policyQueries.activeFare(client, true);
    const operatingPolicy = await policyQueries.activeOperating(client, true);
    let scheduledAt = options.scheduledAt || null;
    const schedulingTimezone = options.timezone || operatingPolicy.timezone || "Asia/Kolkata";
    if (!scheduledAt && input.dailyDepartureTime && DAILY_TIME.test(input.dailyDepartureTime)) {
        const next = await scheduleQueries.nextDeparture(client,input.dailyDepartureTime,schedulingTimezone);
        scheduledAt = next?.departure_at || null;
    }
    const policyForSchedule = scheduledAt ? { ...operatingPolicy, timezone:schedulingTimezone } : operatingPolicy;
    const effectivePolicy = snapshotFor(scheduledAt || nowResult.rows[0].authoritative_now, policyForSchedule);
    const fare = calculateFare({ distanceKm, policy: farePolicy, direction: input.direction, isPeak: effectivePolicy.period === "PEAK" });
    return { context, fare, effectivePolicy, farePolicy, authoritativeNow: nowResult.rows[0].authoritative_now, scheduledAt, schedulingTimezone };
}

async function resolveLocation(input) {
    if (!DIRECTIONS.includes(input.direction)) throw invalid("Unsupported travel direction.");
    const latitude = input.latitude, longitude = input.longitude;
    if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
        || typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw invalid("Valid latitude and longitude are required.");
    const client = await pool.connect();
    try { return await bookingQueries.resolvePassengerLocation(client, { direction: input.direction, latitude, longitude }); }
    finally { client.release(); }
}

async function previewFare(input) {
    validateIdentifiers(input);
    if (input.bookingIntent === "BOOKING" && !DAILY_TIME.test(input.dailyDepartureTime || "")) throw invalid("Choose a valid daily departure time in HH:MM format.");
    const client = await pool.connect();
    try {
        const { fare, context, scheduledAt } = await buildQuote(client, input);
        const coordinates=originCoordinates(input);
        const expiresAt = Date.now() + 5 * 60 * 1000;
        const quoteData = { direction: input.direction, stationId: input.stationId, zoneId: input.zoneId,
            servicePointId: input.servicePointId, seatsRequested: input.seatsRequested ?? 1,
            bookingIntent: input.bookingIntent || "BOOKING", originLocationSource: input.originLocationSource || "MANUAL",
            latitude: coordinates.latitude, longitude: coordinates.longitude, pickupAcknowledged: Boolean(input.pickupAcknowledged),
            dailyDepartureTime: input.dailyDepartureTime ?? null, scheduledAt: scheduledAt ? new Date(scheduledAt).getTime() : null,
            fare: fare.fare, policyVersion: fare.policyVersion, expiresAt };
        const payload = Buffer.from(JSON.stringify(quoteData)).toString("base64url");
        const signature = crypto.createHmac("sha256", config.jwt.secret).update(payload).digest("base64url");
        return { ...fare, quoteToken: `${payload}.${signature}`, expiresAt: new Date(expiresAt).toISOString(),
            stationName: context.station_name, zoneName: context.zone_name, servicePointName: context.point_name,
            scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null };
    }
    finally { client.release(); }
}

function validateQuoteToken(input, fare, scheduledAt = null) {
    if (typeof input.quoteToken !== "string") throw invalid("Fare quote is missing. Refresh the fare before confirming.", 409);
    const [payload, signature] = input.quoteToken.split(".");
    if (!payload || !signature) throw invalid("Fare quote is invalid. Refresh the fare before confirming.", 409);
    const expected = crypto.createHmac("sha256", config.jwt.secret).update(payload).digest();
    let supplied;
    try { supplied = Buffer.from(signature, "base64url"); } catch { throw invalid("Fare quote is invalid.", 409); }
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) throw invalid("Fare quote is invalid. Refresh the fare before confirming.", 409);
    let quote;
    try { quote = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw invalid("Fare quote is invalid.", 409); }
    const keys = ["direction", "stationId", "zoneId", "servicePointId"];
    const coordinates=originCoordinates(input);
    if (keys.some(key => quote[key] !== input[key]) || Number(quote.seatsRequested) !== Number(input.seatsRequested ?? 1)
        || quote.bookingIntent !== (input.bookingIntent || "BOOKING") || quote.originLocationSource !== (input.originLocationSource || "MANUAL")
        || quote.latitude !== coordinates.latitude || quote.longitude !== coordinates.longitude
        || quote.dailyDepartureTime !== (input.dailyDepartureTime ?? null)
        || quote.scheduledAt !== (scheduledAt ? new Date(scheduledAt).getTime() : null)
        || quote.pickupAcknowledged !== Boolean(input.pickupAcknowledged) || quote.expiresAt < Date.now()
        || quote.fare !== fare.fare || quote.policyVersion !== fare.policyVersion) {
        throw invalid("Fare quote has expired or no longer matches this journey. Preview the fare again.", 409);
    }
}

async function createDirectTrip(client, input, context, policy, seats) {
    const eligible = await client.query(`
      SELECT d.driver_id,v.vehicle_id,v.max_capacity
      FROM driver d JOIN vehicle v ON v.driver_id=d.driver_id
      WHERE d.is_online=TRUE AND UPPER(COALESCE(d.shift_status,'')) IN ('AVAILABLE','ONLINE')
        AND (CASE UPPER(TRIM(d.current_service_mode)) WHEN 'R2M' THEN 'RESIDENTIAL_TO_METRO'
          WHEN 'M2R' THEN 'METRO_TO_RESIDENTIAL' ELSE UPPER(TRIM(d.current_service_mode)) END)=$5
        AND d.current_location IS NOT NULL
        AND d.location_accuracy_m IS NOT NULL AND d.location_accuracy_m<=$4
        AND d.location_recorded_at>clock_timestamp()-($1::int*interval '1 second')
        AND v.is_active=TRUE AND COALESCE(v.is_frozen_until,FALSE)=FALSE
        AND v.max_capacity >= $2 AND v.max_capacity <= $3
        AND NOT EXISTS(SELECT 1 FROM trip x WHERE (x.driver_id=d.driver_id OR x.vehicle_id=v.vehicle_id) AND x.trip_status IN ('DISPATCHED','IN_PROGRESS'))
      ORDER BY v.max_capacity,d.driver_id FOR UPDATE OF d,v SKIP LOCKED LIMIT 1
    `, [Number(policy.driverLocationMaxAgeSeconds || 90), seats, Number(policy.maximumVehicleCapacity),
        Number(config.drtStopArrivalRadiusM),input.direction]);
    const assignment = eligible.rows[0];
    if (!assignment) throw invalid("No immediately eligible driver and vehicle are available for this direction. A driver must be online with the matching service mode, a fresh accurate location, and an active unfrozen vehicle with enough seats. Choose Booking to join the shared dispatch queue, or cancel.", 409);
    const tripResult = await client.query(`
      INSERT INTO trip(zone_id,station_id,trip_direction,trip_status,dispatch_started_at,dispatched_at,
        dispatch_policy,available_seats,driver_id,vehicle_id,seat_capacity)
      VALUES($1,$2,$3,'DISPATCHED',clock_timestamp(),clock_timestamp(),$4::jsonb,$5,$6,$7,$8) RETURNING trip_id
    `, [context.zone_id,context.station_id,input.direction,JSON.stringify(policy),Number(assignment.max_capacity)-seats,
        assignment.driver_id,assignment.vehicle_id,assignment.max_capacity]);
    await client.query("UPDATE driver SET shift_status='BUSY' WHERE driver_id=$1", [assignment.driver_id]);
    return { tripId: tripResult.rows[0].trip_id, driverId: assignment.driver_id, vehicleId: assignment.vehicle_id, capacity: assignment.max_capacity };
}

async function createDirectStops(client, tripId, direction, stationId, servicePointId) {
    if (direction === "METRO_TO_RESIDENTIAL") {
        await client.query("INSERT INTO trip_stop_sequence(trip_id,station_id,stop_sequence,stop_status,stop_type) VALUES($1,$2,1,'PENDING','STATION')", [tripId,stationId]);
        await client.query("INSERT INTO trip_stop_sequence(trip_id,point_id,stop_sequence,stop_status,stop_type) VALUES($1,$2,2,'PENDING','SERVICE_POINT')", [tripId,servicePointId]);
    } else {
        await client.query("INSERT INTO trip_stop_sequence(trip_id,point_id,stop_sequence,stop_status,stop_type) VALUES($1,$2,1,'PENDING','SERVICE_POINT')", [tripId,servicePointId]);
        await client.query("INSERT INTO trip_stop_sequence(trip_id,station_id,stop_sequence,stop_status,stop_type) VALUES($1,$2,2,'PENDING','STATION')", [tripId,stationId]);
    }
}

async function createBooking(userId, input) {
    const seats = validateIdentifiers(input);
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const booking = await createBookingInTransaction(client,userId,input,{seats});
        await client.query("COMMIT");
        return booking;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
}

async function createBookingInTransaction(client,userId,input,options={}) {
    const seats=options.seats ?? validateIdentifiers(input);
    if(input.idempotencyKey){
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`idempotency:${userId}:${input.idempotencyKey}`]);
        const existing=await bookingQueries.findIdempotentBooking(client,userId,input.idempotencyKey);
        if(existing)return existing;
    }
    const {context,fare,effectivePolicy,scheduledAt,schedulingTimezone}=await buildQuote(client,input,options);
    if(options.requireQuote!==false)validateQuoteToken(input,fare,scheduledAt);
    if(seats>effectivePolicy.maximumVehicleCapacity)throw invalid("Requested seats exceed the configured maximum vehicle capacity.");
    const bookingIntent=input.bookingIntent||"BOOKING";
    const trip=bookingIntent==="DIRECT"
      ? await createDirectTrip(client,input,context,effectivePolicy,seats)
      : await bookingQueries.getOrCreateWaitingTrip(client,{direction:input.direction,stationId:input.stationId,
        zoneId:context.zone_id,seats,policySnapshot:effectivePolicy,maxCapacity:effectivePolicy.maximumVehicleCapacity});
    const coordinates=originCoordinates(input);
    const booking=await bookingQueries.insertBooking(client,{userId,tripId:trip.tripId,servicePointId:context.point_id,seats,
        direction:input.direction,stationId:context.station_id,zoneId:context.zone_id,fare,idempotencyKey:input.idempotencyKey,
        bookingIntent,latitude:coordinates.latitude,longitude:coordinates.longitude,originLocationSource:input.originLocationSource||"MANUAL",
        pickupAcknowledged:input.pickupAcknowledged});
    if(bookingIntent==="DIRECT"){
        await client.query("UPDATE booking SET booking_status='ASSIGNED' WHERE booking_id=$1",[booking.booking_id]);
        await createDirectStops(client,trip.tripId,input.direction,context.station_id,context.point_id);
    }
    await client.query("INSERT INTO drt_engine_event(event_type,trip_id,booking_id,actor_role,details) VALUES('BOOKING_REQUESTED',$1,$2,'PASSENGER',$3::jsonb)",
        [trip.tripId,booking.booking_id,JSON.stringify({direction:input.direction,seats,bookingIntent,scheduledAt:scheduledAt||undefined,timezone:schedulingTimezone||undefined})]);
    if(bookingIntent==="DIRECT"){
        await client.query("INSERT INTO drt_engine_event(event_type,trip_id,booking_id,actor_role,details) VALUES('TRIP_DISPATCHED',$1,$2,'SYSTEM',$3::jsonb)",
            [trip.tripId,booking.booking_id,JSON.stringify({direct:true,driverId:trip.driverId,vehicleId:trip.vehicleId,capacity:trip.capacity})]);
        return {...booking,booking_status:"ASSIGNED",trip_status:"DISPATCHED",driver_id:trip.driverId,vehicle_id:trip.vehicleId};
    }
    return booking;
}

async function createRecurringSchedule(userId,input) {
    if(input.bookingIntent!=="BOOKING")throw invalid("Recurring schedules require the Booking option.");
    if(!DAILY_TIME.test(input.dailyDepartureTime||""))throw invalid("Choose a valid daily departure time in HH:MM format.");
    const seats=validateIdentifiers(input);
    const client=await pool.connect();
    try{
        await client.query("BEGIN");
        if(input.idempotencyKey){
            await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`schedule:${userId}:${input.idempotencyKey}`]);
            const existing=await scheduleQueries.findIdempotentSchedule(client,userId,input.idempotencyKey);
            if(existing){await client.query("COMMIT");return existing;}
        }
        const {fare,context,effectivePolicy,scheduledAt,schedulingTimezone}=await buildQuote(client,input);
        if(!scheduledAt)throw invalid("Unable to resolve the next daily departure. Refresh the fare and try again.",409);
        validateQuoteToken(input,fare,scheduledAt);
        if(seats>effectivePolicy.maximumVehicleCapacity)throw invalid("Requested seats exceed the configured maximum vehicle capacity.");
        const dateTime=await scheduleQueries.nextDeparture(client,input.dailyDepartureTime,schedulingTimezone);
        if(new Date(dateTime.departure_at).getTime()!==new Date(scheduledAt).getTime())throw invalid("The selected departure time has passed. Preview the fare again for the next departure.",409);
        const schedule=await scheduleQueries.insertSchedule(client,{userId,direction:input.direction,stationId:context.station_id,
            zoneId:context.zone_id,servicePointId:context.point_id,seats,dailyDepartureTime:input.dailyDepartureTime,
            timezone:schedulingTimezone,originLocationSource:input.originLocationSource||"MANUAL",
            pickupAcknowledged:Boolean(input.pickupAcknowledged),idempotencyKey:input.idempotencyKey,
            serviceDate:dateTime.service_date,departureAt:dateTime.departure_at});
        await client.query("INSERT INTO drt_engine_event(event_type,actor_role,details) VALUES('RECURRING_SCHEDULE_CREATED','PASSENGER',$1::jsonb)",
            [JSON.stringify({scheduleId:schedule.schedule_id,direction:input.direction,dailyDepartureTime:input.dailyDepartureTime,timezone:schedulingTimezone})]);
        await client.query("COMMIT");
        return schedule;
    }catch(error){await client.query("ROLLBACK");throw error;}
    finally{client.release();}
}

async function createScheduledOccurrence(client,schedule,scheduledAt,serviceDate) {
    const input={direction:schedule.direction,stationId:schedule.station_id,zoneId:schedule.zone_id,
        servicePointId:schedule.service_point_id,seatsRequested:Number(schedule.seats_reserved),bookingIntent:"BOOKING",
        originLocationSource:"MANUAL",latitude:null,longitude:null,pickupAcknowledged:schedule.pickup_acknowledged,
        idempotencyKey:`schedule:${schedule.schedule_id}:${serviceDate}`};
    validateIdentifiers(input);
    return createBookingInTransaction(client,schedule.user_id,input,{seats:Number(schedule.seats_reserved),requireQuote:false,
        scheduledAt,timezone:schedule.timezone});
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

module.exports = { previewFare, createBooking, createRecurringSchedule, createScheduledOccurrence, resolveLocation, validateBookingId, validateIdentifiers, getOwnOtp };
