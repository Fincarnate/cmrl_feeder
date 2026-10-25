export function JourneyChoices({ direction, setDirection, mode, setMode }) {
    return <>
        <div className="journey-choice-grid" role="group" aria-label="Travel direction">
            <button type="button" className={direction === "RESIDENTIAL_TO_METRO" ? "journey-choice selected" : "journey-choice"} onClick={() => setDirection("RESIDENTIAL_TO_METRO")}>Residential to Metro</button>
            <button type="button" className={direction === "METRO_TO_RESIDENTIAL" ? "journey-choice selected" : "journey-choice"} onClick={() => setDirection("METRO_TO_RESIDENTIAL")}>Metro to Residential</button>
        </div>
        {direction && <div className="journey-choice-grid mode-choices" role="group" aria-label="Booking type">
            <button type="button" className={mode === "BOOKING" ? "journey-choice selected" : "journey-choice"} onClick={() => setMode("BOOKING")}>Booking <small>Shared DRT queue</small></button>
            <button type="button" className={mode === "DIRECT" ? "journey-choice selected" : "journey-choice"} onClick={() => setMode("DIRECT")}>Direct Booking <small>Immediate assignment if available</small></button>
        </div>}
    </>;
}

export function LocationStatus({ location, onRetry, onManual }) {
    if (!location.direction) return <p className="data-note">Choose a travel direction to begin. We’ll request your location only after you choose.</p>;
    const canFallback = ["denied", "timeout", "unavailable", "error"].includes(location.status);
    return <div className={location.status === "error" ? "location-status error" : "location-status"} role="status">
        <p>{location.message}</p>
        {canFallback && <div className="form-actions"><button type="button" className="secondary-button" onClick={onRetry}>Retry location</button><button type="button" onClick={onManual}>Continue with manual selection</button></div>}
    </div>;
}

export function JourneyFields({ direction, stations, zones, points, stationId, zoneId, pointId, onStation, onZone, onPoint, seats, setSeats, disabled }) {
    const field = (label, value, onChange, rows, placeholder) => <label>{label}<select value={value} disabled={disabled} onChange={e => onChange(e.target.value)}><option value="">{placeholder}</option>{rows.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>;
    return <div className="drt-form-grid">
        {direction === "RESIDENTIAL_TO_METRO" && field("Residential zone", zoneId, onZone, zones, "Select a zone")}
        {field("Residential service point · planned pickup", pointId, onPoint, points, "Select a service point")}
        {field(direction === "RESIDENTIAL_TO_METRO" ? "Destination metro station" : "Origin metro station", stationId, onStation, stations, "Select a station")}
        {direction === "METRO_TO_RESIDENTIAL" && field("Residential zone", zoneId, onZone, zones, "Select a zone")}
        <label>Passengers / seats<select value={seats} disabled={disabled} onChange={e => setSeats(Number(e.target.value))}>{[1,2,3,4,5,6,7,8].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
    </div>;
}

export function FareBreakdown({ quote }) {
    if (!quote) return null;
    const breakdown = quote.breakdown || {};
    return <section className="fare-card" aria-label="Fare breakdown"><h3>Fare estimate · ₹{quote.fare} {quote.currency}</h3>
        <p>Base ₹{breakdown.baseFare} + distance ₹{breakdown.distanceFare} + booking fee ₹{breakdown.bookingFee}. {quote.distanceKm} km straight-line estimate; road routing is not configured.</p>
        <small>Fare policy v{quote.policyVersion} · expires {new Date(quote.expiresAt).toLocaleTimeString()}</small>
        <p>No payment is collected here. Confirming creates the booking only.</p>
    </section>;
}
