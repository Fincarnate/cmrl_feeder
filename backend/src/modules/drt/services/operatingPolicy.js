function minuteOfDay(value, field) {
    if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error(`${field} must use HH:MM.`);
    const [hour, minute] = value.split(":").map(Number);
    return hour * 60 + minute;
}

function localParts(date, timeZone) {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(date);
    const get = type => parts.find(part => part.type === type)?.value;
    const weekdays = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    return { weekday: weekdays[get("weekday")], minute: Number(get("hour")) * 60 + Number(get("minute")) };
}

function isPeakAt(date, policy) {
    const { weekday, minute } = localParts(new Date(date), policy.timezone || "Asia/Kolkata");
    const days = policy.operating_days || [1, 2, 3, 4, 5, 6, 7];
    return (policy.peak_periods || []).some(window => {
        const start = minuteOfDay(window.start, "Peak start");
        const end = minuteOfDay(window.end, "Peak end");
        if (start === end) throw new Error("Peak interval start and end cannot be equal.");
        if (start < end) return days.includes(weekday) && minute >= start && minute < end;
        const previousWeekday = weekday === 1 ? 7 : weekday - 1;
        return (days.includes(weekday) && minute >= start) || (days.includes(previousWeekday) && minute < end);
    });
}

function snapshotFor(date, policy) {
    const peak = isPeakAt(date, policy);
    return {
        version: Number(policy.version),
        timezone: policy.timezone || "Asia/Kolkata",
        period: peak ? "PEAK" : "OFFPEAK",
        dispatchWaitMinutes: Number(peak ? policy.peak_dispatch_wait_minutes : policy.offpeak_dispatch_wait_minutes),
        boardingGraceMinutes: Number(peak ? policy.peak_boarding_grace_minutes : policy.offpeak_boarding_grace_minutes),
        otpValidityMinutes: Number(policy.otp_validity_minutes),
        otpMaxAttempts: Number(policy.otp_max_attempts),
        driverLocationMaxAgeSeconds: Number(policy.driver_location_max_age_seconds),
        minimumDispatchPassengers: Number(policy.minimum_dispatch_passengers),
        maximumVehicleCapacity: Number(policy.maximum_vehicle_capacity),
        dispatchRetryMinutes: Number(policy.dispatch_retry_minutes || 1),
        dispatchMaxAttempts: Number(policy.dispatch_max_attempts || 8)
    };
}

module.exports = { isPeakAt, snapshotFor, minuteOfDay, localParts };
