const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const policyQueries = require("../drt/queries/policyQueries");
const { isPeakAt, localParts } = require("../drt/services/operatingPolicy");
const {
    MODEL_VERSION, FEATURE_NAMES, MIN_ROWS, MIN_TRIPS, parseCsv, normalizeDirection,
    prepareTrainingData, trainTarget, predictModel, featureVector
} = require("./analyticsRegression");

const projectRoot = path.resolve(__dirname, "../../../..");
const primaryCsv = path.join(projectRoot, "backend", "exports", "demo-trip-history.csv");
const fallbackCsvs = [path.join(projectRoot, "export", "demo-trip-history.csv"), path.join(projectRoot, "backend", "export", "demo-trip-history.csv")];
const EXPORT_COMMAND = "npm run demo:export (from backend/)";
const REQUIRED_HEADERS = ["booking_id", "trip_id", "booking_source", "booking_status", "direction", "distance_km", "requested_at_utc", "fare_amount", "fare_currency", "boarded_at_utc", "booking_completed_at_utc"];
let cached = null;

function policyKey(policy) {
    return JSON.stringify({ timezone: policy.timezone, operating_days: policy.operating_days, peak_periods: policy.peak_periods });
}

async function selectDataset(pathOverride = process.env.DEMO_TRIP_HISTORY_CSV) {
    const override = String(pathOverride || "").trim();
    if (override) {
        const resolved = path.resolve(override);
        if (path.extname(resolved).toLowerCase() !== ".csv")
            return { error: "The configured DEMO_TRIP_HISTORY_CSV path must point to a .csv file.", path: resolved };
        return { path: resolved, source: "environment_override" };
    }
    for (const candidate of [primaryCsv, ...fallbackCsvs]) {
        try {
            const info = await fs.stat(candidate);
            if (info.isFile()) return { path: candidate, source: candidate === primaryCsv ? "default_export" : "alternate_export" };
        } catch (error) {
            if (error.code !== "ENOENT" && error.code !== "ENOTDIR")
                return { error: "The configured demo CSV could not be accessed.", path: candidate };
        }
    }
    return { path: primaryCsv, source: "default_export" };
}

function modelSummary(model, exclusions, extras = {}) {
    const featureIndexes = model.predictionModel?.featureIndexes || model.featureIndexes;
    const included = Array.isArray(featureIndexes) ? featureIndexes : FEATURE_NAMES.map((_, index) => index);
    const excluded = Array.isArray(model.predictionModel?.excludedFeatureIndexes)
        ? model.predictionModel.excludedFeatureIndexes
        : Array.isArray(model.excludedFeatureIndexes)
            ? model.excludedFeatureIndexes
            : FEATURE_NAMES.map((_, index) => index).filter(index => !included.includes(index));
    return {
        status: model.status,
        available: model.status === "READY",
        reason: model.reason || null,
        targetRows: model.usableRows || 0,
        distinctTrips: model.distinctTrips || 0,
        rowsExcluded: extras.totalRows === undefined ? null : Math.max(0, extras.totalRows - (model.usableRows || 0)),
        exclusions,
        evaluation: model.evaluation || null,
        modelVersion: MODEL_VERSION,
        targetUnits: extras.targetUnits || null,
        featureNames: included.map(index => FEATURE_NAMES[index]),
        excludedFeatureNames: excluded.map(index => FEATURE_NAMES[index])
    };
}

function emptyResponse(status, message, policy, datasetName = "demo-trip-history.csv") {
    const emptyModel = { status: "INSUFFICIENT_TRAINING_DATA", usableRows: 0, distinctTrips: 0, reason: message };
    return {
        dataset: {
            status,
            name: datasetName,
            totalRows: 0,
            distinctTripsRepresented: 0,
            message,
            exportCommand: EXPORT_COMMAND
        },
        training: {
            modelVersion: MODEL_VERSION,
            trainedAt: null,
            minimumRows: MIN_ROWS,
            minimumDistinctTrips: MIN_TRIPS,
            fareFallbackRows: 0,
            durationDerivedRows: 0
        },
        models: {
            fare: modelSummary(emptyModel, {}, { totalRows: 0, targetUnits: "INR" }),
            duration: modelSummary(emptyModel, {}, { totalRows: 0, targetUnits: "minutes" })
        },
        operatingPolicy: {
            timezone: policy.timezone || "Asia/Kolkata",
            peakPeriods: policy.peak_periods || [],
            operatingDays: policy.operating_days || []
        },
        disclaimer: "Estimates use a small local demo dataset and may be weak. They are not guaranteed real-world outcomes."
    };
}

