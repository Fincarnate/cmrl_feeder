const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const pool = require("../../../db/pool");

const outputPath = path.resolve(__dirname, "../../../../exports/demo-trip-history.csv");
let exportQueue = Promise.resolve();

const columns = [
    "exported_at_utc",
    "booking_id",
    "trip_id",
    "booking_source",
    "booking_status",
    "trip_status",
    "direction",
    "passenger_demo_account",
    "driver_demo_account",
    "driver_is_demo",
    "demo_vehicle_registration",
    "seats_reserved",
    "requested_at_utc",
    "dispatched_at_utc",
    "driver_arrived_at_utc",
    "boarded_at_utc",
    "booking_completed_at_utc",
    "trip_completed_at_utc",
    "cab_duration_seconds",
    "trip_duration_seconds",
    "fare_amount",
    "final_fare",
    "fare_currency",
    "fare_breakdown_json",
    "distance_km",
    "distance_source",
    "fare_policy_version"
];

function csvCell(value) {
    if (value === null || value === undefined) return "";
    let text = String(value);
    if (/^[=+@\t\r]/.test(text) || /^-/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}

async function writeSnapshot({ database = pool, tripId } = {}) {
    if (tripId) {
        const { rows } = await database.query(`SELECT EXISTS(
            SELECT 1 FROM booking b JOIN users u ON u.user_id=b.user_id
            WHERE b.trip_id=$1 AND u.is_demo=TRUE
        ) AS has_demo_booking`, [tripId]);
        if (!rows[0]?.has_demo_booking) return { exported: false, reason: "NO_DEMO_BOOKING" };
    }

    const { rows } = await database.query(`
      SELECT b.booking_id,t.trip_id,
        CASE WHEN b.idempotency_key LIKE 'demo-ghost:%' THEN 'SYNTHETIC' ELSE 'DEMO_ACCOUNT' END AS booking_source,
        b.booking_status,t.trip_status,b.direction,u.email AS passenger_demo_account,
        CASE WHEN d.is_demo=TRUE THEN d.email END AS driver_demo_account,
        COALESCE(d.is_demo,FALSE) AS driver_is_demo,
        CASE WHEN d.is_demo=TRUE THEN v.registration_no END AS demo_vehicle_registration,
        b.seats_reserved,
        to_char(b.requested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS requested_at_utc,
        to_char(t.dispatched_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS dispatched_at_utc,
        to_char(b.driver_arrived_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS driver_arrived_at_utc,
        to_char(b.boarded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS boarded_at_utc,
        to_char(b.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS booking_completed_at_utc,
        to_char(t.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS trip_completed_at_utc,
        CASE WHEN b.boarded_at IS NOT NULL AND b.completed_at IS NOT NULL
          THEN GREATEST(0,ROUND(EXTRACT(EPOCH FROM (b.completed_at-b.boarded_at))))::bigint END AS cab_duration_seconds,
        CASE WHEN t.dispatched_at IS NOT NULL AND t.completed_at IS NOT NULL
          THEN GREATEST(0,ROUND(EXTRACT(EPOCH FROM (t.completed_at-t.dispatched_at))))::bigint END AS trip_duration_seconds,
        b.fare_amount,b.final_fare,b.fare_currency,b.fare_breakdown::text AS fare_breakdown_json,
        b.distance_km,b.distance_source,b.fare_policy_version
      FROM booking b
      JOIN users u ON u.user_id=b.user_id AND u.is_demo=TRUE
      LEFT JOIN trip t ON t.trip_id=b.trip_id
      LEFT JOIN driver d ON d.driver_id=t.driver_id
      LEFT JOIN vehicle v ON v.vehicle_id=t.vehicle_id
      ORDER BY b.requested_at,b.booking_id
    `);

    const exportedAt = new Date().toISOString();
    const content = [
        columns.map(csvCell).join(","),
        ...rows.map(row => [exportedAt, ...columns.slice(1).map(column => row[column])].map(csvCell).join(","))
    ].join("\r\n") + "\r\n";

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const temporaryPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    try {
        await fs.writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
        await fs.rename(temporaryPath, outputPath);
    } catch (error) {
        await fs.rm(temporaryPath, { force: true }).catch(() => {});
        throw error;
    }

    return { exported: true, rows: rows.length, path: outputPath };
}

function exportDemoTripHistory(options) {
    const task = exportQueue.then(() => writeSnapshot(options));
    exportQueue = task.catch(() => {});
    return task;
}

module.exports = { exportDemoTripHistory, outputPath };
