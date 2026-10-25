const pool = require("../../../db/pool");
const { calculateFare } = require("../services/fareCalculator");

async function activeFare(client = pool, lock = false) {
    const result = await client.query(`SELECT * FROM drt_fare_policy WHERE is_active = TRUE ORDER BY version DESC LIMIT 1${lock ? " FOR SHARE" : ""}`);
    if (!result.rows[0]) throw Object.assign(new Error("Fare policy is not configured."), { statusCode: 503 });
    return result.rows[0];
}

async function activeOperating(client = pool, lock = false) {
    const result = await client.query(`SELECT * FROM drt_operating_policy WHERE is_active = TRUE ORDER BY version DESC LIMIT 1${lock ? " FOR SHARE" : ""}`);
    if (!result.rows[0]) throw Object.assign(new Error("Operating policy is not configured."), { statusCode: 503 });
    return result.rows[0];
}

async function listPolicies() {
    const [fare, operating] = await Promise.all([activeFare(), activeOperating()]);
    return { fare, operating };
}

async function updateFare(input) {
    const current = await activeFare();
    const values = {
        currency: input.currency ?? current.currency,
        baseFare: input.baseFare ?? current.base_fare,
        perKmRate: input.perKmRate ?? current.per_km_rate,
        minimumFare: input.minimumFare ?? current.minimum_fare,
        bookingFee: input.bookingFee ?? current.booking_fee,
        peakMultiplier: input.peakMultiplier ?? current.peak_multiplier,
        offpeakMultiplier: input.offpeakMultiplier ?? current.offpeak_multiplier,
        directionRates: input.directionRates ?? current.direction_rates
    };
    const positive = [values.baseFare, values.perKmRate, values.minimumFare, values.bookingFee];
    if (!/^[A-Z]{3}$/.test(values.currency) || positive.some(value => !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(String(value))) ||
        Number(values.peakMultiplier) <= 0 || !Number.isFinite(Number(values.peakMultiplier)) ||
        Number(values.offpeakMultiplier) <= 0 || !Number.isFinite(Number(values.offpeakMultiplier)) ||
        !values.directionRates || typeof values.directionRates !== "object" || Array.isArray(values.directionRates)) {
        throw Object.assign(new Error("Fare policy fields contain invalid values."), { statusCode: 400 });
    }
    try {
        for (const direction of Object.keys(values.directionRates)) {
            if (!["RESIDENTIAL_TO_METRO","METRO_TO_RESIDENTIAL"].includes(direction)) throw new Error("Unknown fare direction.");
            calculateFare({distanceKm:1,policy:{version:1,currency:values.currency,base_fare:values.baseFare,per_km_rate:values.perKmRate,minimum_fare:values.minimumFare,booking_fee:values.bookingFee,peak_multiplier:values.peakMultiplier,offpeak_multiplier:values.offpeakMultiplier,direction_rates:values.directionRates},direction,isPeak:false});
        }
    } catch(error) { throw Object.assign(new Error(error.message),{statusCode:400}); }
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('drt-fare-policy'))");
        const latest = await activeFare(client, true);
        await client.query("UPDATE drt_fare_policy SET is_active=FALSE WHERE is_active=TRUE");
        const result = await client.query(
            `INSERT INTO drt_fare_policy(version,currency,base_fare,per_km_rate,minimum_fare,booking_fee,peak_multiplier,offpeak_multiplier,direction_rates)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *`,
            [Number(latest.version) + 1, values.currency, values.baseFare, values.perKmRate, values.minimumFare, values.bookingFee, values.peakMultiplier, values.offpeakMultiplier, JSON.stringify(values.directionRates)]
        );
        await client.query("COMMIT");
        return result.rows[0];
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
}

async function updateOperating(input) {
    const current = await activeOperating();
    const value = {
        timezone: input.timezone ?? current.timezone,
        operatingDays: input.operatingDays ?? current.operating_days,
        peakPeriods: input.peakPeriods ?? current.peak_periods,
        peakDispatch: input.peakDispatchWaitMinutes ?? current.peak_dispatch_wait_minutes,
        offpeakDispatch: input.offpeakDispatchWaitMinutes ?? current.offpeak_dispatch_wait_minutes,
        peakGrace: input.peakBoardingGraceMinutes ?? current.peak_boarding_grace_minutes,
        offpeakGrace: input.offpeakBoardingGraceMinutes ?? current.offpeak_boarding_grace_minutes,
        otpValidity: input.otpValidityMinutes ?? current.otp_validity_minutes,
        otpAttempts: input.otpMaxAttempts ?? current.otp_max_attempts,
        locationAge: input.driverLocationMaxAgeSeconds ?? current.driver_location_max_age_seconds,
        minimumPassengers: input.minimumDispatchPassengers ?? current.minimum_dispatch_passengers,
        maximumCapacity: input.maximumVehicleCapacity ?? current.maximum_vehicle_capacity,
        retryMinutes: input.dispatchRetryMinutes ?? current.dispatch_retry_minutes,
        maxAttempts: input.dispatchMaxAttempts ?? current.dispatch_max_attempts
    };
    const positive = [value.peakDispatch,value.offpeakDispatch,value.peakGrace,value.offpeakGrace,value.otpValidity,value.otpAttempts,value.locationAge,value.minimumPassengers,value.maximumCapacity,value.retryMinutes,value.maxAttempts];
    if (!value.timezone || !Array.isArray(value.operatingDays) || value.operatingDays.some(day => !Number.isInteger(day) || day < 1 || day > 7) ||
        positive.some(number => !Number.isInteger(Number(number)) || Number(number) <= 0) || !Array.isArray(value.peakPeriods)) {
        throw Object.assign(new Error("Operating policy fields contain invalid values."), { statusCode: 400 });
    }
    try {
        new Intl.DateTimeFormat("en", { timeZone: value.timezone });
        for (const interval of value.peakPeriods) {
            require("../services/operatingPolicy").minuteOfDay(interval.start, "Peak start");
            require("../services/operatingPolicy").minuteOfDay(interval.end, "Peak end");
            if (interval.start === interval.end) throw new Error("Peak interval cannot have identical boundaries.");
        }
    } catch (error) { throw Object.assign(new Error(error.message || "Invalid operating policy."), { statusCode: 400 }); }
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('drt-operating-policy'))");
        const latest = await activeOperating(client, true);
        await client.query("UPDATE drt_operating_policy SET is_active=FALSE WHERE is_active=TRUE");
        const result = await client.query(
            `INSERT INTO drt_operating_policy(version,timezone,operating_days,peak_periods,peak_dispatch_wait_minutes,offpeak_dispatch_wait_minutes,peak_boarding_grace_minutes,offpeak_boarding_grace_minutes,otp_validity_minutes,otp_max_attempts,driver_location_max_age_seconds,minimum_dispatch_passengers,maximum_vehicle_capacity,dispatch_retry_minutes,dispatch_max_attempts)
             VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
            [Number(latest.version)+1,value.timezone,value.operatingDays,JSON.stringify(value.peakPeriods),value.peakDispatch,value.offpeakDispatch,value.peakGrace,value.offpeakGrace,value.otpValidity,value.otpAttempts,value.locationAge,value.minimumPassengers,value.maximumCapacity,value.retryMinutes,value.maxAttempts]
        );
        await client.query("COMMIT"); return result.rows[0];
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
}

module.exports = { activeFare, activeOperating, listPolicies, updateFare, updateOperating };
