import { CircleMarker, GeoJSON, MapContainer, Popup, TileLayer, useMap } from "react-leaflet";
import { useEffect, useMemo } from "react";

const center = [13.0827, 80.2707];
const tileUrl = import.meta.env.VITE_MAP_TILE_URL || "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const EMPTY_ITEMS = Object.freeze([]);

function FitPoints({ points }) {
    const map = useMap();
    useEffect(() => {
        if (points.length) {
            map.fitBounds(points, { padding: [32, 32], maxZoom: 13 });
        }
    }, [map, points]);
    return null;
}

export default function ServiceMap({ data, markers = EMPTY_ITEMS, polygons = EMPTY_ITEMS, selectedPoint, selectedZoneId, onPointSelect, layers = {}, mapCenter = center, zoom = 11 }) {
    const stations = data?.stations || EMPTY_ITEMS;
    const zones = data?.zones || EMPTY_ITEMS;
    const points = data?.servicePoints || EMPTY_ITEMS;
    const drivers = data?.driverLocations || EMPTY_ITEMS;
    const coordinate = (geometry) => geometry?.type === "Point" ? [geometry.coordinates[1], geometry.coordinates[0]] : null;
    const positions = useMemo(() => [
        ...stations.map(s => coordinate(s.coordinates)),
        ...points.map(p => coordinate(p.coordinates)),
        ...drivers.map(d => coordinate(d.coordinates)),
        ...markers.map(marker => marker.position),
        ...(selectedPoint?.position ? [selectedPoint.position] : [])
    ].filter(Boolean), [stations, points, drivers, markers, selectedPoint]);
    const features = useMemo(() => [...stations.filter(s => s.serviceArea).map(s => ({ ...s.serviceArea, properties: { name: `${s.name} service catchment · ${s.serviceRadiusKm} km`, kind: "catchment" } })),
        ...stations.filter(s => s.boundary).map(s => ({ ...s.boundary, properties: { name: `${s.name} physical geofence · ${s.geofenceRadiusMeters} m (${s.geofenceSource || "unclassified"})`, kind: "station" } })),
        ...zones.filter(z => z.boundary).map(z => ({ ...z.boundary, properties: { name: z.name, kind: "zone", zoneId: z.id } })),
        ...polygons.map(p => ({ ...p.geometry, properties: { name: p.name, kind: p.kind || "custom", zoneId: p.zoneId } }))], [stations, zones, polygons]);
    return <section className="map-shell" aria-label="Service map">
        <MapContainer center={mapCenter} zoom={zoom} scrollWheelZoom className="service-map">
            <TileLayer url={tileUrl} attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>' />
            {(layers.boundaries !== false) && features.map((feature, index) => <GeoJSON key={`${feature.properties.kind}-${feature.properties.name}-${index}`} data={feature} style={f => ({ color: f.properties.kind === "catchment" ? "#1570ef" : f.properties.kind === "station" ? "#b42318" : f.properties.zoneId === selectedZoneId ? "#7f56d9" : "#12b76a", weight: f.properties.kind === "catchment" ? 2 : f.properties.zoneId === selectedZoneId ? 4 : 2, dashArray: f.properties.kind === "catchment" ? "8 6" : undefined, fillOpacity: f.properties.kind === "catchment" ? 0.025 : f.properties.zoneId === selectedZoneId ? 0.22 : 0.1 })} onEachFeature={(f, layer) => layer.bindPopup(f.properties.name || "Service area")} />)}
            {(layers.stations !== false) && stations.filter(s => coordinate(s.coordinates)).map(s => <CircleMarker key={`station-${s.id}`} center={coordinate(s.coordinates)} radius={7} pathOptions={{ color: "#175cd3", fillColor: "#2e90fa", fillOpacity: 1 }}><Popup>Station: {s.name}</Popup></CircleMarker>)}
            {(layers.servicePoints !== false) && points.filter(p => coordinate(p.coordinates)).map(p => <CircleMarker key={`point-${p.id}`} center={coordinate(p.coordinates)} radius={p.bookable ? 6 : 5} pathOptions={{ color: p.bookable ? "#b54708" : "#667085", fillColor: p.bookable ? "#f79009" : "#d0d5dd", fillOpacity: 1 }}><Popup>Service point: {p.name}<br />{p.bookable ? "Verified and bookable" : `Unverified reference · map only${p.coordinateSource ? ` · ${p.coordinateSource}` : ""}`}</Popup></CircleMarker>)}
            {(layers.driverLocations !== false) && drivers.filter(d => coordinate(d.coordinates)).map(d => <CircleMarker key={`driver-${d.id}`} center={coordinate(d.coordinates)} radius={7} pathOptions={{ color: d.isDemo ? "#b54708" : "#027a48", fillColor: d.isDemo ? "#fdb022" : "#32d583", fillOpacity: 1 }}><Popup>{d.isDemo ? "DEMO driver" : "Driver"}: {d.name}<br />Updated: {new Date(d.recordedAt).toLocaleTimeString()}</Popup></CircleMarker>)}
            {markers.map(marker => <CircleMarker key={marker.id} center={marker.position} radius={marker.radius || 6} pathOptions={marker.pathOptions || { color: "#6941c6", fillColor: "#9b8afb", fillOpacity: 1 }} eventHandlers={{ click: () => onPointSelect?.(marker) }}><Popup>{marker.popup || marker.name}</Popup></CircleMarker>)}
            {selectedPoint && <CircleMarker center={selectedPoint.position} radius={10} pathOptions={{ color: "#7f56d9", fillColor: "#d6bbfb", fillOpacity: 0.9 }}><Popup>{selectedPoint.name || "Selected location"}</Popup></CircleMarker>}
            <FitPoints points={positions} />
        </MapContainer>
        <div className="map-legend"><span><i className="legend-catchment" /> Station service catchment</span><span><i className="legend-station" /> Physical geofence</span><span><i className="legend-zone" /> Residential zones</span><span><i className="legend-point" /> Verified pickup points</span><span><i className="legend-reference" /> Unverified map references</span>{markers.some(marker => marker.id === "passenger-gps") && <span><i className="legend-gps" /> Your GPS location</span>}{drivers.length > 0 && <span><i className="legend-driver" /> Recent driver locations</span>}</div>
    </section>;
}
