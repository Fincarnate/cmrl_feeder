import { useCallback, useRef, useState } from "react";
import { apiRequest } from "../api/client";

export default function usePassengerLocation(token) {
    const [location, setLocation] = useState({ status: "idle", result: null, coordinates: null, direction: null, message: "" });
    const requestId = useRef(0);

    const request = useCallback((direction, onResolved) => {
        const id = ++requestId.current;
        const update = (next) => { if (id === requestId.current) setLocation({ ...next, direction }); };
        if (!navigator.geolocation) {
            update({ status: "unavailable", result: null, coordinates: null, message: "Location is unavailable in this browser. You can continue with a manually selected configured location." });
            return;
        }
        update({ status: "requesting", result: null, coordinates: null, message: "Requesting your current location…" });
        navigator.geolocation.getCurrentPosition(async (position) => {
            const coordinates = { latitude: position.coords.latitude, longitude: position.coords.longitude };
            update({ status: "validating", coordinates, result: null, message: "Checking your location against the service area…" });
            try {
                const result = await apiRequest("/bookings/location-resolution", {
                    token, method: "POST", body: JSON.stringify({ direction, ...coordinates })
                });
                if (id !== requestId.current) return;
                onResolved?.(result, direction);
                const message = result.result === "IN_ZONE" ? "Your location is inside this residential service zone. The nearest service point is selected as the planned pickup."
                    : result.result === "NEARBY_RECOMMENDATION" ? `You are outside the service zone. The suggested pickup is ${result.point_name}, about ${result.distanceMeters} m from the zone boundary. Confirm this point to continue.`
                    : result.result === "AT_SUPPORTED_STATION" ? "Your location is inside a supported metro station boundary."
                    : result.result === "OUTSIDE_STATION" ? "This location is outside all supported metro station boundaries. Feeder service cannot start here."
                    : "No configured residential service zone and point are available.";
                update({ status: "resolved", coordinates, result, message });
            } catch (error) {
                if (id === requestId.current) update({ status: "error", coordinates, result: null, message: error.message || "The location could not be checked." });
            }
        }, (error) => {
            const status = error.code === 1 ? "denied" : error.code === 3 ? "timeout" : "unavailable";
            const message = status === "denied" ? "Location permission was denied. Choose manual selection to continue with configured locations." : status === "timeout" ? "Location detection timed out. Retry or choose manual selection." : "Your current location could not be detected. Retry or choose manual selection.";
            update({ status, coordinates: null, result: null, message });
        }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
    }, [token]);

    const reset = useCallback(() => { requestId.current += 1; setLocation({ status: "idle", result: null, coordinates: null, direction: null, message: "" }); }, []);
    return { location, request, reset };
}