async function getAnalyticsEntry(options = {}) {
    const policy = await (options.loadOperatingPolicy || policyQueries.activeOperating)();
    const selected = await selectDataset(options.datasetPath);
    if (selected.error) {
        return { response: emptyResponse("INVALID_CONFIGURATION", selected.error, policy), policy, models: null };
    }
    let info;
    try { info = await fs.stat(selected.path); }
    catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") {
            const cacheKey = `missing:${selected.path}:${policyKey(policy)}`;
            if (cached?.key === cacheKey) return cached.entry;
            const entry = { response: emptyResponse("MISSING", `Demo trip history CSV is missing. Create it with ${EXPORT_COMMAND}.`, policy), policy, models: null };
            cached = { key: cacheKey, entry };
            return entry;
        }
        return { response: emptyResponse("UNAVAILABLE", "The configured demo CSV could not be read by the backend.", policy), policy, models: null };
    }
    if (!info.isFile()) return { response: emptyResponse("INVALID_CONFIGURATION", "The configured demo trip history path is not a file.", policy), policy, models: null };

    const fileSignature = `${selected.path}:${info.size}:${info.mtimeMs}:${policyKey(policy)}`;
    if (cached?.fileSignature === fileSignature) return cached.entry;

    let content;
    try { content = await fs.readFile(selected.path, "utf8"); }
    catch { return { response: emptyResponse("UNAVAILABLE", "The configured demo CSV could not be read by the backend.", policy), policy, models: null }; }
    const fingerprint = crypto.createHash("sha256").update(content).digest("hex");
    const cacheKey = `${selected.path}:${fingerprint}:${policyKey(policy)}`;
    if (cached?.key === cacheKey) {
        cached.fileSignature = fileSignature;
        return cached.entry;
    }

    let parsed;
    try { parsed = parseCsv(content); }
    catch (error) {
        const entry = { response: emptyResponse("INVALID_CSV", `The demo CSV could not be parsed: ${error.message}`, policy), policy, models: null };
        cached = { key: cacheKey, fileSignature, entry };
        return entry;
    }
    if (!parsed.headers.length) {
        const entry = { response: emptyResponse("EMPTY", `Demo trip history CSV has no rows. Create fresh data with ${EXPORT_COMMAND}.`, policy), policy, models: null };
        cached = { key: cacheKey, fileSignature, entry };
        return entry;
    }
    const missingHeaders = REQUIRED_HEADERS.filter(header => !parsed.headers.includes(header));
    if (missingHeaders.length) {
        const entry = { response: emptyResponse("INVALID_CSV", `CSV is missing required columns: ${missingHeaders.join(", ")}. Regenerate it with ${EXPORT_COMMAND}.`, policy), policy, models: null };
        cached = { key: cacheKey, fileSignature, entry };
        return entry;
    }
    if (!parsed.rows.length) {
        const entry = { response: emptyResponse("EMPTY", `Demo trip history CSV has no booking rows. Create fresh data with ${EXPORT_COMMAND}.`, policy), policy, models: null };
        cached = { key: cacheKey, fileSignature, entry };
        return entry;
    }

    const prepared = prepareTrainingData(parsed.rows, policy);
    const fare = trainTarget(prepared.fareRows);
    const duration = trainTarget(prepared.durationRows);
    const representedTrips = new Set(parsed.rows.map(row => String(row.trip_id || "").trim()).filter(Boolean));
    const trainedAt = new Date().toISOString();
    const response = {
        dataset: {
            status: "READY",
            name: path.basename(selected.path),
            source: selected.source,
            totalRows: parsed.rows.length,
            distinctTripsRepresented: representedTrips.size,
            message: parsed.rows.length ? null : `No booking rows are in the CSV. Create fresh data with ${EXPORT_COMMAND}.`,
            exportCommand: EXPORT_COMMAND,
            fingerprint: fingerprint.slice(0, 12)
        },
        training: {
            modelVersion: MODEL_VERSION,
            trainedAt,
            minimumRows: MIN_ROWS,
            minimumDistinctTrips: MIN_TRIPS,
            fareFallbackRows: prepared.fareFallbackRows,
            durationDerivedRows: prepared.durationDerivedRows
        },
        models: {
            fare: modelSummary(fare, prepared.fareExcluded, { totalRows: parsed.rows.length, targetUnits: "INR" }),
            duration: modelSummary(duration, prepared.durationExcluded, { totalRows: parsed.rows.length, targetUnits: "minutes" })
        },
        operatingPolicy: {
            timezone: policy.timezone || "Asia/Kolkata",
            peakPeriods: policy.peak_periods || [],
            operatingDays: policy.operating_days || []
        },
        disclaimer: "Estimates use a small local demo dataset and may be weak. They are not guaranteed real-world outcomes."
    };
    const entry = { response, policy, models: { fare, duration }, prepared, fingerprint };
    cached = { key: cacheKey, fileSignature, entry };
    return entry;
}

