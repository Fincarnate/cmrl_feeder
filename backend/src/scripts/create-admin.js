const bcrypt = require("bcrypt");
const pool = require("../db/pool");

async function createAdmin() {
    const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
    if (!ADMIN_NAME || !ADMIN_EMAIL || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) {
        throw new Error("Set ADMIN_NAME, ADMIN_EMAIL, and an ADMIN_PASSWORD of at least 8 characters.");
    }
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    const result = await pool.query(
        `INSERT INTO admins (name, email, password_hash, role) VALUES ($1, LOWER($2), $3, 'ADMIN') ON CONFLICT (email) DO NOTHING RETURNING id`,
        [ADMIN_NAME.trim(), ADMIN_EMAIL.trim(), hash]
    );
    console.log(result.rowCount ? "Admin account created." : "An admin with that email already exists; no changes made.");
}

createAdmin().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
}).finally(() => pool.end());
