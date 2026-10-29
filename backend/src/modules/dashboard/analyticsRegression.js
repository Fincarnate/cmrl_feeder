const crypto = require("node:crypto");
const { isPeakAt, localParts } = require("../drt/services/operatingPolicy");

const MODEL_VERSION = "cmrl-demo-mlr-v1";
const FEATURE_NAMES = ["distance_km", "hour_sin", "hour_cos", "is_peak", "direction_r2m", "distance_peak_interaction"];
const MIN_ROWS = 20;
const MIN_TRIPS = 8;
const EPSILON = 1e-10;

function parseCsv(text) {
    if (typeof text !== "string") throw new Error("CSV content must be text.");
    const records = [];
    let record = [], field = "", quoted = false, closedQuote = false;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (quoted) {
            if (char === '"') {
                if (text[index + 1] === '"') { field += '"'; index++; }
                else { quoted = false; closedQuote = true; }
            } else field += char;
            continue;
        }
        if (closedQuote && char !== "," && char !== "\r" && char !== "\n" && !/\s/.test(char))
            throw new Error(`Unexpected character after a quoted CSV field at character ${index + 1}.`);
        if (char === '"' && field.length === 0 && !closedQuote) { quoted = true; continue; }
        if (char === '"') throw new Error(`Unexpected quote in an unquoted CSV field at character ${index + 1}.`);
        if (char === ",") { record.push(field); field = ""; closedQuote = false; continue; }
        if (char === "\r" || char === "\n") {
            if (char === "\r" && text[index + 1] === "\n") index++;
            record.push(field);
            if (record.some(value => value.trim() !== "")) records.push(record);
            record = []; field = ""; closedQuote = false; continue;
        }
        if (closedQuote && /\s/.test(char)) continue;
        field += char;
    }
    if (quoted) throw new Error("CSV contains an unterminated quoted field.");
    if (field.length || record.length) {
        record.push(field);
        if (record.some(value => value.trim() !== "")) records.push(record);
    }
    if (!records.length) return { headers: [], rows: [] };
    const headers = records.shift().map((value, index) => (index === 0 ? value.replace(/^\uFEFF/, "") : value).trim());
    if (headers.some(header => !header)) throw new Error("CSV contains an empty column name.");
    if (new Set(headers).size !== headers.length) throw new Error("CSV contains duplicate column names.");
    const rows = records.map((values, index) => {
        if (values.length > headers.length) throw new Error(`CSV row ${index + 2} has more values than the header.`);
        return Object.fromEntries(headers.map((header, column) => [header, values[column] ?? ""]));
    });
    return { headers, rows };
}

