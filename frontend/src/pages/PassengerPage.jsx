import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest } from "../api/client";
import ServiceMap from "../components/ServiceMap";
import "leaflet/dist/leaflet.css";

function serviceMapData(rows) {
    const stations=new Map(),zones=new Map(),points=[];
    rows.forEach(row=>{
        if(!stations.has(row.station_id))stations.set(row.station_id,{id:row.station_id,name:row.station_name,coordinates:row.station_geometry,boundary:row.station_boundary});
        if(!zones.has(row.zone_id))zones.set(row.zone_id,{id:row.zone_id,name:row.zone_name,stationId:row.station_id,boundary:row.zone_boundary});
        points.push({id:row.point_id,name:row.point_name,zoneId:row.zone_id,coordinates:row.point_geometry});
    });
    return {stations:[...stations.values()],zones:[...zones.values()],servicePoints:points,driverLocations:[],passengerLocations:[]};
}

export default function PassengerPage({session,onLogout}) {
    const [areas,setAreas]=useState([]),[bookings,setBookings]=useState([]),[direction,setDirection]=useState("RESIDENTIAL_TO_METRO");
    const [stationId,setStationId]=useState(""),[zoneId,setZoneId]=useState(""),[pointId,setPointId]=useState(""),[seats,setSeats]=useState(1);
    const [quote,setQuote]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
    const token=session.token;
    const stations=useMemo(()=>[...new Map(areas.map(a=>[a.station_id,a])).values()],[areas]);
    const zones=useMemo(()=>areas.filter(a=>a.station_id===stationId).filter((a,i,all)=>all.findIndex(x=>x.zone_id===a.zone_id)===i),[areas,stationId]);
    const points=useMemo(()=>areas.filter(a=>a.station_id===stationId&&a.zone_id===zoneId),[areas,stationId,zoneId]);
    const mapData=useMemo(()=>serviceMapData(areas),[areas]);
    const refreshBookings=useCallback(async()=>{const data=await apiRequest("/bookings",{token});setBookings(data.bookings);},[token]);
    useEffect(()=>{let alive=true;(async()=>{try{const [areaRows]=await Promise.all([apiRequest("/bookings/service-areas",{token}),refreshBookings()]);if(alive){setAreas(areaRows);if(areaRows[0]){setStationId(areaRows[0].station_id);setZoneId(areaRows[0].zone_id);setPointId(areaRows[0].point_id);}}}catch(e){if(e.status===401||e.status===403)onLogout();else setError(e.message);}})();return()=>{alive=false;};},[token,refreshBookings,onLogout]);
    useEffect(()=>{let active=true;const load=async()=>{try{await refreshBookings();}catch(e){if(active&&(e.status===401||e.status===403))onLogout();else if(active)setError(e.message);}};const timer=setInterval(load,5000);return()=>{active=false;clearInterval(timer);};},[refreshBookings,onLogout]);
    async function preview(){setBusy(true);setError("");setNotice("");try{setQuote(await apiRequest("/bookings/fare-preview",{token,method:"POST",body:JSON.stringify({direction,stationId,zoneId,servicePointId:pointId,seatsRequested:Number(seats)})}));}catch(e){setError(e.message);}finally{setBusy(false);}}
    async function book(){setBusy(true);setError("");setNotice("");try{await apiRequest("/bookings",{token,method:"POST",headers:{"Idempotency-Key":crypto.randomUUID()},body:JSON.stringify({direction,stationId,zoneId,servicePointId:pointId,seatsRequested:Number(seats)})});setNotice("Booking request added to the dispatch queue. Fare is frozen for this booking.");setQuote(null);await refreshBookings();}catch(e){setError(e.message);}finally{setBusy(false);}}
    async function cancel(id){try{await apiRequest(`/bookings/${id}/cancel`,{token,method:"POST"});setNotice("Booking cancelled.");await refreshBookings();}catch(e){setError(e.message);}}
    async function getOtp(id){try{const data=await apiRequest(`/bookings/${id}/otp`,{token});setNotice(`Boarding OTP: ${data.otp} · expires ${new Date(data.expiresAt).toLocaleTimeString()} (development retrieval)`);}catch(e){setError(e.message);}}
    const selected=areas.find(a=>a.point_id===pointId);
    return <main className="dashboard-page"><div className="dashboard-layout">
        <header className="dashboard-header"><div><h1>CMRL Feeder</h1><p>Passenger · {session.identity.name}</p></div><button onClick={onLogout}>Log out</button></header>
        <section className="drt-panel"><h2>Request a feeder journey</h2><div className="drt-form-grid">
            <label>Direction<select value={direction} onChange={e=>setDirection(e.target.value)}><option value="RESIDENTIAL_TO_METRO">Residential to metro</option><option value="METRO_TO_RESIDENTIAL">Metro to residential</option></select></label>
            <label>Metro station<select value={stationId} onChange={e=>{const next=e.target.value;const zone=areas.find(a=>a.station_id===next);setStationId(next);setZoneId(zone?.zone_id||"");setPointId(zone?.point_id||"");setQuote(null);}}>{stations.map(s=><option key={s.station_id} value={s.station_id}>{s.station_name}</option>)}</select></label>
            <label>Service zone<select value={zoneId} onChange={e=>{const next=e.target.value;setZoneId(next);setPointId(areas.find(a=>a.zone_id===next)?.point_id||"");setQuote(null);}}>{zones.map(z=><option key={z.zone_id} value={z.zone_id}>{z.zone_name}</option>)}</select></label>
            <label>Service point<select value={pointId} onChange={e=>{setPointId(e.target.value);setQuote(null);}}>{points.map(p=><option key={p.point_id} value={p.point_id}>{p.point_name}</option>)}</select></label>
            <label>Seats<select value={seats} onChange={e=>setSeats(Number(e.target.value))}>{[1,2,3,4,5,6,7,8].map(n=><option key={n}>{n}</option>)}</select></label>
        </div>
        <div className="form-actions"><button disabled={busy||!pointId} onClick={preview}>{busy?"Working…":"Preview fare"}</button>{quote&&<button disabled={busy} onClick={book}>Request booking · ₹{quote.fare}</button>}</div>
        {quote&&<p className="quote-note">₹{quote.fare} {quote.currency} · {quote.distanceKm} km straight-line estimate · base ₹{quote.breakdown.baseFare} + distance ₹{quote.breakdown.distanceFare} + fee ₹{quote.breakdown.bookingFee} · policy v{quote.policyVersion}. Road routing is not configured.</p>}
        {error&&<p className="dashboard-alert" role="alert">{error}</p>}{notice&&<p className="login-success" role="status">{notice}</p>}</section>
        <ServiceMap data={mapData} selectedPoint={selected?{name:selected.point_name,position:[selected.point_geometry.coordinates[1],selected.point_geometry.coordinates[0]]}:undefined} />
        <section className="drt-panel"><h2>Your bookings</h2>{bookings.length===0?<p>No bookings yet.</p>:<div className="booking-list">{bookings.map(b=><article key={b.booking_id}><div><strong>{b.direction?.replaceAll("_"," ")||"Feeder journey"}</strong><p>{b.booking_status} · {b.seats_reserved} seat(s) · ₹{b.fare_amount} {b.fare_currency}</p><p>{b.trip_status||"Waiting for trip"}{b.driver_name?` · ${b.driver_name} · ${b.registration_no||""}`:""}{b.dispatch_deadline?` · dispatch deadline ${new Date(b.dispatch_deadline).toLocaleTimeString()}`:""}</p>{b.boarding_deadline&&<p>Boarding deadline: {new Date(b.boarding_deadline).toLocaleTimeString()}</p>}</div><div className="booking-actions">{b.booking_status==="BOARDING"&&<button onClick={()=>getOtp(b.booking_id)}>Show boarding OTP</button>}{["REQUESTED","ASSIGNED"].includes(b.booking_status)&&<button className="secondary-button" onClick={()=>cancel(b.booking_id)}>Cancel</button>}</div></article>)}</div>}</section>
    </div></main>;
}
