// to load the .env variables into the source code, we use dotenv.
// env.js loads .env variables or sets default values if not present.

require("dotenv").config();         //loads .env

function loadGeographyConfig(values = process.env) {
    function number(name, { min = -Infinity, max = Infinity, positive = false } = {}) {
        const raw = values[name];
        if (raw === undefined || raw === null || String(raw).trim() === "") throw new Error(`${name} is required. Configure it in backend/.env before running the geographic seed.`);
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || (positive && parsed <= 0) || parsed < min || parsed > max) {
            throw new Error(`${name} must be a finite${positive ? " positive" : ""} number${min !== -Infinity || max !== Infinity ? ` between ${min} and ${max}` : ""}.`);
        }
        return parsed;
    }
    return {
        station: { name: "Thirumangalam Metro Station", latitude: number("THIRUMANGALAM_STATION_LAT", { min: -90, max: 90 }), longitude: number("THIRUMANGALAM_STATION_LON", { min: -180, max: 180 }) },
        metroServiceRadiusKm: number("DRT_METRO_SERVICE_RADIUS_KM", { positive: true }),
        stationGeofenceRadiusM: number("DRT_STATION_GEOFENCE_RADIUS_M", { positive: true }),
        serviceZoneRadiusKm: number("DRT_SERVICE_ZONE_RADIUS_KM", { positive: true }),
        zones: [
            { name: "Collector Nagar", latitude: number("COLLECTOR_NAGAR_CENTER_LAT", { min: -90, max: 90 }), longitude: number("COLLECTOR_NAGAR_CENTER_LON", { min: -180, max: 180 }), coordinateSource: "USER_PROVIDED_APPROXIMATE" },
            { name: "Golden Flats", latitude: number("GOLDEN_FLATS_CENTER_LAT", { min: -90, max: 90 }), longitude: number("GOLDEN_FLATS_CENTER_LON", { min: -180, max: 180 }), coordinateSource: "OPENSTREETMAP_MAPCARTA_REFERENCE" }
        ]
    };
}

module.exports = {
    port: process.env.PORT || 5000,
    frontendOrigin: process.env.FRONTEND_ORIGIN || "http://localhost:5173",
    drtWorkerIntervalMs: Number(process.env.DRT_WORKER_INTERVAL_MS || 1000),
    drtStopArrivalRadiusM: (() => {
        const radius=Number(process.env.DRT_STOP_ARRIVAL_RADIUS_M || 200);
        if(!Number.isFinite(radius)||radius<25||radius>1000) throw new Error("DRT_STOP_ARRIVAL_RADIUS_M must be between 25 and 1000 metres.");
        return radius;
    })(),
    demo: {
        enabled: process.env.DEMO_SIMULATION_ENABLED === "true",
        nodeEnv: process.env.NODE_ENV || "development",
        m2rAvailableTarget: Number(process.env.DEMO_M2R_AVAILABLE_TARGET || 6),
        r2mAvailableTarget: Number(process.env.DEMO_R2M_AVAILABLE_TARGET || 6),
        driverPoolSizePerDirection: Number(process.env.DEMO_DRIVER_POOL_SIZE_PER_DIRECTION || 12),
        passengerPoolSize: Number(process.env.DEMO_PASSENGER_POOL_SIZE || 12),
        movementEnabled: process.env.DEMO_DRIVER_MOVEMENT_ENABLED !== "false",
        locationUpdateIntervalMs: Number(process.env.DEMO_DRIVER_LOCATION_UPDATE_INTERVAL_MS || 5000),
        ghostPassengersEnabled: process.env.DEMO_GHOST_PASSENGERS_ENABLED === "true",
        ghostPassengerIntervalSeconds: Number(process.env.DEMO_GHOST_PASSENGER_INTERVAL_SECONDS || 60),
        maxActiveGhostBookings: Number(process.env.DEMO_MAX_ACTIVE_GHOST_BOOKINGS || 12),
        autoCompleteTrips: process.env.DEMO_AUTO_COMPLETE_TRIPS !== "false",
        accountPassword: process.env.DEMO_ACCOUNT_PASSWORD || "",
        tripHistoryCsv: process.env.DEMO_TRIP_HISTORY_CSV || ""
    },

    db: {
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD
    },

    jwt: {
        secret: process.env.JWT_SECRET,
        expiresIn: process.env.JWT_EXPIRES_IN || "1d"
    },
    otpDeliveryMode: process.env.OTP_DELIVERY_MODE || (process.env.NODE_ENV === "production" ? "unconfigured" : "development"),
    loadGeographyConfig
};