function badRequest(message) { return Object.assign(new Error(message), { statusCode: 400 }); }

function instantForPolicyTime(timeValue, policy, now = new Date()) {
    const timezone = policy.timezone || "Asia/Kolkata";
    const formatter = new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    });
    const get = (parts, type) => Number(parts.find(part => part.type === type)?.value);
    const today = formatter.formatToParts(now);
    const [hour, minute] = timeValue.split(":").map(Number);
    const year = get(today, "year"), month = get(today, "month"), day = get(today, "day");
    const desiredLocal = Date.UTC(year, month - 1, day, hour, minute);
    let guess = desiredLocal;
    for (let attempt = 0; attempt < 5; attempt++) {
        const parts = formatter.formatToParts(new Date(guess));
        const representedLocal = Date.UTC(get(parts, "year"), get(parts, "month") - 1, get(parts, "day"), get(parts, "hour"), get(parts, "minute"));
        const difference = desiredLocal - representedLocal;
        if (!difference) break;
        guess += difference;
    }
    const resolved = new Date(guess);
    const actual = formatter.formatToParts(resolved);
    if (get(actual, "hour") !== hour || get(actual, "minute") !== minute)
        throw badRequest("The selected local time does not exist today in the operating-policy timezone.");
    return resolved;
}

function validateScenario(input, policy) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw badRequest("Scenario details are required.");
    const direction = normalizeDirection(input.direction);
    if (!direction) throw badRequest("Choose R2M or M2R direction.");
    if (typeof input.distanceKm !== "number" || !Number.isFinite(input.distanceKm) || input.distanceKm <= 0 || input.distanceKm > 500)
        throw badRequest("Distance must be greater than 0 and no more than 500 km.");
    let departureAt;
    if (input.departureTime !== undefined) {
        if (input.departureAt !== undefined) throw badRequest("Provide either departureTime or departureAt, not both.");
        if (typeof input.departureTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.departureTime))
            throw badRequest("Choose a valid departure time in HH:MM format.");
        try { departureAt = instantForPolicyTime(input.departureTime, policy); }
        catch (error) {
            if (error.statusCode) throw error;
            throw Object.assign(new Error("The active operating policy has an invalid timezone."), { statusCode: 503 });
        }
    } else {
        if (typeof input.departureAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.departureAt))
            throw badRequest("Choose a departure date and time with an explicit timezone.");
        departureAt = new Date(input.departureAt);
    }
    if (!Number.isFinite(departureAt.getTime())) throw badRequest("Departure date and time are invalid.");
    let peak;
    try { peak = isPeakAt(departureAt, policy); }
    catch { throw Object.assign(new Error("The active operating policy has invalid peak periods or timezone."), { statusCode: 503 }); }
    if (input.period !== undefined && String(input.period).toUpperCase() !== (peak ? "PEAK" : "OFFPEAK"))
        throw badRequest("Selected time does not match the active operating policy’s peak/off-peak periods.");
    return { direction, distanceKm: input.distanceKm, departureAt, peak };
}

