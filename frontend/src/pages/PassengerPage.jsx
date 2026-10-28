import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest } from "../api/client";
import ServiceMap from "../components/ServiceMap";
import { FareBreakdown, JourneyChoices, JourneyFields, LocationStatus } from "../components/PassengerJourneyControls";
import usePassengerLocation from "../hooks/usePassengerLocation";
import "leaflet/dist/leaflet.css";

function uniqueBy(rows, idKey, nameKey) {
    return [...new Map(rows.map(row => [row[idKey], { id: row[idKey], name: row[nameKey], ...row }])).values()];
}
function buildMapData(rows) {
    const stations = uniqueBy(rows, "station_id", "station_name").map(s => ({ id: s.station_id, name: s.station_name, coordinates: s.station_geometry, boundary: s.station_boundary, serviceArea: s.station_service_area, serviceRadiusKm: s.station_service_radius_km, geofenceRadiusMeters: s.station_geofence_radius_m, geofenceSource: s.station_geofence_source }));
    const zones = uniqueBy(rows, "zone_id", "zone_name").map(z => ({ id: z.zone_id, name: z.zone_name, stationId: z.station_id, boundary: z.zone_boundary, center: z.zone_center, overlaps: z.zone_overlaps }));
    const servicePoints = rows.filter(row => row.point_id && row.point_geometry).map(row => ({ id: row.point_id, name: row.point_name, zoneId: row.zone_id, coordinates: row.point_geometry, bookable: row.is_bookable, coordinateSource: row.point_coordinate_source }));
    return { stations, zones, servicePoints, driverLocations: [], passengerLocations: [] };
}
function dateInTimezone(timeZone) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const part = type => parts.find(item => item.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
}

