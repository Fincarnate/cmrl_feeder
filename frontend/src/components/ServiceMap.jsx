import { CircleMarker, GeoJSON, MapContainer, Popup, TileLayer, useMap } from "react-leaflet";
import { useEffect, useMemo, useRef } from "react";

const center = [13.0827, 80.2707];
const tileUrl = import.meta.env.VITE_MAP_TILE_URL || "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const EMPTY_ITEMS = Object.freeze([]);

function FitPoints({ points }) {
    const map = useMap();
    const didFit = useRef(false);
    useEffect(() => {
        if (points.length && !didFit.current) {
            map.fitBounds(points, { padding: [32, 32], maxZoom: 13 });
            didFit.current = true;
        }
    }, [map, points]);
    return null;
}

function SelectedPointView({ point, zoom }) {
    const map = useMap();
    useEffect(() => { if (point?.position) map.setView(point.position, zoom, { animate: true }); }, [map, point, zoom]);
    return null;
}

export default function ServiceMap({ data, markers = EMPTY_ITEMS, polygons = EMPTY_ITEMS, selectedPoint, onPointSelect, layers = {}, mapCenter = center, zoom = 11 }) {
    const stations = data?.stations || EMPTY_ITEMS;
    const zones = data?.zones || EMPTY_ITEMS;
    const points = data?.servicePoints || EMPTY_ITEMS;
    const drivers = data?.driverLocations || EMPTY_ITEMS;
    const coordinate = (geometry) => geometry?.type === "Point" ? [geometry.coordinates[1], geometry.coordinates[0]] : null;
    const positions = useMemo(() => [
        ...stations.map(s => coordinate(s.coordinates)),
        ...points.map(p => coordinate(p.coordinates)),
        ...drivers.map(d => coordinate(d.coordinates))
    ].filter(Boolean), [stations, points, drivers]);
    const features = useMemo(() => [...stations.filter(s => s.boundary).map(s => ({ ...s.boundary, properties: { name: s.name, kind: "station" } })),
        ...zones.filter(z => z.boundary).map(z => ({ ...z.boundary, properties: { name: z.name, kind: "zone" } })),
        ...polygons.map(p => ({ ...p.geometry, properties: { name: p.name, kind: p.kind || "custom" } }))], [stations, zones, polygons]);
    return <section className="map-shell" aria-label="Service map">
        <MapContainer center={mapCenter} zoom={zoom} scrollWheelZoom className="service-map">
            <TileLayer url={tileUrl} attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>' />
            {(layers.boundaries !== false) && features.map((feature, index) => <GeoJSON key={`${feature.properties.kind}-${feature.properties.name}-${index}`} data={feature} style={f => ({ color: f.properties.kind === "station" ? "#175cd3" : "#12b76a", weight: 2, fillOpacity: 0.1 })} onEachFeature={(f, layer) => layer.bindPopup(f.properties.name || "Service area")} />)}
            {(layers.stations !== false) && stations.filter(s => coordinate(s.coordinates)).map(s => <CircleMarker key={`station-${s.id}`} center={coordinate(s.coordinates)} radius={7} pathOptions={{ color: "#175cd3", fillColor: "#2e90fa", fillOpacity: 1 }}><Popup>Station: {s.name}</Popup></CircleMarker>)}
            {(layers.servicePoints !== false) && points.filter(p => coordinate(p.coordinates)).map(p => <CircleMarker key={`point-${p.id}`} center={coordinate(p.coordinates)} radius={5} pathOptions={{ color: "#b54708", fillColor: "#f79009", fillOpacity: 1 }}><Popup>Service point: {p.name}</Popup></CircleMarker>)}
            {(layers.driverLocations !== false) && drivers.filter(d => coordinate(d.coordinates)).map(d => <CircleMarker key={`driver-${d.id}`} center={coordinate(d.coordinates)} radius={7} pathOptions={{ color: "#027a48", fillColor: "#32d583", fillOpacity: 1 }}><Popup>Driver: {d.name}<br />Updated: {new Date(d.recordedAt).toLocaleTimeString()}</Popup></CircleMarker>)}
            {markers.map(marker => <CircleMarker key={marker.id} center={marker.position} radius={marker.radius || 6} pathOptions={marker.pathOptions || { color: "#6941c6", fillColor: "#9b8afb", fillOpacity: 1 }} eventHandlers={{ click: () => onPointSelect?.(marker) }}><Popup>{marker.popup || marker.name}</Popup></CircleMarker>)}
            {selectedPoint && <CircleMarker center={selectedPoint.position} radius={10} pathOptions={{ color: "#7f56d9", fillColor: "#d6bbfb", fillOpacity: 0.9 }}><Popup>{selectedPoint.name || "Selected location"}</Popup></CircleMarker>}
            <FitPoints points={positions} />
            <SelectedPointView point={selectedPoint} zoom={zoom} />
        </MapContainer>
        <div className="map-legend"><span><i className="legend-station" /> Stations</span><span><i className="legend-zone" /> Service zones</span><span><i className="legend-point" /> Service points</span><span><i className="legend-driver" /> Recent driver locations</span></div>
    </section>;
}