function finitePositive(value) {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

function validDate(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

function normalizeDirection(value) {
    const direction = String(value || "").trim().toUpperCase();
    if (direction === "R2M" || direction === "RESIDENTIAL_TO_METRO") return "R2M";
    if (direction === "M2R" || direction === "METRO_TO_RESIDENTIAL") return "M2R";
    return null;
}

function featureVector({ distanceKm, at, direction, isPeak, timezone }) {
    const local = localParts(at, timezone);
    const hour = local.minute / 60;
    const angle = (2 * Math.PI * hour) / 24;
    const peak = isPeak ? 1 : 0;
    return [distanceKm, Math.sin(angle), Math.cos(angle), peak, direction === "R2M" ? 1 : 0, distanceKm * peak];
}

function increment(counter, reason) { counter[reason] = (counter[reason] || 0) + 1; }

function prepareTrainingData(rows, policy) {
    const fareRows = [], durationRows = [], fareExcluded = {}, durationExcluded = {};
    let fareFallbackRows = 0, durationDerivedRows = 0;
    for (const row of rows) {
        const direction = normalizeDirection(row.direction);
        const distanceKm = finitePositive(row.distance_km);
        const requestedAt = validDate(row.requested_at_utc);
        const boardingAt = validDate(row.boarded_at_utc);

        let fareReason = null;
        if (!distanceKm) fareReason = "invalid_or_missing_distance";
        else if (!requestedAt) fareReason = "invalid_or_missing_request_time";
        else if (!direction) fareReason = "invalid_or_missing_direction";
        else if (String(row.fare_currency || "").trim().toUpperCase() !== "INR") fareReason = "currency_not_inr_or_missing";
        const finalFare = finitePositive(row.final_fare);
        const initialFare = finitePositive(row.fare_amount);
        const fare = finalFare ?? initialFare;
        if (!fareReason && !fare) fareReason = "invalid_or_missing_fare";
        if (fareReason) increment(fareExcluded, fareReason);
        else {
            if (!finalFare) fareFallbackRows++;
            const isPeak = isPeakAt(requestedAt, policy);
            fareRows.push({
                tripId: String(row.trip_id || row.booking_id || "").trim(),
                bookingId: String(row.booking_id || "").trim(),
                target: fare,
                features: featureVector({ distanceKm, at: requestedAt, direction, isPeak, timezone: policy.timezone })
            });
        }

        let durationReason = null;
        if (String(row.booking_status || "").trim().toUpperCase() !== "COMPLETED") durationReason = "booking_not_completed";
        else if (!distanceKm) durationReason = "invalid_or_missing_distance";
        else if (!boardingAt) durationReason = "invalid_or_missing_boarding_time";
        else if (!direction) durationReason = "invalid_or_missing_direction";
        let durationSeconds = finitePositive(row.cab_duration_seconds), derivedDuration = false;
        if (!durationSeconds) {
            const completedAt = validDate(row.booking_completed_at_utc);
            if (boardingAt && completedAt && completedAt > boardingAt) {
                durationSeconds = (completedAt.getTime() - boardingAt.getTime()) / 1000;
                derivedDuration = true;
            }
        }
        if (!durationReason && !durationSeconds) durationReason = "invalid_or_missing_cab_duration";
        if (durationReason) increment(durationExcluded, durationReason);
        else {
            if (derivedDuration) durationDerivedRows++;
            const isPeak = isPeakAt(boardingAt, policy);
            durationRows.push({
                tripId: String(row.trip_id || row.booking_id || "").trim(),
                bookingId: String(row.booking_id || "").trim(),
                target: durationSeconds / 60,
                features: featureVector({ distanceKm, at: boardingAt, direction, isPeak, timezone: policy.timezone })
            });
        }
    }
    return { fareRows, durationRows, fareExcluded, durationExcluded, fareFallbackRows, durationDerivedRows };
}

function deterministicSplit(rows) {
    const groups = new Map();
    for (const row of rows) {
        const group = row.tripId || row.bookingId;
        if (!group) return null;
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(row);
    }
    if (groups.size < MIN_TRIPS) return null;
    const ranked = [...groups.entries()].sort(([a], [b]) => {
        const ah = crypto.createHash("sha256").update(`${MODEL_VERSION}:${a}`).digest("hex");
        const bh = crypto.createHash("sha256").update(`${MODEL_VERSION}:${b}`).digest("hex");
        return ah.localeCompare(bh);
    });
    const validationGroupCount = Math.min(groups.size - 2, Math.max(2, Math.round(groups.size * 0.2)));
    const validationKeys = new Set(ranked.slice(0, validationGroupCount).map(([key]) => key));
    return {
        train: rows.filter(row => !validationKeys.has(row.tripId || row.bookingId)),
        validation: rows.filter(row => validationKeys.has(row.tripId || row.bookingId)),
        validationTripCount: validationKeys.size,
        totalTripCount: groups.size
    };
}

function solveLeastSquares(matrix, targets) {
    const rowCount = matrix.length;
    const columnCount = matrix[0]?.length || 0;
    if (rowCount < columnCount || targets.length !== rowCount || !columnCount) return null;
    const a = matrix.map(row => row.slice());
    const b = targets.slice();
    for (let column = 0; column < columnCount; column++) {
        let norm = 0;
        for (let row = column; row < rowCount; row++) norm = Math.hypot(norm, a[row][column]);
        if (!Number.isFinite(norm) || norm <= EPSILON) return null;
        const alpha = a[column][column] >= 0 ? -norm : norm;
        const vector = Array.from({ length: rowCount - column }, (_, index) => a[column + index][column]);
        vector[0] -= alpha;
        const vectorNorm = vector.reduce((sum, value) => sum + value * value, 0);
        if (!Number.isFinite(vectorNorm) || vectorNorm <= EPSILON) return null;
        const beta = 2 / vectorNorm;
        for (let targetColumn = column; targetColumn < columnCount; targetColumn++) {
            let projection = 0;
            for (let index = 0; index < vector.length; index++) projection += vector[index] * a[column + index][targetColumn];
            projection *= beta;
            for (let index = 0; index < vector.length; index++) a[column + index][targetColumn] -= projection * vector[index];
        }
        let projection = 0;
        for (let index = 0; index < vector.length; index++) projection += vector[index] * b[column + index];
        projection *= beta;
        for (let index = 0; index < vector.length; index++) b[column + index] -= projection * vector[index];
        a[column][column] = alpha;
        for (let row = column + 1; row < rowCount; row++) a[row][column] = 0;
    }
    const coefficients = Array(columnCount).fill(0);
    for (let row = columnCount - 1; row >= 0; row--) {
        let value = b[row];
        for (let column = row + 1; column < columnCount; column++) value -= a[row][column] * coefficients[column];
        if (!Number.isFinite(a[row][row]) || Math.abs(a[row][row]) <= EPSILON) return null;
        coefficients[row] = value / a[row][row];
    }
    return coefficients.every(Number.isFinite) ? coefficients : null;
}

function fitModel(rows) {
    if (!rows.length) return { status: "INSUFFICIENT_TRAINING_DATA", reason: "No usable rows." };
    const means = FEATURE_NAMES.map((_, index) => rows.reduce((sum, row) => sum + row.features[index], 0) / rows.length);
    const scales = FEATURE_NAMES.map((_, index) => {
        const variance = rows.reduce((sum, row) => sum + (row.features[index] - means[index]) ** 2, 0) / rows.length;
        return Math.sqrt(variance);
    });
    if (scales.some(scale => !Number.isFinite(scale) || scale <= EPSILON))
        return { status: "RANK_DEFICIENT", reason: "One or more required features have no variation in the training rows." };
    const matrix = rows.map(row => [1, ...row.features.map((value, index) => (value - means[index]) / scales[index])]);
    const coefficients = solveLeastSquares(matrix, rows.map(row => row.target));
    if (!coefficients) return { status: "RANK_DEFICIENT", reason: "The training feature matrix is rank deficient or numerically unstable." };
    return { status: "READY", coefficients, means, scales };
}

function predictModel(model, features) {
    if (model?.status !== "READY" || !Array.isArray(features) || features.length !== FEATURE_NAMES.length) return null;
    const values = [1, ...features.map((value, index) => (value - model.means[index]) / model.scales[index])];
    const prediction = values.reduce((sum, value, index) => sum + value * model.coefficients[index], 0);
    return Number.isFinite(prediction) ? prediction : null;
}

function evaluateModel(model, rows) {
    if (!rows.length) return null;
    const predictions = rows.map(row => predictModel(model, row.features));
    if (predictions.some(value => value === null)) return null;
    const residuals = rows.map((row, index) => row.target - predictions[index]);
    const mae = residuals.reduce((sum, value) => sum + Math.abs(value), 0) / residuals.length;
    const rmse = Math.sqrt(residuals.reduce((sum, value) => sum + value * value, 0) / residuals.length);
    const mean = rows.reduce((sum, row) => sum + row.target, 0) / rows.length;
    const total = rows.reduce((sum, row) => sum + (row.target - mean) ** 2, 0);
    const rSquared = rows.length >= 2 && total > EPSILON
        ? 1 - residuals.reduce((sum, value) => sum + value * value, 0) / total
        : null;
    return { mae, rmse, rSquared, validationRows: rows.length };
}

function trainTarget(rows) {
    const distinctTrips = new Set(rows.map(row => row.tripId || row.bookingId).filter(Boolean)).size;
    const base = { usableRows: rows.length, distinctTrips, evaluation: null, predictionModel: null };
    if (rows.length < MIN_ROWS || distinctTrips < MIN_TRIPS) {
        return { ...base, status: "INSUFFICIENT_TRAINING_DATA", reason: `Need at least ${MIN_ROWS} usable rows across ${MIN_TRIPS} distinct trips.` };
    }
    const split = deterministicSplit(rows);
    if (!split || split.train.length < FEATURE_NAMES.length + 2 || split.validation.length < 2)
        return { ...base, status: "INSUFFICIENT_TRAINING_DATA", reason: "Not enough distinct trips for a grouped holdout evaluation." };
    const evaluationModel = fitModel(split.train);
    if (evaluationModel.status !== "READY") return { ...base, status: evaluationModel.status, reason: `Grouped training split: ${evaluationModel.reason}` };
    const metrics = evaluateModel(evaluationModel, split.validation);
    if (!metrics) return { ...base, status: "RANK_DEFICIENT", reason: "Could not evaluate the held-out trips safely." };
    const fullModel = fitModel(rows);
    if (fullModel.status !== "READY") return { ...base, status: fullModel.status, reason: fullModel.reason };
    return {
        ...base,
        status: "READY",
        reason: null,
        predictionModel: fullModel,
        evaluation: {
            method: "Deterministic 80/20 holdout grouped by trip_id; validation trips are excluded from fitting.",
            trainRows: split.train.length,
            validationRows: metrics.validationRows,
            trainTrips: new Set(split.train.map(row => row.tripId || row.bookingId)).size,
            validationTrips: split.validationTripCount,
            mae: metrics.mae,
            rmse: metrics.rmse,
            rSquared: metrics.rSquared
        }
    };
}

module.exports = {
    MODEL_VERSION,
    FEATURE_NAMES,
    MIN_ROWS,
    MIN_TRIPS,
    parseCsv,
    normalizeDirection,
    prepareTrainingData,
    deterministicSplit,
    solveLeastSquares,
    fitModel,
    predictModel,
    evaluateModel,
    trainTarget,
    featureVector
};
