const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const analytics = require("../src/modules/dashboard/analyticsService");
const { parseCsv } = require("../src/modules/dashboard/analyticsRegression");

const policy = {
    timezone: "Asia/Kolkata",
    operating_days: [1, 2, 3, 4, 5, 6, 7],
    peak_periods: [{ start: "07:00", end: "10:00" }, { start: "16:30", end: "20:30" }]
};
const loadOperatingPolicy = async () => policy;

function csvRows(count = 40) {
    const header = [
        "booking_id", "trip_id", "booking_source", "booking_status", "trip_status", "direction", "seats_reserved",
        "requested_at_utc", "dispatched_at_utc", "driver_arrived_at_utc", "boarded_at_utc",
        "booking_completed_at_utc", "trip_completed_at_utc", "cab_duration_seconds", "trip_duration_seconds",
        "fare_amount", "final_fare", "fare_currency", "fare_breakdown_json", "distance_km",
        "distance_source", "fare_policy_version"
    ];
    const rows = [header.join(",")];
    for (let index = 0; index < count; index++) {
        const day = 1 + Math.floor(index / 8);
        const hour = (index * 7) % 24;
        const minute = (index * 13) % 60;
        const request = new Date(Date.UTC(2025, 0, day, hour - 5, minute - 30));
        const boarded = new Date(request.getTime() + 15 * 60_000);
        const complete = new Date(boarded.getTime() + (600 + index * 9) * 1000);
        const direction = index % 2 ? "RESIDENTIAL_TO_METRO" : "METRO_TO_RESIDENTIAL";
        const distance = (1 + (index % 17) * 0.7).toFixed(2);
        const fare = (24 + Number(distance) * 2.4 + (index % 3) * 1.5).toFixed(2);
        const values = [
            "booking-" + index, "trip-" + String(Math.floor(index / 4)).padStart(2, "0"), "SYNTHETIC",
            "COMPLETED", "COMPLETED", direction, "1", request.toISOString(), request.toISOString(),
            request.toISOString(), boarded.toISOString(), complete.toISOString(), complete.toISOString(),
            String((600 + index * 9)), String((1200 + index * 11)), fare, "", "INR",
            '{"note":"fare, peak"}', distance, "STRAIGHT_LINE_GEOGRAPHIC_ESTIMATE", "2"
        ];
        rows.push(values.map(value => '"' + String(value).replace(/"/g, '""') + '"').join(","));
    }
    return rows.join("\r\n") + "\r\n";
}

async function temporaryDirectory(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cmrl-analytics-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

test("missing, malformed, empty, and invalid-schema CSVs return clear dataset states", async t => {
    const directory = await temporaryDirectory(t);
    const missing = path.join(directory, "missing.csv");
    analytics.resetAnalyticsCache();
    const absent = await analytics.getAnalyticsEntry({ datasetPath: missing, loadOperatingPolicy });
    assert.equal(absent.response.dataset.status, "MISSING");
    assert.match(absent.response.dataset.message, /demo:export/i);

    const malformed = path.join(directory, "malformed.csv");
    await fs.writeFile(malformed, 'booking_id,note\n1,"bad');
    analytics.resetAnalyticsCache();
    const malformedResult = await analytics.getAnalyticsEntry({ datasetPath: malformed, loadOperatingPolicy });
    assert.equal(malformedResult.response.dataset.status, "INVALID_CSV");

    const empty = path.join(directory, "empty.csv");
    await fs.writeFile(empty, "booking_id,trip_id\r\n");
    analytics.resetAnalyticsCache();
    const emptyResult = await analytics.getAnalyticsEntry({ datasetPath: empty, loadOperatingPolicy });
    assert.equal(emptyResult.response.dataset.status, "INVALID_CSV");
    assert.match(emptyResult.response.dataset.message, /required columns/i);

    const headerOnly = path.join(directory, "header.csv");
    await fs.writeFile(headerOnly, csvRows(0));
    analytics.resetAnalyticsCache();
    const headerOnlyResult = await analytics.getAnalyticsEntry({ datasetPath: headerOnly, loadOperatingPolicy });
    assert.equal(headerOnlyResult.response.dataset.status, "EMPTY");
});

test("dataset path override must be a CSV file path", async () => {
    const selected = await analytics.selectDataset("C:/private/data.json");
    assert.match(selected.error, /\.csv/i);
});

test("dataset fingerprint cache reuses a fit until content changes, then retrains", async t => {
    const directory = await temporaryDirectory(t);
    const file = path.join(directory, "demo-trip-history.csv");
    await fs.writeFile(file, csvRows(40));
    analytics.resetAnalyticsCache();

    const first = await analytics.getAnalyticsEntry({ datasetPath: file, loadOperatingPolicy });
    assert.equal(first.response.dataset.totalRows, 40);
    assert.equal(first.response.models.fare.status, "READY");
    assert.equal(first.response.models.duration.status, "READY");
    assert.ok(Number.isFinite(first.response.models.fare.evaluation.mae));
    assert.ok(Number.isFinite(first.response.models.duration.evaluation.rmse));
    assert.equal(first.response.models.fare.evaluation.trainTrips + first.response.models.fare.evaluation.validationTrips, 10);
    const forecast = await analytics.predictScenario({
        direction: "R2M", distanceKm: 5, departureAt: "2025-01-06T03:00:00Z"
    }, { datasetPath: file, loadOperatingPolicy });
    assert.equal(forecast.scenario.period, "PEAK");
    assert.ok(forecast.predictions.fare.available);
    assert.ok(forecast.predictions.duration.available);
    assert.ok(forecast.predictions.duration.value > 0);
    assert.equal(forecast.predictions.duration.units, "minutes");

    const reused = await analytics.getAnalyticsEntry({ datasetPath: file, loadOperatingPolicy });
    assert.equal(reused.response.dataset.fingerprint, first.response.dataset.fingerprint);
    assert.equal(reused.response.training.trainedAt, first.response.training.trainedAt);

    await fs.writeFile(file, csvRows(44));
    const refreshed = await analytics.getAnalyticsEntry({ datasetPath: file, loadOperatingPolicy });
    assert.notEqual(refreshed.response.dataset.fingerprint, first.response.dataset.fingerprint);
    assert.equal(refreshed.response.dataset.totalRows, 44);
});

test("model-specific test cases use the trained models and policy-local time inputs", async t => {
    const directory = await temporaryDirectory(t);
    const file = path.join(directory, "demo-trip-history.csv");
    await fs.writeFile(file, csvRows(40));
    analytics.resetAnalyticsCache();
    const options = { datasetPath: file, loadOperatingPolicy };
    for (const modelType of ["fare", "duration"]) {
        const result = await analytics.predictScenario({
            modelType, direction: "R2M", distanceKm: 5, departureTime: "08:00"
        }, options);
        assert.equal(result.modelType, modelType);
        assert.equal(result.prediction.available, true);
        assert.ok(Number.isFinite(result.prediction.value));
        assert.equal(result.prediction.units, modelType === "fare" ? "INR" : "minutes");
        assert.equal(result.prediction.currency, modelType === "fare" ? "INR" : null);
        assert.equal(result.scenario.localTime, "08:00");
        assert.match(result.scenario.localDate, /^\d{4}-\d{2}-\d{2}$/);
        assert.equal(result.scenario.timezone, policy.timezone);
        assert.equal(result.scenario.period, "PEAK");
        assert.equal(result.model.targetRows, 40);
        assert.ok(result.model.trainedAt);
        assert.ok(result.model.featureNames.includes("distance_peak_interaction"));
        assert.deepEqual(result.model.excludedFeatureNames, []);
        assert.equal(result.scenario.inputFeatures.isPeak, true);
    }
    const fareNear = await analytics.predictScenario({ modelType: "fare", direction: "R2M", distanceKm: 2, departureTime: "08:00" }, options);
    const fareFar = await analytics.predictScenario({ modelType: "fare", direction: "R2M", distanceKm: 12, departureTime: "08:00" }, options);
    assert.notEqual(fareNear.prediction.value, fareFar.prediction.value);
    await assert.rejects(analytics.predictScenario({ modelType: "trip", direction: "R2M", distanceKm: 2, departureTime: "08:00" }, options), /fare or duration/i);
    await assert.rejects(analytics.predictScenario({ modelType: "fare", direction: "R2M", distanceKm: 2, departureTime: "25:00" }, options), /HH:MM/i);
});

test("model-specific prediction reports insufficient training without a fabricated value", async t => {
    const directory = await temporaryDirectory(t);
    const file = path.join(directory, "small.csv");
    await fs.writeFile(file, csvRows(4));
    analytics.resetAnalyticsCache();
    const result = await analytics.predictScenario({
        modelType: "duration", direction: "M2R", distanceKm: 4, departureTime: "18:00"
    }, { datasetPath: file, loadOperatingPolicy });
    assert.equal(result.prediction.available, false);
    assert.match(result.prediction.reason, /at least 20 usable rows/i);
    assert.equal("value" in result.prediction, false);
});

test("insufficient training rows are reported without fabricated metrics", async t => {
    const directory = await temporaryDirectory(t);
    const file = path.join(directory, "small.csv");
    await fs.writeFile(file, csvRows(4));
    analytics.resetAnalyticsCache();
    const entry = await analytics.getAnalyticsEntry({ datasetPath: file, loadOperatingPolicy });
    assert.equal(entry.response.models.fare.status, "INSUFFICIENT_TRAINING_DATA");
    assert.equal(entry.response.models.fare.evaluation, null);
});

test("rank-deficient feature datasets do not publish predictions or metrics", async t => {
    const directory = await temporaryDirectory(t);
    const file = path.join(directory, "rank-deficient.csv");
    const parsed = parseCsv(csvRows(40));
    for (const row of parsed.rows) {
        row.distance_km = "3.00";
        row.direction = "R2M";
        row.requested_at_utc = "2025-01-06T02:00:00.000Z";
        row.boarded_at_utc = "2025-01-06T02:15:00.000Z";
        row.booking_completed_at_utc = "2025-01-06T02:25:00.000Z";
    }
    const quote = value => '"' + String(value).replace(/"/g, '""') + '"';
    await fs.writeFile(file, [parsed.headers, ...parsed.rows.map(row => parsed.headers.map(header => row[header] ?? ""))].map(values => values.map(quote).join(",")).join("\r\n") + "\r\n");
    analytics.resetAnalyticsCache();
    const entry = await analytics.getAnalyticsEntry({ datasetPath: file, loadOperatingPolicy });
    assert.equal(entry.response.models.fare.status, "RANK_DEFICIENT");
    assert.equal(entry.response.models.fare.evaluation, null);
    const prediction = await analytics.predictScenario({ modelType: "fare", direction: "R2M", distanceKm: 3, departureTime: "08:00" },
        { datasetPath: file, loadOperatingPolicy });
    assert.equal(prediction.prediction.available, false);
    assert.equal(prediction.prediction.status, "RANK_DEFICIENT");
    assert.equal("value" in prediction.prediction, false);
});
