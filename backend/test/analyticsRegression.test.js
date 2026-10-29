const test = require("node:test");
const assert = require("node:assert/strict");
const {
    parseCsv, prepareTrainingData, deterministicSplit, solveLeastSquares, fitModel,
    predictModel, evaluateModel, trainTarget, featureVector
} = require("../src/modules/dashboard/analyticsRegression");
const { validateScenario } = require("../src/modules/dashboard/analyticsService");
const { isPeakAt } = require("../src/modules/drt/services/operatingPolicy");

const policy = {
    timezone: "Asia/Kolkata",
    operating_days: [1, 2, 3, 4, 5, 6, 7],
    peak_periods: [{ start: "07:00", end: "10:00" }, { start: "16:30", end: "20:30" }]
};

function makeTrainingRows(count = 40) {
    return Array.from({ length: count }, (_, index) => {
        const day = 1 + Math.floor(index / 8);
        const hour = (index * 7) % 24;
        const minute = (index * 13) % 60;
        const at = new Date(Date.UTC(2025, 0, day, hour - 5, minute - 30));
        const direction = index % 2 ? "R2M" : "M2R";
        const distance = 1 + (index % 17) * 0.7;
        const peakTime = isPeakAt(at, policy);
        const features = featureVector({ distanceKm: distance, at, direction, isPeak: peakTime, timezone: policy.timezone });
        const directionCode = direction === "R2M" ? 1 : 0;
        const hourComponent = features[1] * 2 + features[2] * 3;
        return {
            tripId: "trip-" + String(Math.floor(index / 4)).padStart(2, "0"),
            bookingId: "booking-" + index,
            features,
            target: 25 + distance * 2.2 + peakTime * 4 + directionCode * 3 + hourComponent
        };
    });
}

test("CSV parser handles quoted commas, escaped quotes, and embedded newlines", () => {
    const parsed = parseCsv('id,note\r\n1,"Fare, ""peak"""\r\n2,"two\nlines"\r\n');
    assert.equal(parsed.rows.length, 2);
    assert.equal(parsed.rows[0].note, 'Fare, "peak"');
    assert.equal(parsed.rows[1].note, "two\nlines");
    assert.throws(() => parseCsv('id,note\n1,"unterminated'), /unterminated/i);
    assert.throws(() => parseCsv('id,note\n1,un"quoted'), /quote/i);
});

test("fare uses a valid final fare first and falls back to fare_amount", () => {
    const csv = "booking_id,trip_id,direction,distance_km,requested_at_utc,fare_amount,final_fare,fare_currency,booking_status,boarded_at_utc,booking_completed_at_utc,cab_duration_seconds,trip_duration_seconds\n" +
        "b1,t1,R2M,4,2025-01-06T02:00:00Z,62.50,71.25,INR,COMPLETED,2025-01-06T02:30:00Z,2025-01-06T02:42:00Z,,99999\n" +
        "b2,t2,M2R,5,2025-01-06T02:00:00Z,80,bad,INR,FAILED,,,,99999\n";
    const prepared = prepareTrainingData(parseCsv(csv).rows, policy);
    assert.deepEqual(prepared.fareRows.map(row => row.target), [71.25, 80]);
    assert.equal(prepared.fareFallbackRows, 1);
    assert.equal(prepared.durationRows.length, 1);
    assert.equal(prepared.durationRows[0].target, 12);
    assert.equal(prepared.durationDerivedRows, 1);
    assert.equal(prepared.durationExcluded.booking_not_completed, 1);
});

test("duration training excludes incomplete bookings and never uses trip duration as target", () => {
    const row = {
        booking_id: "b1", trip_id: "t1", booking_status: "COMPLETED", direction: "R2M",
        distance_km: "3", requested_at_utc: "2025-01-06T02:00:00Z", fare_amount: "40", fare_currency: "INR",
        boarded_at_utc: "2025-01-06T02:30:00Z", booking_completed_at_utc: "2025-01-06T02:40:00Z",
        cab_duration_seconds: "0", trip_duration_seconds: "9000"
    };
    const incomplete = { ...row, booking_id: "b2", trip_id: "t2", booking_status: "NO_SHOW", boarded_at_utc: "", booking_completed_at_utc: "", cab_duration_seconds: "", trip_duration_seconds: "9000" };
    const prepared = prepareTrainingData([row, incomplete], policy);
    assert.equal(prepared.durationRows.length, 1);
    assert.equal(prepared.durationRows[0].target, 10);
    assert.equal(prepared.durationExcluded.booking_not_completed, 1);
});

