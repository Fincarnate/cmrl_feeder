const pool = require("../pool");

async function getDashboardSummary() {
    const query = `
        SELECT
            (
                SELECT COUNT(*)
                FROM driver
                WHERE UPPER(COALESCE(shift_status, '')) = 'AVAILABLE'
            ) AS available_drivers,
            (
                SELECT COUNT(*)
                FROM users
            ) AS total_passengers
    `;

    const result = await pool.query(query);
    const summary = result.rows[0];

    return {
        availableDrivers: Number(summary.available_drivers),
        totalPassengers: Number(summary.total_passengers)
    };
}

module.exports = {
    getDashboardSummary
};