export default function PassengerPage({ session, onLogout }) {
    const token = session.token;
    const [areas, setAreas] = useState([]), [areasLoaded, setAreasLoaded] = useState(false);
    const [bookings, setBookings] = useState([]), [schedules, setSchedules] = useState([]), [direction, setDirection] = useState("");
    const [mode, setMode] = useState("BOOKING"), [manualMode, setManualMode] = useState(false);
    const [stationId, setStationId] = useState(""), [zoneId, setZoneId] = useState(""), [pointId, setPointId] = useState(""), [seats, setSeats] = useState(1);
    const [dailyDepartureTime, setDailyDepartureTime] = useState("08:00");
    const [acknowledged, setAcknowledged] = useState(false), [quote, setQuote] = useState(null);
    const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [directUnavailable, setDirectUnavailable] = useState(false);
    const { location, request: requestLocation, reset: resetLocation } = usePassengerLocation(token);

    const refreshBookings = useCallback(async () => {
        const data = await apiRequest("/bookings", { token });
        setBookings(data.bookings || []);
    }, [token]);
    const refreshSchedules = useCallback(async () => {
        const data = await apiRequest("/bookings/schedules", { token });
        setSchedules(data.schedules || []);
    }, [token]);
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const [rows] = await Promise.all([apiRequest("/bookings/service-areas", { token }), refreshBookings(), refreshSchedules()]);
                if (alive) { setAreas(rows); setAreasLoaded(true); }
            } catch (e) { if (e.status === 401 || e.status === 403) onLogout(); else if (alive) setError(e.message); }
        })();
        return () => { alive = false; };
    }, [token, refreshBookings, refreshSchedules, onLogout]);
    useEffect(() => {
        let active = true;
        const timer = setInterval(() => Promise.all([refreshBookings(),refreshSchedules()]).catch(e => { if (active && (e.status === 401 || e.status === 403)) onLogout(); }), 7000);
        return () => { active = false; clearInterval(timer); };
    }, [refreshBookings, refreshSchedules, onLogout]);

    const allStations = useMemo(() => uniqueBy(areas, "station_id", "station_name"), [areas]);
    const zones = useMemo(() => uniqueBy(areas.filter(row => !stationId || row.station_id === stationId), "zone_id", "zone_name"), [areas, stationId]);
    const points = useMemo(() => uniqueBy(areas.filter(row => row.zone_id === zoneId && row.point_id && row.is_bookable), "point_id", "point_name"), [areas, zoneId]);
    const selectedPoint = areas.find(row => row.point_id === pointId);
    const locationResult = location.result;
    const gpsCoordinates = location.coordinates;

    function applyLocationResolution(result, selectedDirection) {
        if (selectedDirection === "RESIDENTIAL_TO_METRO" && ["IN_ZONE", "NEARBY_RECOMMENDATION"].includes(result.result)) {
            setZoneId(result.zone_id); setPointId(result.point_id); setStationId(result.station_id); setAcknowledged(false); setQuote(null);
        } else if (selectedDirection === "METRO_TO_RESIDENTIAL" && result.result === "AT_SUPPORTED_STATION") {
            setStationId(result.stations[0]?.station_id || ""); setZoneId(""); setPointId(""); setQuote(null);
        }
    }

    function chooseDirection(next) {
        setDirection(next); setManualMode(false); setMode("BOOKING"); setStationId(""); setZoneId(""); setPointId("");
        setAcknowledged(false); setQuote(null); setError(""); setNotice(""); setDirectUnavailable(false); resetLocation(); requestLocation(next, applyLocationResolution);
    }
    function continueManually() {
        setManualMode(true); setQuote(null); setAcknowledged(false);
        const currentStation=allStations.find(station=>station.station_id===stationId);
        const station=currentStation||allStations[0];
        if(station){
            const usable=areas.find(row=>row.station_id===station.station_id&&row.is_bookable&&row.point_id);
            setStationId(station.station_id);
            if(usable){setZoneId(usable.zone_id);setPointId(usable.point_id);}
        }
    }
    function changeStation(value) {
        if (direction === "METRO_TO_RESIDENTIAL" && locationResult?.result === "AT_SUPPORTED_STATION" && !manualMode
            && !locationResult.stations.some(station => station.station_id === value)) return;
        setStationId(value);
        const row=areas.find(candidate=>candidate.station_id===value&&candidate.is_bookable&&candidate.point_id);
        setZoneId(row?.zone_id||""); setPointId(row?.point_id||"");
        setQuote(null); setAcknowledged(false);
    }
    function changeZone(value) {
        const gpsZone = direction === "RESIDENTIAL_TO_METRO" && locationResult?.result === "IN_ZONE"
            ? locationResult.containingZones?.find(candidate => candidate.zone_id === value) : null;
        if (gpsZone) {
            setStationId(gpsZone.station_id); setZoneId(value); setPointId(gpsZone.point_id);
            setQuote(null); setAcknowledged(false); return;
        }
        const eligiblePoints = areas.filter(row => row.zone_id === value && row.is_bookable && row.point_id);
        const point = eligiblePoints.find(row=>row.point_id===pointId)||eligiblePoints[0];
        setZoneId(value); setPointId(point?.point_id || "");
        if (point) setStationId(point.station_id);
        setQuote(null); setAcknowledged(false);
    }
    function changePoint(value) { setPointId(value); setQuote(null); if (locationResult?.result === "NEARBY_RECOMMENDATION") setAcknowledged(false); }
    function payload() {
        return { direction, stationId, zoneId, servicePointId: pointId, seatsRequested: Number(seats), bookingIntent: mode,
            ...(mode === "BOOKING" ? { dailyDepartureTime } : {}),
            originLocationSource: manualMode ? "MANUAL" : "GPS", latitude: manualMode ? null : gpsCoordinates?.latitude,
            longitude: manualMode ? null : gpsCoordinates?.longitude, pickupAcknowledged: acknowledged };
    }
    function changeMode(next) {
        setMode(next); setQuote(null); setDirectUnavailable(false); setManualMode(false); setAcknowledged(false);
        if(location.status==="resolved"&&locationResult)applyLocationResolution(locationResult,direction);
        else {setStationId("");setZoneId("");setPointId("");}
    }
    const outsideStation = direction === "METRO_TO_RESIDENTIAL" && !manualMode && locationResult?.result === "OUTSIDE_STATION";
    const locationReady = location.direction === direction && location.status === "resolved" && locationResult && !["OUTSIDE_STATION", "UNAVAILABLE"].includes(locationResult.result);
    const locationAllowed = manualMode || locationReady;
    const fieldsReady = Boolean(direction && areasLoaded && stationId && zoneId && pointId && locationAllowed && !outsideStation);
    const acknowledgementRequired = direction === "RESIDENTIAL_TO_METRO" && !manualMode && locationResult?.result === "NEARBY_RECOMMENDATION";
    const canQuote = fieldsReady && (!acknowledgementRequired || acknowledged);
    const shownMapRows = useMemo(() => areas.filter(row => (!stationId || row.station_id === stationId) && (!zoneId || row.zone_id === zoneId)), [areas, stationId, zoneId]);
    const mapData = useMemo(() => buildMapData(shownMapRows), [shownMapRows]);
    const markers = useMemo(() => gpsCoordinates && !manualMode ? [{ id: "passenger-gps", name: "Your current GPS location", position: [gpsCoordinates.latitude, gpsCoordinates.longitude], radius: 8, pathOptions: { color: "#175cd3", fillColor: "#84caff", fillOpacity: 1 }, popup: "Your current location (GPS)" }] : [], [gpsCoordinates, manualMode]);
    const selectedMapPoint = useMemo(() => selectedPoint?.point_geometry?.coordinates ? { name: `${selectedPoint.point_name} · planned ${direction === "RESIDENTIAL_TO_METRO" ? "pickup" : "drop-off"}`, position: [selectedPoint.point_geometry.coordinates[1], selectedPoint.point_geometry.coordinates[0]] } : undefined, [selectedPoint, direction]);

    async function preview() {
        setBusy(true); setError(""); setNotice("");
        try { setQuote(await apiRequest("/bookings/fare-preview", { token, method: "POST", body: JSON.stringify(payload()) })); setDirectUnavailable(false); }
        catch (e) { setQuote(null); setError(e.message); }
        finally { setBusy(false); }
    }
    async function book() {
        if (!quote?.quoteToken) return;
        setBusy(true); setError(""); setNotice("");
        try {
            if(mode==="BOOKING"){
                const result=await apiRequest("/bookings/schedules",{token,method:"POST",headers:{"Idempotency-Key":crypto.randomUUID()},body:JSON.stringify({...payload(),quoteToken:quote.quoteToken})});
                setNotice(`Daily booking schedule created. Next departure: ${new Date(result.schedule.next_departure_at).toLocaleString()} (${result.schedule.timezone}). Today's trip will appear when that departure is due.`);
                await refreshSchedules();
            }else{
                await apiRequest("/bookings", { token, method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ ...payload(), quoteToken: quote.quoteToken }) });
                setNotice("Direct booking request submitted. Check the trip status and driver details below for the actual assignment result.");
                await refreshBookings();
            }
            setQuote(null);
        } catch (e) {
            setError(e.message);
            if (mode === "DIRECT" && e.status === 409) { setDirectUnavailable(true); setNotice("Direct Booking is unavailable right now. You can switch to Booking to join the shared queue, or cancel."); }
        } finally { setBusy(false); }
    }
    async function cancel(id) {
        try { await apiRequest(`/bookings/${id}/cancel`, { token, method: "POST" }); setNotice("Booking cancelled."); await refreshBookings(); }
        catch (e) { setError(e.message); }
    }
    async function cancelRecurringSchedule(id) {
        try { await apiRequest(`/bookings/schedules/${id}/cancel`,{token,method:"POST"});setNotice("Schedule cancelled. Past trips and occurrences remain in your history.");await refreshSchedules(); }
        catch(e){setError(e.message);}
    }
    async function getOtp(id) {
        try { const data = await apiRequest(`/bookings/${id}/otp`, { token }); setNotice(`Boarding OTP: ${data.otp} · expires ${new Date(data.expiresAt).toLocaleTimeString()} (development retrieval)`); }
        catch (e) { setError(e.message); }
    }
    const visibleStations = direction === "METRO_TO_RESIDENTIAL" && locationResult?.result === "AT_SUPPORTED_STATION" && !manualMode
        ? allStations.filter(station => locationResult.stations.some(match => match.station_id === station.station_id)) : allStations;
    const stationChoices = visibleStations.map(station => ({ id: station.station_id, name: station.station_name }));
    const overlappingChoices = direction === "RESIDENTIAL_TO_METRO" && !manualMode && locationResult?.result === "IN_ZONE"
        ? locationResult.containingZones || [] : [];
    const zoneChoices = (overlappingChoices.length > 1 ? overlappingChoices : zones).map(zone => ({ id: zone.zone_id, name: `${zone.zone_name}${zone.zone_overlaps || overlappingChoices.length > 1 ? " · overlapping area" : ""}` }));
    const pointChoices = points.map(point => ({ id: point.point_id, name: point.point_name }));

    return <main className="dashboard-page"><div className="dashboard-layout">
        <header className="dashboard-header"><div><h1>CMRL Feeder</h1><p>Passenger · {session.identity.name}</p></div><button onClick={onLogout}>Log out</button></header>
        <section className="drt-panel"><h2>Plan your feeder journey</h2>
            <JourneyChoices direction={direction} setDirection={chooseDirection} mode={mode} setMode={changeMode} />
            <LocationStatus location={location} onRetry={() => requestLocation(direction, applyLocationResolution)} onManual={continueManually}
                showManual={Boolean(direction && mode === "BOOKING" && location.status === "resolved" && !manualMode)} />
            {manualMode && <p className="data-note">Manual selection · your origin has not been GPS-verified. Select a configured station or residential pickup location.</p>}
            {direction && <JourneyFields direction={direction} stations={stationChoices} zones={zoneChoices} points={pointChoices}
                stationId={stationId} zoneId={zoneId} pointId={pointId} onStation={changeStation} onZone={changeZone} onPoint={changePoint}
                seats={seats} setSeats={n => { setSeats(n); setQuote(null); }} disabled={busy || !areasLoaded || (!manualMode && location.status !== "resolved")} />}
            {zoneId && !points.length && <p className="dashboard-alert" role="status">This residential zone is mapped, but it has no verified operational pickup point yet. An unverified map reference cannot be booked. Ask an administrator to configure and verify a safe pickup point.</p>}
            {acknowledgementRequired && <label className="acknowledge-pickup"><input type="checkbox" checked={acknowledged} onChange={e => { setAcknowledged(e.target.checked); setQuote(null); }} /> I understand pickup will be at {selectedPoint?.point_name || "the suggested service point"}, not at my GPS location.</label>}
            {outsideStation && <div className="dashboard-alert" role="alert"><p>This GPS location is outside all supported station boundaries. Choose a configured station and residential pickup manually to continue.</p>
                {mode === "DIRECT" && !manualMode && <button type="button" className="secondary-button" onClick={continueManually}>Book anyway</button>}</div>}
            {mode === "BOOKING" && direction && <label className="schedule-time-field">Daily departure time
                <input type="time" value={dailyDepartureTime} onChange={event => { setDailyDepartureTime(event.target.value); setQuote(null); }} required />
                <small>Repeats every day until cancelled. Each trip is created when its scheduled departure arrives.</small>
            </label>}
            {!areasLoaded && <p className="loading-note">Loading configured service locations…</p>}
            {areasLoaded && !areas.length && <p className="dashboard-alert" role="alert">No configured station, service-zone, and service-point relationships are available. Feeder bookings cannot be created until legitimate geographic data is configured.</p>}
            {error && <p className="dashboard-alert" role="alert">{error}</p>}{notice && <p className="login-success" role="status">{notice}{directUnavailable && <button className="inline-action" onClick={() => { setMode("BOOKING"); setQuote(null); setDirectUnavailable(false); }}>Switch to Booking</button>}</p>}
            <div className="form-actions"><button disabled={busy || !canQuote} onClick={preview}>{busy ? "Working…" : "Calculate fare"}</button>{quote && <button disabled={busy} onClick={book}>{mode === "DIRECT" ? "Confirm Direct Booking" : "Save Daily Booking"} · ₹{quote.fare}</button>}</div>
            <FareBreakdown quote={quote} />
        </section>
        {areas.length > 0 && direction && <ServiceMap data={mapData} markers={markers} selectedPoint={selectedMapPoint} selectedZoneId={zoneId} layers={{ driverLocations: false }} />}
        <section className="drt-panel"><h2>Daily recurring schedules</h2>{schedules.length===0?<p>No recurring schedules yet.</p>:<div className="booking-list">{schedules.map(schedule=>{
            const today=dateInTimezone(schedule.timezone);
            const todaysOccurrence=(schedule.occurrences||[]).find(occurrence=>occurrence.serviceDate===today);
            return <article key={schedule.schedule_id}><div><strong>{schedule.direction.replaceAll("_"," ")} · {schedule.schedule_status}</strong>
                <p>{schedule.station_name} · {schedule.zone_name} · {schedule.point_name} · {schedule.seats_reserved} seat(s)</p>
                <p>Daily departure: {schedule.daily_departure_time.slice(0,5)} ({schedule.timezone})</p>
                {schedule.schedule_status==="ACTIVE"&&<p>Next scheduled departure: {new Date(schedule.next_departure_at).toLocaleString("en-IN",{timeZone:schedule.timezone})}</p>}
                <p>Today's trip: {todaysOccurrence?`${todaysOccurrence.status}${todaysOccurrence.bookingStatus?` · booking ${todaysOccurrence.bookingStatus}`:""}${todaysOccurrence.tripId?` · trip ${todaysOccurrence.tripStatus||"WAITING_FOR_PASSENGERS"}`:""}`:
                    schedule.schedule_status==="ACTIVE"&&schedule.next_service_date===today?"Not generated yet":"No trip generated today"}</p>
                {todaysOccurrence?.driverName&&<p>Driver: {todaysOccurrence.driverName}{todaysOccurrence.vehicleRegistration?` · ${todaysOccurrence.vehicleRegistration}`:""}</p>}
                {(schedule.occurrences||[]).length>0&&<details><summary>Recent occurrences</summary><ul>{schedule.occurrences.map(occurrence=><li key={occurrence.occurrenceId}>{occurrence.serviceDate} · {occurrence.status}{occurrence.tripStatus?` · ${occurrence.tripStatus}`:""}{occurrence.driverName?` · ${occurrence.driverName}`:""}</li>)}</ul></details>}
            </div>{schedule.schedule_status==="ACTIVE"&&<button className="secondary-button" onClick={()=>cancelRecurringSchedule(schedule.schedule_id)}>Cancel schedule</button>}</article>;
        })}</div>}</section>
        <section className="drt-panel"><h2>One-time bookings</h2>{bookings.length === 0 ? <p>No one-time bookings yet.</p> : <div className="booking-list">{bookings.map(b => <article key={b.booking_id}><div><strong>{b.direction?.replaceAll("_", " ") || "Feeder journey"} · Direct</strong><p>{b.booking_status} · {b.seats_reserved} seat(s) · ₹{b.fare_amount} {b.fare_currency}</p><p>{b.trip_status || "Waiting for trip"}{b.driver_name ? ` · ${b.driver_name} · ${b.registration_no || ""}` : ""}{b.dispatch_deadline ? ` · dispatch deadline ${new Date(b.dispatch_deadline).toLocaleTimeString()}` : ""}</p>{b.boarding_deadline && <p>Boarding deadline: {new Date(b.boarding_deadline).toLocaleTimeString()}</p>}</div><div className="booking-actions">{b.booking_status === "BOARDING" && <button onClick={() => getOtp(b.booking_id)}>Show boarding OTP</button>}{["REQUESTED", "ASSIGNED"].includes(b.booking_status) && <button className="secondary-button" onClick={() => cancel(b.booking_id)}>Cancel</button>}</div></article>)}</div>}</section>
    </div></main>;
}
