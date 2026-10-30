import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiRequest } from "../api/client";
import { compareScenario, validateBenchmarks } from "../analytics/benchmarks";
import "./DataAnalyticsPage.css";

const STORAGE_KEY = "cmrlAnalyticsBenchmarks.v1";
const blankBenchmarks = {
    petrolPrice: "",
    fuelEfficiency: "",
    parkingPrice: "",
    parkingHours: "",
    distanceMode: "multiplier",
    roadDistanceMultiplier: "",
    actualRoadDistance: "",
    rushTravelMinutes: "",
    offpeakTravelMinutes: ""
};
const blankModelTestCase = { direction: "R2M", distanceKm: "", departureTime: "" };

function readSavedBenchmarks() {
    try {
        const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
        return saved && typeof saved === "object" ? { ...blankBenchmarks, ...saved } : blankBenchmarks;
    } catch {
        try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* storage may be disabled */ }
        return blankBenchmarks;
    }
}

function localParts(date, timezone) {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(date);
    const get = type => parts.find(part => part.type === type)?.value;
    const weekdays = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    return {
        weekday: weekdays[get("weekday")],
        year: Number(get("year")), month: Number(get("month")), day: Number(get("day")),
        minute: Number(get("hour")) * 60 + Number(get("minute"))
    };
}

function timeMinutes(value) {
    const match = /^(\d{2}):(\d{2})$/.exec(value || "");
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function isPeak(date, policy) {
    const { weekday, minute } = localParts(date, policy.timezone || "Asia/Kolkata");
    const days = policy.operatingDays?.length ? policy.operatingDays : [1, 2, 3, 4, 5, 6, 7];
    return (policy.peakPeriods || []).some(period => {
        const start = timeMinutes(period.start), end = timeMinutes(period.end);
        if (start === null || end === null || start === end) return false;
        if (start < end) return days.includes(weekday) && minute >= start && minute < end;
        const previousDay = weekday === 1 ? 7 : weekday - 1;
        return (days.includes(weekday) && minute >= start) || (days.includes(previousDay) && minute < end);
    });
}

function instantForLocalTime(year, month, day, minute, timezone) {
    const hour = Math.floor(minute / 60), minuteOfHour = minute % 60;
    let guess = Date.UTC(year, month - 1, day, hour, minuteOfHour);
    const desiredUtc = Date.UTC(year, month - 1, day, hour, minuteOfHour);
    for (let attempt = 0; attempt < 4; attempt++) {
        const local = localParts(new Date(guess), timezone);
        const representedUtc = Date.UTC(local.year, local.month - 1, local.day, Math.floor(local.minute / 60), local.minute % 60);
        guess += desiredUtc - representedUtc;
    }
    return new Date(guess);
}

function findPeriodDeparture(baseDate, targetPeak, policy) {
    const timezone = policy.timezone || "Asia/Kolkata";
    const base = localParts(baseDate, timezone);
    for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
        const date = new Date(Date.UTC(base.year, base.month - 1, base.day + dayOffset));
        for (let minute = 0; minute < 1440; minute += 15) {
            const candidate = instantForLocalTime(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), minute, timezone);
            if (isPeak(candidate, policy) === targetPeak) return candidate;
        }
    }
    return null;
}

function money(value) { return value === null || value === undefined ? "—" : `₹${Number(value).toFixed(2)}`; }
function minutes(value) { return value === null || value === undefined ? "—" : `${Number(value).toFixed(1)} min`; }
function reasonLabel(reason) { return reason.replaceAll("_", " "); }
function featureLabel(name) {
    const labels = {
        distance_km: "Trip distance",
        hour_sin: "Time of day (cyclic sine)",
        hour_cos: "Time of day (cyclic cosine)",
        is_peak: "Peak or off-peak period",
        direction_r2m: "R2M direction indicator",
        distance_peak_interaction: "Distance × peak interaction"
    };
    return labels[name] || reasonLabel(name);
}

