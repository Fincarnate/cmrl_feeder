// To export functions that query from the database to frontend
const pool = require("../pool");

async function findAdminByEmail(email) {            //finding/returning an admin account via email
    const query = `
        SELECT
            id,
            name,
            email,
            password_hash,
            role
        FROM admins
        WHERE email = $1
        LIMIT 1
    `;

    const result = await pool.query(query, [email]);

    return result.rows[0] || null;
}

module.exports = {
    findAdminByEmail
};