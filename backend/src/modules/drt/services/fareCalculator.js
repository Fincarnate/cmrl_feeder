const CURRENCY_SCALE = 2;

function toMinorUnits(value, field) {
    const text = String(value);
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(`${field} must be a non-negative amount with at most two decimals.`);
    const [whole, fraction = ""] = text.split(".");
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function formatMinorUnits(value) {
    const amount = typeof value === "bigint" ? value : BigInt(value);
    return `${amount / 100n}.${String(amount % 100n).padStart(2, "0")}`;
}

function multiplierScale(value) {
    const text = String(value);
    if (!/^\d+(?:\.\d{1,4})?$/.test(text) || Number(text) <= 0) throw new Error("Fare multiplier must be positive and have at most four decimals.");
    const [whole, fraction = ""] = text.split(".");
    return BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, "0"));
}

function calculateFare({ distanceKm, policy, direction, isPeak }) {
    if (!Number.isFinite(distanceKm) || distanceKm <= 0 || distanceKm > 500) throw new Error("Distance must be greater than 0 and no more than 500 km.");
    if (!policy || !Number.isInteger(Number(policy.version))) throw new Error("A valid fare policy is required.");
    const directional = policy.direction_rates?.[direction] || {};
    const base = toMinorUnits(directional.base_fare ?? policy.base_fare, "Base fare");
    const perKm = toMinorUnits(directional.per_km_rate ?? policy.per_km_rate, "Per-kilometre rate");
    const minimum = toMinorUnits(directional.minimum_fare ?? policy.minimum_fare, "Minimum fare");
    const fee = toMinorUnits(directional.booking_fee ?? policy.booking_fee, "Booking fee");
    const multiplier = multiplierScale(isPeak ? policy.peak_multiplier : policy.offpeak_multiplier);
    const distanceMicros = BigInt(Math.round(distanceKm * 1_000_000));
    const distanceFare = (perKm * distanceMicros + 500_000n) / 1_000_000n;
    const raw = base + distanceFare + fee;
    const adjusted = (raw * multiplier + 5_000n) / 10_000n;
    const total = adjusted > minimum ? adjusted : minimum;
    return {
        distanceKm: Number(distanceKm.toFixed(3)),
        distanceType: "ESTIMATED",
        distanceSource: "STRAIGHT_LINE_GEOGRAPHIC_ESTIMATE",
        currency: policy.currency || "INR",
        fare: formatMinorUnits(total),
        policyVersion: Number(policy.version),
        breakdown: {
            baseFare: formatMinorUnits(base),
            distanceFare: formatMinorUnits(distanceFare),
            bookingFee: formatMinorUnits(fee),
            multiplier: Number(multiplier) / 10000,
            minimumFareApplied: raw * multiplier < minimum * 10000n
        }
    };
}

function straightLineDistanceKm(a, b) {
    if (![a?.latitude, a?.longitude, b?.latitude, b?.longitude].every(Number.isFinite) ||
        Math.abs(a.latitude) > 90 || Math.abs(b.latitude) > 90 || Math.abs(a.longitude) > 180 || Math.abs(b.longitude) > 180) {
        throw new Error("Valid endpoint coordinates are required.");
    }
    const radians = degrees => degrees * Math.PI / 180;
    const dLat = radians(b.latitude - a.latitude);
    const dLon = radians(b.longitude - a.longitude);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
    return 6371.0088 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

module.exports = { calculateFare, straightLineDistanceKm, toMinorUnits, formatMinorUnits };
