// authServices.js purely checks authentication of an admin account before generating the token at the end.
// I.E it checks with the db, we already executed the query from adminQueries.js, just importing here

const adminQueries = require("../../db/queries/adminQueries");
const { comparePassword } = require("../../utils/password");
const { generateToken } = require("../../utils/jwt");
const pool = require("../../db/pool");
const { hashPassword } = require("../../utils/password");

async function loginAdmin(email, password) {
    // Step 1: Find the admin in PostgreSQL
    const admin = await adminQueries.findAdminByEmail(email);

    // Step 2: Reject if the admin doesn't exist
    if (!admin) {
        return null;
    }

    // Step 3: Allow only ADMIN accounts
    if (admin.role !== "ADMIN") {
        return null;
    }

    // Step 4: Compare the submitted password with the stored hash
    const passwordMatches = await comparePassword(
        password,
        admin.password_hash
    );

    if (!passwordMatches) {
        return null;
    }

    // Step 5: Generate a JWT after successful authentication
    const token = generateToken(admin);

    // Step 6: Return the token and safe admin information
    return {
        token,
        admin: {
            id: admin.id,
            name: admin.name,
            email: admin.email,
            role: admin.role
        }
    };
}

async function loginIdentity(email, password) {
    const admin = await adminQueries.findAdminByEmail(email);
    if (admin && String(admin.role).toUpperCase() === "ADMIN" && await comparePassword(password, admin.password_hash)) {
        return issueIdentity(admin.id, admin.name, admin.email, "ADMIN");
    }
    const passenger = (await pool.query(
        "SELECT user_id AS id, full_name AS name, email, password_hash FROM users WHERE LOWER(email) = $1 LIMIT 1", [email]
    )).rows[0];
    if (passenger && await comparePassword(password, passenger.password_hash)) {
        return issueIdentity(passenger.id, passenger.name, passenger.email, "PASSENGER");
    }
    const driver = (await pool.query(
        "SELECT driver_id AS id, full_name AS name, email, password_hash FROM driver WHERE LOWER(email) = $1 LIMIT 1", [email]
    )).rows[0];
    if (driver && await comparePassword(password, driver.password_hash)) {
        return issueIdentity(driver.id, driver.name, driver.email, "DRIVER");
    }
    return null;
}

function issueIdentity(id, name, email, role) {
    const identity = { id, name, email, role };
    return { token: generateToken(identity), identity };
}

async function registerIdentity(input) {
    const role = typeof input.role === "string" ? input.role.toUpperCase() : "";
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    const phone = typeof input.phone === "string" ? input.phone.trim() : "";
    if (!["PASSENGER", "DRIVER"].includes(role)) throw Object.assign(new Error("Choose Passenger or Driver."), { statusCode: 400 });
    if (!name || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 150 || !/^\+?[0-9]{10,15}$/.test(phone)) {
        throw Object.assign(new Error("Enter a valid name, email, and phone number."), { statusCode: 400 });
    }
    if (typeof input.password !== "string" || input.password.length < 8 || input.password.length > 72) {
        throw Object.assign(new Error("Password must be 8 to 72 characters."), { statusCode: 400 });
    }
    const license = typeof input.licenseNumber === "string" ? input.licenseNumber.trim() : "";
    const registration = typeof input.vehicleRegistration === "string" ? input.vehicleRegistration.trim().toUpperCase() : "";
    const vehicleCapacity = input.vehicleCapacity;
    if (role === "DRIVER" && (!license || license.length > 50 || !registration || registration.length > 30 ||
        !Number.isInteger(vehicleCapacity) || vehicleCapacity < 1 || vehicleCapacity > 99)) {
        throw Object.assign(new Error("Driver license, vehicle registration, and passenger capacity from 1 to 99 are required."), { statusCode: 400 });
    }
    const passwordHash = await hashPassword(input.password);
    const client = await pool.connect();
    let result;
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`email:${email}`]);
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`phone:${phone}`]);
        const duplicate = await client.query(
            `SELECT EXISTS (SELECT 1 FROM admins WHERE LOWER(email) = $1)
             OR EXISTS (SELECT 1 FROM users WHERE LOWER(email) = $1 OR phone_number = $2)
             OR EXISTS (SELECT 1 FROM driver WHERE LOWER(email) = $1 OR phone_number = $2)
             AS duplicate_found`, [email, phone]
        );
        if (duplicate.rows[0].duplicate_found) {
            const conflict = new Error("An account already uses that email or phone number.");
            conflict.statusCode = 409;
            throw conflict;
        }
        if (role === "PASSENGER") {
            result = await client.query(
                "INSERT INTO users (full_name, email, phone_number, password_hash) VALUES ($1, $2, $3, $4) RETURNING user_id AS id, full_name AS name, email",
                [name, email, phone, passwordHash]
            );
        } else {
            result = await client.query(
                "INSERT INTO driver (full_name, email, phone_number, driving_license_no, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING driver_id AS id, full_name AS name, email",
                [name, email, phone, license, passwordHash]
            );
            await client.query("INSERT INTO vehicle (driver_id, registration_no, max_capacity) VALUES ($1, $2, $3)", [result.rows[0].id, registration, vehicleCapacity]);
        }
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally { client.release(); }
    return issueIdentity(result.rows[0].id, result.rows[0].name, result.rows[0].email, role);
}

module.exports = {
    loginAdmin,
    loginIdentity,
    registerIdentity
};
