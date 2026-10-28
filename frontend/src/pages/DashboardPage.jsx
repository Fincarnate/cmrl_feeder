import { useEffect, useRef, useState } from "react";
import { apiRequest } from "../api/client";
import ServiceMap from "../components/ServiceMap";
import "leaflet/dist/leaflet.css";

function DashboardPage({ session, onLogout }) {
    const [summary, setSummary] = useState(null);
    const [mapData, setMapData] = useState(null);
    const [error, setError] = useState("");
    const [updatedAt, setUpdatedAt] = useState(null);
    const [operations,setOperations]=useState(null);
    const [demoFleet,setDemoFleet]=useState(null);
    const [fareForm,setFareForm]=useState(null);
    const [operatingForm,setOperatingForm]=useState(null);
    const [policyMessage,setPolicyMessage]=useState("");
    const busy = useRef(false);

    useEffect(() => {
        async function refresh() {
            if (busy.current) return;
            busy.current = true;
            try {
                const [nextSummary, nextMap,nextOperations,nextDemoFleet] = await Promise.all([
                    apiRequest("/dashboard/summary", { token: session.token }),
                    apiRequest("/dashboard/map-data", { token: session.token }),
                    apiRequest("/dashboard/operations", { token: session.token }),
                    apiRequest("/dashboard/demo-fleet", { token: session.token })
                ]);
                setSummary(nextSummary);
                setMapData(nextMap);
                setOperations(nextOperations);
                setDemoFleet(nextDemoFleet);
                setUpdatedAt(new Date());
                setError("");
            } catch (requestError) {
                if (requestError.status === 401 || requestError.status === 403) {
                    onLogout();
                    return;
                }
                setError(requestError.message || "Unable to reach the server. Please try again later.");
            } finally { busy.current = false; }
        }
        refresh();
        const timer = window.setInterval(refresh, 2000);
        return () => window.clearInterval(timer);
    }, [session.token, onLogout]);

    useEffect(()=>{let alive=true;apiRequest("/dashboard/policies",{token:session.token}).then(data=>{if(!alive)return;setFareForm({baseFare:data.fare.base_fare,perKmRate:data.fare.per_km_rate,minimumFare:data.fare.minimum_fare,bookingFee:data.fare.booking_fee,peakMultiplier:data.fare.peak_multiplier,offpeakMultiplier:data.fare.offpeak_multiplier});const periods=data.operating.peak_periods||[];setOperatingForm({timezone:data.operating.timezone,morningStart:periods[0]?.start||"07:00",morningEnd:periods[0]?.end||"10:00",eveningStart:periods[1]?.start||"16:30",eveningEnd:periods[1]?.end||"20:30",peakDispatchWaitMinutes:data.operating.peak_dispatch_wait_minutes,offpeakDispatchWaitMinutes:data.operating.offpeak_dispatch_wait_minutes,peakBoardingGraceMinutes:data.operating.peak_boarding_grace_minutes,offpeakBoardingGraceMinutes:data.operating.offpeak_boarding_grace_minutes,otpValidityMinutes:data.operating.otp_validity_minutes,driverLocationMaxAgeSeconds:data.operating.driver_location_max_age_seconds,minimumDispatchPassengers:data.operating.minimum_dispatch_passengers,maximumVehicleCapacity:data.operating.maximum_vehicle_capacity});}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[session.token]);

    async function saveFare(event){event.preventDefault();setPolicyMessage("");try{const data=await apiRequest("/dashboard/policies/fare",{token:session.token,method:"PATCH",body:JSON.stringify(fareForm)});setFareForm({baseFare:data.fare.base_fare,perKmRate:data.fare.per_km_rate,minimumFare:data.fare.minimum_fare,bookingFee:data.fare.booking_fee,peakMultiplier:data.fare.peak_multiplier,offpeakMultiplier:data.fare.offpeak_multiplier});setPolicyMessage(`Fare policy v${data.fare.version} saved; existing quotes stay unchanged.`);}catch(e){setPolicyMessage(e.message);}}
    async function saveOperating(event){event.preventDefault();setPolicyMessage("");try{const payload={...operatingForm,peakPeriods:[{start:operatingForm.morningStart,end:operatingForm.morningEnd},{start:operatingForm.eveningStart,end:operatingForm.eveningEnd}]};delete payload.morningStart;delete payload.morningEnd;delete payload.eveningStart;delete payload.eveningEnd;const data=await apiRequest("/dashboard/policies/operating",{token:session.token,method:"PATCH",body:JSON.stringify(payload)});setPolicyMessage(`Operating policy v${data.operating.version} saved; active timer snapshots remain unchanged.`);}catch(e){setPolicyMessage(e.message);}}
    const updateField=(setter,key,value)=>setter(current=>({...current,[key]:value}));

    return (
        <main className="dashboard-page">
            <div className="dashboard-layout">
                <header className="dashboard-header">
                    <div>
                        <h1>CMRL Feeder</h1>
                        <p>Operations dashboard · {session.identity.name}</p>
                    </div>
                    <button type="button" onClick={onLogout}>
                        Log out
                    </button>
                </header>

                {error ? <p className="dashboard-alert" role="alert">{error}{summary && " Showing the last successful update."}</p> : null}

                {!summary && <p className="loading-note">Loading operations data…</p>}

                {summary ? (
                    <>
                    <div className="dashboard-stats">
                        <article><span>Total passengers</span><strong>{summary.totalPassengers}</strong><small>Registered accounts</small></article>
                        <article><span>Available drivers</span><strong>{summary.availableDrivers}</strong><small>Marked available for shifts</small></article>
                        <article><span>Online drivers</span><strong>{summary.onlineDrivers}</strong><small>Online or available status</small></article>
                        <article><span>Active bookings</span><strong>{summary.activeBookings}</strong><small>Active, confirmed, or in progress</small></article>
                    </div>
                    <div className="map-heading"><div><h2>Service network</h2><p>{updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}` : "Waiting for first update"} · refreshes every 2 seconds</p></div></div>
                    {demoFleet && <section className="drt-panel"><h2>Demo fleet</h2>{!demoFleet.enabled?<p>Simulator disabled. Enable it in backend/.env for a local demonstration.</p>:<>
                        <p>DEMO simulator enabled · {demoFleet.movementEnabled?"moving":"stationary"} locations · Ghost passengers {demoFleet.ghostPassengersEnabled?"enabled":"disabled"}</p>
                        <div className="dashboard-stats">{["M2R","R2M"].map(direction=><article key={direction}><span>DEMO {direction}</span><strong>{demoFleet.drivers?.[direction]?.available||0} available</strong><small>Target {demoFleet.target?.[direction]} · {demoFleet.drivers?.[direction]?.busy||0} busy · {demoFleet.drivers?.[direction]?.vehicles||0} vehicles</small></article>)}<article><span>DEMO synthetic bookings</span><strong>{demoFleet.activeGhostBookings}</strong><small>{demoFleet.poolSize} demo drivers · latest fix {demoFleet.lastUpdateAt?new Date(demoFleet.lastUpdateAt).toLocaleTimeString():"not updated"}</small></article></div>
                        {(demoFleet.shortfalls?.M2R||demoFleet.shortfalls?.R2M)&&<p className="dashboard-alert">DEMO pool shortfall · M2R: {demoFleet.shortfalls.M2R||0}, R2M: {demoFleet.shortfalls.R2M||0}</p>}{demoFleet.lastError&&<p className="dashboard-alert">DEMO simulator error: {demoFleet.lastError}</p>}
                    </>}</section>}
                    {mapData && <ServiceMap data={mapData} />}
                    {mapData && !mapData.stations.length && !mapData.zones.length && !mapData.servicePoints.length && !mapData.driverLocations.length && <p className="empty-map">No station, service point, or recent driver location records have coordinates yet. Add real records to the database to populate the map.</p>}
                    {mapData?.passengerLocationAvailability && <p className="data-note">{mapData.passengerLocationAvailability}</p>}
                    <div className="admin-data-grid">
                        <section className="drt-panel"><h2>Active trips and dispatch queue</h2>{!operations?.activeTrips.length?<p>No active trips or queued bookings.</p>:<table className="operations-table"><thead><tr><th>Trip</th><th>Direction</th><th>State</th><th>Seats</th><th>Deadline</th><th>Bookings</th></tr></thead><tbody>{operations.activeTrips.map(t=><tr key={t.trip_id}><td>{t.station_name}</td><td>{t.trip_direction?.replaceAll("_"," ")}</td><td>{t.trip_status}</td><td>{t.occupied_seats}/{t.seat_capacity||"—"}</td><td>{t.dispatch_deadline?new Date(t.dispatch_deadline).toLocaleTimeString():"—"}</td><td>{t.bookings?.map(b=>`${b.status} · ₹${b.fare}`).join("; ")}</td></tr>)}</tbody></table>}</section>
                        <section className="drt-panel"><h2>Resolved bookings</h2>{!operations?.resolvedBookings.length?<p>No completed, cancelled, failed, or no-show bookings.</p>:<table className="operations-table"><thead><tr><th>Status</th><th>Direction</th><th>Fare</th><th>Requested</th></tr></thead><tbody>{operations.resolvedBookings.map(b=><tr key={b.booking_id}><td>{b.booking_status}</td><td>{b.direction?.replaceAll("_"," ")}</td><td>{b.fare_amount?`${b.fare_currency} ${b.fare_amount}`:"—"}</td><td>{new Date(b.requested_at).toLocaleString()}</td></tr>)}</tbody></table>}</section>
                        <section className="drt-panel"><h2>Dispatch failures and no-shows</h2>{!operations?.recentFailures.length?<p>No recent dispatch failures or no-shows.</p>:<table className="operations-table"><thead><tr><th>Event</th><th>Reason / details</th><th>Time</th></tr></thead><tbody>{operations.recentFailures.map(e=><tr key={e.event_id}><td>{e.event_type}</td><td>{JSON.stringify(e.details)}</td><td>{new Date(e.created_at).toLocaleString()}</td></tr>)}</tbody></table>}</section>
                    </div>
                    <div className="admin-data-grid">
                        <form className="drt-panel" onSubmit={saveFare}><h2>Fare policy</h2>{fareForm?<><div className="policy-grid">{[["baseFare","Base fare"],["perKmRate","Per km"],["minimumFare","Minimum fare"],["bookingFee","Booking fee"],["peakMultiplier","Peak multiplier"],["offpeakMultiplier","Off-peak multiplier"]].map(([key,label])=><label key={key}>{label}<input type="number" min="0" step="0.01" value={fareForm[key]} onChange={e=>updateField(setFareForm,key,e.target.value)} required /></label>)}</div><button className="policy-save">Save new fare version</button></>:<p>Loading policy…</p>}</form>
                        <form className="drt-panel" onSubmit={saveOperating}><h2>Operating policy</h2>{operatingForm?<><div className="policy-grid">{[["timezone","Timezone"],["morningStart","Morning peak starts"],["morningEnd","Morning peak ends"],["eveningStart","Evening peak starts"],["eveningEnd","Evening peak ends"],["peakDispatchWaitMinutes","Peak dispatch wait (min)"],["offpeakDispatchWaitMinutes","Off-peak dispatch wait (min)"],["peakBoardingGraceMinutes","Peak boarding grace (min)"],["offpeakBoardingGraceMinutes","Off-peak boarding grace (min)"],["otpValidityMinutes","OTP validity (min)"],["driverLocationMaxAgeSeconds","Location freshness (sec)"],["minimumDispatchPassengers","Minimum passengers"],["maximumVehicleCapacity","Max vehicle seats"]].map(([key,label])=><label key={key}>{label}<input type={key.toLowerCase().includes("start")||key.toLowerCase().includes("end")?"time":key==="timezone"?"text":"number"} min={key==="timezone"?undefined:1} step="1" value={operatingForm[key]} onChange={e=>updateField(setOperatingForm,key,e.target.value)} required /></label>)}</div><button className="policy-save">Save new operating version</button></>:<p>Loading policy…</p>}</form>
                    </div>
                    {policyMessage&&<p className="login-success" role="status">{policyMessage}</p>}
                    </>
                ) : null}
            </div>
        </main>
    );
}

export default DashboardPage;