function predictWithModel(model, features, units) {
    if (!model) return { status: "INSUFFICIENT_TRAINING_DATA", available: false, reason: "Model data is not available." };
    if (model.status !== "READY") return { status: model.status, available: false, reason: model.reason };
    const value = predictModel(model.predictionModel, features);
    if (value === null || value < 0) return { status: "INVALID_PREDICTION", available: false, reason: "The model produced a non-finite or negative estimate for this scenario." };
    return { status: "READY", available: true, value: Number(value.toFixed(2)), units, modelVersion: MODEL_VERSION };
}

async function getAnalytics(options) {
    const { response } = await getAnalyticsEntry(options);
    return response;
}

async function predictScenario(input, options) {
    const modelType = input?.modelType;
    if (modelType !== undefined && !["fare", "duration"].includes(modelType))
        throw badRequest("Choose the fare or duration model.");
    const entry = await getAnalyticsEntry(options);
    const scenario = validateScenario(input, entry.policy);
    const local = localParts(scenario.departureAt, entry.policy.timezone || "Asia/Kolkata");
    const features = featureVector({
        distanceKm: scenario.distanceKm,
        at: scenario.departureAt,
        direction: scenario.direction,
        isPeak: scenario.peak,
        timezone: entry.policy.timezone || "Asia/Kolkata"
    });
    const localDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: entry.policy.timezone || "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(scenario.departureAt);
    const scenarioResult = {
        direction: scenario.direction,
        distanceKm: scenario.distanceKm,
        departureAt: scenario.departureAt.toISOString(),
        localDate,
        localTime: `${String(Math.floor(local.minute / 60)).padStart(2, "0")}:${String(local.minute % 60).padStart(2, "0")}`,
        timezone: entry.policy.timezone || "Asia/Kolkata",
        period: scenario.peak ? "PEAK" : "OFFPEAK",
        inputFeatures: {
            distanceKm: scenario.distanceKm,
            hourSin: Number(features[1].toFixed(6)),
            hourCos: Number(features[2].toFixed(6)),
            isPeak: scenario.peak,
            direction: scenario.direction,
            distancePeakInteraction: Number(features[5].toFixed(6))
        }
    };
    if (modelType) {
        const modelSummary = entry.response.models[modelType];
        const model = entry.models?.[modelType] || { status: modelSummary.status, reason: modelSummary.reason };
        const units = modelType === "fare" ? "INR" : "minutes";
        return {
            modelType,
            prediction: {
                ...predictWithModel(model, features, units),
                units,
                currency: modelType === "fare" ? "INR" : null
            },
            model: {
                status: modelSummary.status,
                available: modelSummary.available,
                reason: modelSummary.reason,
                targetRows: modelSummary.targetRows,
                distinctTrips: modelSummary.distinctTrips,
                evaluation: modelSummary.evaluation,
                featureNames: modelSummary.featureNames,
                excludedFeatureNames: modelSummary.excludedFeatureNames,
                modelVersion: entry.response.training.modelVersion,
                trainedAt: entry.response.training.trainedAt
            },
            dataset: {
                status: entry.response.dataset.status,
                name: entry.response.dataset.name,
                totalRows: entry.response.dataset.totalRows,
                fingerprint: entry.response.dataset.fingerprint || null
            },
            scenario: scenarioResult,
            datasetFingerprint: entry.fingerprint?.slice(0, 12) || null
        };
    }
    return {
        scenario: scenarioResult,
        predictions: {
            fare: predictWithModel(entry.models?.fare || entry.response.models.fare, features, "INR"),
            duration: predictWithModel(entry.models?.duration || entry.response.models.duration, features, "minutes")
        },
        datasetFingerprint: entry.fingerprint?.slice(0, 12) || null
    };
}

function resetAnalyticsCache() { cached = null; }

module.exports = { getAnalytics, predictScenario, getAnalyticsEntry, selectDataset, validateScenario, resetAnalyticsCache };