test("multiple regression solves a controlled least-squares line safely", () => {
    const coefficients = solveLeastSquares([[1, 1], [1, 2], [1, 3], [1, 4]], [5, 8, 11, 14]);
    assert.ok(Math.abs(coefficients[0] - 2) < 1e-9);
    assert.ok(Math.abs(coefficients[1] - 3) < 1e-9);
    assert.equal(solveLeastSquares([[1, 1], [1, 1]], [2, 2]), null);
});

test("model fits controlled rows and predicts finite values", () => {
    const rows = makeTrainingRows();
    const model = fitModel(rows);
    assert.equal(model.status, "READY");
    const prediction = predictModel(model, rows[0].features);
    assert.ok(Number.isFinite(prediction));
    assert.ok(prediction >= 0);
});

test("grouped evaluation split is deterministic and never leaks a trip", () => {
    const rows = makeTrainingRows();
    const first = deterministicSplit(rows), second = deterministicSplit(rows);
    assert.deepEqual(first.validation.map(row => row.tripId), second.validation.map(row => row.tripId));
    const trainTrips = new Set(first.train.map(row => row.tripId));
    assert.equal(first.validation.some(row => trainTrips.has(row.tripId)), false);
});

test("MAE and RMSE use held-out observations and R-squared is conditional", () => {
    const model = { status: "READY", means: [0, 0, 0, 0, 0, 0], scales: [1, 1, 1, 1, 1, 1], coefficients: [0, 1, 0, 0, 0, 0, 0] };
    const metrics = evaluateModel(model, [
        { features: [1, 0, 0, 0, 0, 0], target: 1 },
        { features: [2, 0, 0, 0, 0, 0], target: 3 }
    ]);
    assert.equal(metrics.mae, 0.5);
    assert.equal(metrics.rmse, Math.sqrt(0.5));
    assert.equal(metrics.rSquared, 0.5);
    const constant = evaluateModel(model, [
        { features: [1, 0, 0, 0, 0, 0], target: 1 },
        { features: [2, 0, 0, 0, 0, 0], target: 1 }
    ]);
    assert.equal(constant.rSquared, null);
});

test("training reports insufficient rows and detects rank-deficient features", () => {
    assert.equal(trainTarget(makeTrainingRows(12)).status, "INSUFFICIENT_TRAINING_DATA");
    const constant = Array.from({ length: 24 }, (_, index) => ({
        tripId: "trip-" + Math.floor(index / 3), bookingId: "b-" + index, target: 20 + index,
        features: [4, 0.5, 0.5, 0, 0, 0]
    }));
    assert.equal(trainTarget(constant).status, "RANK_DEFICIENT");
});

test("scenario validation rejects invalid distance, direction, time, and period mismatch", () => {
    const base = { direction: "R2M", distanceKm: 3, departureAt: "2025-01-06T03:00:00Z" };
    assert.throws(() => validateScenario({ ...base, distanceKm: 0 }, policy), /distance/i);
    assert.throws(() => validateScenario({ ...base, direction: "OTHER" }, policy), /direction/i);
    assert.throws(() => validateScenario({ ...base, departureAt: "not-a-date" }, policy), /departure/i);
    assert.throws(() => validateScenario({ ...base, period: "OFFPEAK" }, policy), /does not match/i);
});

test("features encode direction and configured rush-hour periods", () => {
    const peakTime = new Date("2025-01-06T03:00:00Z");
    const offpeakTime = new Date("2025-01-06T07:00:00Z");
    const peakR2m = featureVector({ distanceKm: 5, at: peakTime, direction: "R2M", isPeak: true, timezone: policy.timezone });
    const peakM2r = featureVector({ distanceKm: 5, at: peakTime, direction: "M2R", isPeak: true, timezone: policy.timezone });
    const offpeakR2m = featureVector({ distanceKm: 5, at: offpeakTime, direction: "R2M", isPeak: false, timezone: policy.timezone });
    assert.equal(peakR2m[3], 1);
    assert.equal(peakR2m[4], 1);
    assert.equal(peakM2r[4], 0);
    assert.equal(offpeakR2m[3], 0);
    assert.equal(peakR2m[5], 5);
    assert.equal(offpeakR2m[5], 0);
});