function DataAnalyticsPage({ session, onLogout }) {
    const navigate = useNavigate();
    const [analytics, setAnalytics] = useState(null);
    const [benchmarks, setBenchmarks] = useState(readSavedBenchmarks);
    const [benchmarkMessage, setBenchmarkMessage] = useState("");
    const [formError, setFormError] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState(null);
    const [periodResults, setPeriodResults] = useState([]);
    const [fareTestCase, setFareTestCase] = useState({ ...blankModelTestCase });
    const [durationTestCase, setDurationTestCase] = useState({ ...blankModelTestCase });
    const [fareTestBusy, setFareTestBusy] = useState(false);
    const [durationTestBusy, setDurationTestBusy] = useState(false);
    const [fareTestError, setFareTestError] = useState("");
    const [durationTestError, setDurationTestError] = useState("");
    const [fareTestResult, setFareTestResult] = useState(null);
    const [durationTestResult, setDurationTestResult] = useState(null);
    const [scenario, setScenario] = useState({
        direction: "R2M",
        distanceKm: "",
        departureAt: ""
    });

    const loadAnalytics = useCallback(async () => {
        try {
            const data = await apiRequest("/dashboard/analytics", { token: session.token });
            setAnalytics(data);
            setError("");
        } catch (requestError) {
            if (requestError.status === 401 || requestError.status === 403) onLogout();
            else setError(requestError.message || "Unable to load analytics data.");
        }
    }, [session.token, onLogout]);

    useEffect(() => {
        const timer = window.setTimeout(loadAnalytics, 0);
        return () => window.clearTimeout(timer);
    }, [loadAnalytics]);

    const benchmarkError = validateBenchmarks(benchmarks);
    const comparison = useMemo(() => result
        ? compareScenario(result, benchmarks, result.predictions)
        : null, [result, benchmarks]);

    function updateBenchmark(key, value) {
        setBenchmarks(current => ({ ...current, [key]: value }));
        setBenchmarkMessage("");
    }

    function saveBenchmarks(event) {
        event.preventDefault();
        const validation = validateBenchmarks(benchmarks);
        if (validation) { setBenchmarkMessage(validation); return; }
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(benchmarks));
            setBenchmarkMessage("Your benchmark values are saved in this browser.");
        } catch { setBenchmarkMessage("Browser storage is unavailable. Your values were not saved."); }
    }

    async function predict(event) {
        event.preventDefault();
        setFormError(""); setError(""); setResult(null); setPeriodResults([]); setBusy(true);
        const distanceKm = Number(scenario.distanceKm);
        const departureDate = new Date(scenario.departureAt);
        if (!Number.isFinite(distanceKm) || distanceKm <= 0 || distanceKm > 500 || !Number.isFinite(departureDate.getTime())) {
            setFormError("Enter a distance above 0 and no more than 500 km, and choose a valid departure time.");
            setBusy(false); return;
        }
        try {
            const payload = { direction: scenario.direction, distanceKm, departureAt: departureDate.toISOString() };
            const selected = await apiRequest("/dashboard/analytics/predict", {
                token: session.token, method: "POST", body: JSON.stringify(payload)
            });
            setResult(selected);
            const otherDeparture = findPeriodDeparture(departureDate, selected.scenario.period !== "PEAK", analytics?.operatingPolicy || {});
            if (otherDeparture) {
                const other = await apiRequest("/dashboard/analytics/predict", {
                    token: session.token,
                    method: "POST",
                    body: JSON.stringify({ ...payload, departureAt: otherDeparture.toISOString() })
                });
                setPeriodResults([selected, other].sort((a, b) => a.scenario.period.localeCompare(b.scenario.period)));
            } else setPeriodResults([selected]);
        } catch (requestError) {
            if (requestError.status === 401 || requestError.status === 403) onLogout();
            else setError(requestError.message || "Unable to calculate this scenario.");
        } finally { setBusy(false); }
    }

    async function predictModelTest(event, modelType, testCase, setLoading, setModelError, setModelResult) {
        event.preventDefault();
        setModelError("");
        const distanceKm = Number(testCase.distanceKm);
        if (!Number.isFinite(distanceKm) || distanceKm <= 0 || distanceKm > 500) {
            setModelError("Enter an estimated distance greater than 0 and no more than 500 km.");
            return;
        }
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(testCase.departureTime)) {
            setModelError("Choose a valid departure time in the operating-policy timezone.");
            return;
        }
        if (!["R2M", "M2R"].includes(testCase.direction)) {
            setModelError("Choose Residential to Metro or Metro to Residential.");
            return;
        }
        setLoading(true);
        try {
            const data = await apiRequest("/dashboard/analytics/predict", {
                token: session.token,
                method: "POST",
                body: JSON.stringify({ modelType, direction: testCase.direction, distanceKm, departureTime: testCase.departureTime })
            });
            if (!data.prediction?.available || !Number.isFinite(data.prediction.value)) {
                const modelName = modelType === "fare" ? "Fare" : "Journey-duration";
                const nextStep = data.prediction?.status === "RANK_DEFICIENT"
                    ? "Add varied valid demo trip records, then refresh the analytics data."
                    : "Export more valid demo trip records and refresh the analytics data.";
                setModelError(`${modelName} model unavailable: ${data.prediction?.reason || "No valid prediction is available."} ${nextStep}`);
                return;
            }
            setModelResult(data);
        } catch (requestError) {
            if (requestError.status === 401 || requestError.status === 403) onLogout();
            else setModelError(requestError.message || `Unable to calculate the ${modelType} model prediction.`);
        } finally { setLoading(false); }
    }

    const dataset = analytics?.dataset;
    const modelEntries = analytics?.models ? [
        ["Fare model", analytics.models.fare, "Fare target uses final_fare when valid, then fare_amount."],
        ["Journey-duration model", analytics.models.duration, "Duration target uses completed cab_duration_seconds or boarded-to-completed timestamps."]
    ] : [];

    return (
        <main className="analytics-page">
            <div className="analytics-layout">
                <header className="analytics-header">
                    <div><p className="analytics-eyebrow">ADMIN · DATA ANALYTICS</p><h1>Data Analytics</h1><p>Regression estimates from completed and historical demo bookings.</p></div>
                    <div className="analytics-header-actions">
                        <button type="button" className="secondary-button" onClick={() => navigate("/admin")}>Back to dashboard</button>
                        <button type="button" className="secondary-button" onClick={loadAnalytics}>Refresh data</button>
                    </div>
                </header>

                {error && <p className="analytics-alert" role="alert">{error}</p>}
                {!analytics && !error && <p className="analytics-panel">Loading dataset and model diagnostics…</p>}

                {analytics && <>
                    <section className="analytics-panel">
                        <div className="analytics-section-heading"><div><h2>Training data</h2><p>{dataset?.name || "demo-trip-history.csv"} · {dataset?.source === "alternate_export" ? "alternate local export" : "configured local export"}</p></div><span className={`analytics-badge ${dataset?.status === "READY" ? "ready" : "warning"}`}>{dataset?.status || "UNKNOWN"}</span></div>
                        {dataset?.message && <p className="analytics-alert">{dataset.message}</p>}
                        <div className="analytics-stat-grid">
                            <article><span>CSV rows</span><strong>{dataset?.totalRows ?? 0}</strong></article>
                            <article><span>Distinct trips</span><strong>{dataset?.distinctTripsRepresented ?? 0}</strong></article>
                            <article><span>Usable fare rows</span><strong>{analytics.models.fare.targetRows}</strong><small>{analytics.models.fare.distinctTrips} trips</small></article>
                            <article><span>Usable completed-duration rows</span><strong>{analytics.models.duration.targetRows}</strong><small>{analytics.models.duration.distinctTrips} trips</small></article>
                        </div>
                        <p className="analytics-note">Dataset updates are detected automatically. To create fresh trip logs, complete demo bookings and run <code>{dataset?.exportCommand || "npm run demo:export (from backend/)"}</code>. Training uses a deterministic holdout grouped by trip, so bookings from one trip cannot be split across training and validation.</p>
                    </section>

                    <section className="analytics-panel">
                        <div className="analytics-section-heading"><div><h2>Model validation</h2><p>Multiple Linear Regression · {analytics.training.modelVersion} · trained {analytics.training.trainedAt ? new Date(analytics.training.trainedAt).toLocaleString() : "not trained"}</p></div></div>
                        <div className="analytics-model-grid">
                            {modelEntries.map(([title, model, detail]) => <article className="analytics-model-card" key={title}>
                                <h3>{title}</h3><span className={`analytics-badge ${model.available ? "ready" : "warning"}`}>{model.status.replaceAll("_", " ")}</span>
                                <p>{detail}</p>
                                {model.available && <small>Features used: {(model.featureNames || []).map(featureLabel).join(", ") || "none"}.{model.excludedFeatureNames?.length ? ` Omitted for this dataset: ${model.excludedFeatureNames.map(featureLabel).join(", ")}.` : ""}</small>}
                                {model.evaluation ? <><div className="analytics-metric-grid"><span>MAE ({model.targetUnits}) <strong>{model.evaluation.mae.toFixed(2)}</strong></span><span>RMSE ({model.targetUnits}) <strong>{model.evaluation.rmse.toFixed(2)}</strong></span><span>R² <strong>{model.evaluation.rSquared === null ? "Not meaningful" : model.evaluation.rSquared.toFixed(3)}</strong></span></div><small>{model.evaluation.method} {model.evaluation.trainRows} train rows / {model.evaluation.validationRows} held-out rows.</small></> : <p className="analytics-muted">{model.reason || "Insufficient training data. Complete more valid demo bookings to make this model available."}</p>}
                                <details><summary>Data exclusions</summary><ul>{Object.keys(model.exclusions || {}).length ? Object.entries(model.exclusions).map(([reason, count]) => <li key={reason}>{reasonLabel(reason)}: {count}</li>) : <li>No rows excluded for required features.</li>}</ul><p>{model.rowsExcluded ?? 0} rows excluded from this target.</p></details>
                            </article>)}
                        </div>
                        <p className="analytics-note">A small demo dataset can produce weak estimates. MAE is the average absolute validation error; RMSE gives larger errors more weight. R² is shown only when held-out targets vary enough for it to be meaningful. Predictions are estimates, not guaranteed real-world outcomes.</p>
                    </section>

                    <section className="analytics-panel">
                        <div className="analytics-section-heading"><div><h2>Manual ML Test Cases</h2><p>Submit independent feature inputs to the currently trained fare and duration models. No booking or trip is created.</p></div></div>
                        <div className="analytics-test-grid">
                            <article className="analytics-test-card">
                                <div className="analytics-section-heading"><div><h3>Test Fare Prediction Model</h3><p>Model status: {analytics.models.fare.status.replaceAll("_", " ")} · {analytics.models.fare.targetRows} usable rows</p></div><span className={`analytics-badge ${analytics.models.fare.available ? "ready" : "warning"}`}>{analytics.models.fare.available ? "READY" : "UNAVAILABLE"}</span></div>
                                {!analytics.models.fare.available && <p className="analytics-muted">Fare model unavailable: {analytics.models.fare.reason || "insufficient valid training data."} Export more valid demo trip records and refresh the analytics data.</p>}
                                <form className="analytics-form scenario-form" onSubmit={event => predictModelTest(event, "fare", fareTestCase, setFareTestBusy, setFareTestError, setFareTestResult)}>
                                    <label>Estimated distance (km)<input type="number" min="0.01" max="500" step="0.01" value={fareTestCase.distanceKm} onChange={event => setFareTestCase(current => ({ ...current, distanceKm: event.target.value }))} required /></label>
                                    <label>Planned departure time ({analytics.operatingPolicy.timezone})<input type="time" step="60" value={fareTestCase.departureTime} onChange={event => setFareTestCase(current => ({ ...current, departureTime: event.target.value }))} required /></label>
                                    <label>Journey direction<select value={fareTestCase.direction} onChange={event => setFareTestCase(current => ({ ...current, direction: event.target.value }))}><option value="R2M">Residential to Metro (R2M)</option><option value="M2R">Metro to Residential (M2R)</option></select></label>
                                    <div className="analytics-form-actions"><button type="submit" disabled={fareTestBusy}>{fareTestBusy ? "Predicting…" : "Predict Fare"}</button></div>
                                </form>
                                {fareTestError && <p className="analytics-inline-error" role="alert">{fareTestError}</p>}
                                <p className="analytics-note">The time is interpreted as today in the operating-policy timezone. This model uses the request-time-of-day feature, with cyclic hour and peak status prepared by the backend.</p>
                                {fareTestResult && <div className="analytics-prediction-result" aria-live="polite"><span>Predicted CMRL Feeder Fare</span><strong>{money(fareTestResult.prediction.value)}</strong><p>{fareTestResult.scenario.distanceKm} km · {fareTestResult.scenario.direction} · {fareTestResult.scenario.localDate} {fareTestResult.scenario.localTime} {fareTestResult.scenario.timezone} · {fareTestResult.scenario.period === "PEAK" ? "Peak" : "Off-peak"}</p><small>{fareTestResult.model.modelVersion} · trained {fareTestResult.model.trainedAt ? new Date(fareTestResult.model.trainedAt).toLocaleString() : "timestamp unavailable"} · {fareTestResult.model.targetRows} training rows</small><p className="analytics-note">This is an ML estimate, not the authoritative fare calculated for a real booking.</p><details><summary>Model features and scenario inputs</summary><p>Used by this model: {(fareTestResult.model.featureNames || []).map(featureLabel).join(", ") || "none"}.</p>{fareTestResult.model.excludedFeatureNames?.length > 0 && <p>Omitted for this dataset: {fareTestResult.model.excludedFeatureNames.map(featureLabel).join(", ")}.</p>}<pre>{JSON.stringify(fareTestResult.scenario.inputFeatures, null, 2)}</pre></details></div>}
                            </article>

                            <article className="analytics-test-card">
                                <div className="analytics-section-heading"><div><h3>Test Journey Duration Prediction Model</h3><p>Model status: {analytics.models.duration.status.replaceAll("_", " ")} · {analytics.models.duration.targetRows} usable rows</p></div><span className={`analytics-badge ${analytics.models.duration.available ? "ready" : "warning"}`}>{analytics.models.duration.available ? "READY" : "UNAVAILABLE"}</span></div>
                                {!analytics.models.duration.available && <p className="analytics-muted">Journey-duration model unavailable: {analytics.models.duration.reason || "insufficient valid training data."} Export more completed demo trip records and refresh the analytics data.</p>}
                                <form className="analytics-form scenario-form" onSubmit={event => predictModelTest(event, "duration", durationTestCase, setDurationTestBusy, setDurationTestError, setDurationTestResult)}>
                                    <label>Estimated distance (km)<input type="number" min="0.01" max="500" step="0.01" value={durationTestCase.distanceKm} onChange={event => setDurationTestCase(current => ({ ...current, distanceKm: event.target.value }))} required /></label>
                                    <label>Planned departure time ({analytics.operatingPolicy.timezone})<input type="time" step="60" value={durationTestCase.departureTime} onChange={event => setDurationTestCase(current => ({ ...current, departureTime: event.target.value }))} required /></label>
                                    <label>Journey direction<select value={durationTestCase.direction} onChange={event => setDurationTestCase(current => ({ ...current, direction: event.target.value }))}><option value="R2M">Residential to Metro (R2M)</option><option value="M2R">Metro to Residential (M2R)</option></select></label>
                                    <div className="analytics-form-actions"><button type="submit" disabled={durationTestBusy}>{durationTestBusy ? "Predicting…" : "Predict Journey Duration"}</button></div>
                                </form>
                                {durationTestError && <p className="analytics-inline-error" role="alert">{durationTestError}</p>}
                                <p className="analytics-note">The time is interpreted as today in the operating-policy timezone. For this model it is the boarding-time-of-day feature, matching the training data.</p>
                                {durationTestResult && <div className="analytics-prediction-result" aria-live="polite"><span>Predicted Passenger Journey Duration</span><strong>{minutes(durationTestResult.prediction.value)}</strong><p>{durationTestResult.scenario.distanceKm} km · {durationTestResult.scenario.direction} · {durationTestResult.scenario.localDate} {durationTestResult.scenario.localTime} {durationTestResult.scenario.timezone} · {durationTestResult.scenario.period === "PEAK" ? "Peak" : "Off-peak"}</p><small>{durationTestResult.model.modelVersion} · trained {durationTestResult.model.trainedAt ? new Date(durationTestResult.model.trainedAt).toLocaleString() : "timestamp unavailable"} · {durationTestResult.model.targetRows} training rows</small><p className="analytics-note">This target measures time from passenger boarding to booking completion. It excludes the wait before driver assignment.</p><details><summary>Model features and scenario inputs</summary><p>Used by this model: {(durationTestResult.model.featureNames || []).map(featureLabel).join(", ") || "none"}.</p>{durationTestResult.model.excludedFeatureNames?.length > 0 && <p>Omitted for this dataset: {durationTestResult.model.excludedFeatureNames.map(featureLabel).join(", ")}.</p>}<pre>{JSON.stringify(durationTestResult.scenario.inputFeatures, null, 2)}</pre></details></div>}
                            </article>
                        </div>
                    </section>

                    <section className="analytics-panel">
                        <h2>User-entered private-vehicle benchmarks</h2>
                        <p>These are your comparison inputs, saved only in this browser. They are not independently verified averages.</p>
                        <form className="analytics-form" onSubmit={saveBenchmarks}>
                            <label>Petrol price (₹/litre)<input type="number" min="0" step="0.01" value={benchmarks.petrolPrice} onChange={e => updateBenchmark("petrolPrice", e.target.value)} required /></label>
                            <label>Vehicle fuel efficiency (km/litre)<input type="number" min="0.01" step="0.01" value={benchmarks.fuelEfficiency} onChange={e => updateBenchmark("fuelEfficiency", e.target.value)} required /></label>
                            <label>Parking price (₹/hour)<input type="number" min="0" step="0.01" value={benchmarks.parkingPrice} onChange={e => updateBenchmark("parkingPrice", e.target.value)} required /></label>
                            <label>Parking duration (hours)<input type="number" min="0" step="0.25" value={benchmarks.parkingHours} onChange={e => updateBenchmark("parkingHours", e.target.value)} required /></label>
                            <label>Road-distance estimate<select value={benchmarks.distanceMode} onChange={e => updateBenchmark("distanceMode", e.target.value)}><option value="multiplier">Straight-line distance × multiplier</option><option value="actual">Enter actual road distance</option></select></label>
                            {benchmarks.distanceMode === "actual"
                                ? <label>Actual road distance (km)<input type="number" min="0.01" step="0.1" value={benchmarks.actualRoadDistance} onChange={e => updateBenchmark("actualRoadDistance", e.target.value)} required /></label>
                                : <label>Road-distance multiplier (1–5)<input type="number" min="1" max="5" step="0.01" value={benchmarks.roadDistanceMultiplier} onChange={e => updateBenchmark("roadDistanceMultiplier", e.target.value)} required /></label>}
                            <label>Private travel time · rush hour (minutes)<input type="number" min="0.1" step="0.1" value={benchmarks.rushTravelMinutes} onChange={e => updateBenchmark("rushTravelMinutes", e.target.value)} required /></label>
                            <label>Private travel time · off-peak (minutes)<input type="number" min="0.1" step="0.1" value={benchmarks.offpeakTravelMinutes} onChange={e => updateBenchmark("offpeakTravelMinutes", e.target.value)} required /></label>
                            <div className="analytics-form-actions"><button type="submit">Save benchmarks</button>{benchmarkMessage && <span role="status">{benchmarkMessage}</span>}</div>
                        </form>
                        <p className="analytics-note">CSV distance is a straight-line estimate. Private-vehicle fuel cost uses the actual road distance you enter, or the selected multiplier applied to the CSV distance. Cost includes fuel and parking only.</p>
                    </section>

                    <section className="analytics-panel">
                        <h2>Compare a journey scenario</h2>
                        <form className="analytics-form scenario-form" onSubmit={predict}>
                            <label>Direction<select value={scenario.direction} onChange={e => setScenario(current => ({ ...current, direction: e.target.value }))}><option value="R2M">Residential to Metro (R2M)</option><option value="M2R">Metro to Residential (M2R)</option></select></label>
                            <label>Estimated straight-line distance (km)<input type="number" min="0.01" max="500" step="0.01" value={scenario.distanceKm} onChange={e => setScenario(current => ({ ...current, distanceKm: e.target.value }))} required /></label>
                            <label>Planned departure date and time<input type="datetime-local" value={scenario.departureAt} onChange={e => setScenario(current => ({ ...current, departureAt: e.target.value }))} required /></label>
                            <div className="analytics-form-actions"><button type="submit" disabled={busy}>{busy ? "Calculating…" : "Calculate comparison"}</button>{formError && <span className="analytics-inline-error" role="alert">{formError}</span>}</div>
                        </form>
                        <p className="analytics-note">Peak/off-peak is derived from the active operating policy ({analytics.operatingPolicy.timezone}). The duration model predicts passenger time from boarding to booking completion; it excludes the wait before driver assignment and does not mean dispatch has zero wait.</p>
                        {!benchmarkError && result && comparison && <>
                            <div className="analytics-summary-grid">
                                <article><span>Selected period</span><strong>{result.scenario.period === "PEAK" ? "Rush hour" : "Off-peak"}</strong><small>{result.scenario.localTime} · {result.scenario.timezone}</small></article>
                                <article><span>Predicted CMRL fare</span><strong>{result.predictions.fare.available ? money(result.predictions.fare.value) : "Insufficient training data"}</strong><small>{result.predictions.fare.available ? result.predictions.fare.modelVersion : result.predictions.fare.reason}</small></article>
                                <article><span>Predicted passenger time</span><strong>{result.predictions.duration.available ? minutes(result.predictions.duration.value) : "Insufficient training data"}</strong><small>{result.predictions.duration.available ? "Boarding to completion" : result.predictions.duration.reason}</small></article>
                                <article><span>Private vehicle cost</span><strong>{money(comparison.privateCost)}</strong><small>Fuel {money(comparison.fuelCost)} + parking {money(comparison.parkingCost)}</small></article>
                            </div>
                            {result.predictions.fare.available && <p className="analytics-comparison-result">{comparison.costResult}; absolute difference {money(comparison.absoluteCostDifference)}{comparison.percentCostDifference === null ? "" : ` (${comparison.percentCostDifference.toFixed(1)}%)`}.</p>}
                            {result.predictions.duration.available && <p className="analytics-comparison-result">{comparison.timeResult}; absolute time difference {minutes(comparison.absoluteTimeDifference)} against your {minutes(comparison.privateMinutes)} benchmark.</p>}
                            <h3 className="analytics-table-heading">Rush-hour and off-peak comparison</h3>
                            <div className="analytics-table-scroll"><table className="analytics-table"><thead><tr><th>Period</th><th>CMRL fare</th><th>Private fuel</th><th>Parking</th><th>Private total</th><th>CMRL passenger time</th><th>Private time benchmark</th><th>Result</th></tr></thead><tbody>
                                {periodResults.map(periodResult => {
                                    const comparisonRow = compareScenario(periodResult, benchmarks, periodResult.predictions);
                                    return <tr key={periodResult.scenario.period}><td>{periodResult.scenario.period === "PEAK" ? "Rush hour" : "Off-peak"}</td><td>{periodResult.predictions.fare.available ? money(periodResult.predictions.fare.value) : "Insufficient training data"}</td><td>{money(comparisonRow?.fuelCost)}</td><td>{money(comparisonRow?.parkingCost)}</td><td>{money(comparisonRow?.privateCost)}</td><td>{periodResult.predictions.duration.available ? minutes(periodResult.predictions.duration.value) : "Insufficient training data"}</td><td>{minutes(comparisonRow?.privateMinutes)}</td><td>{comparisonRow?.costResult || "No prediction"}{comparisonRow?.timeResult ? ` · ${comparisonRow.timeResult}` : ""}</td></tr>;
                                })}
                            </tbody></table></div>
                            {periodResults.length < 2 && <p className="analytics-muted">The active operating policy does not provide a scenario for both periods on the selected calendar.</p>}
                        </>}
                        {benchmarkError && <p className="analytics-muted">Enter and save valid private-vehicle benchmarks to see cost and time comparisons. {benchmarkError}</p>}
                    </section>
                </>}
            </div>
        </main>
    );
}

export default DataAnalyticsPage;
