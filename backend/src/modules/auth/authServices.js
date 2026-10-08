// authServices.js purely checks authentication of an admin account before generating the token at the end.
// I.E it checks with the db, we already executed the query from adminQueries.js, just importing here

const adminQueries = require("../../db/queries/adminQueries");
const { comparePassword } = require("../../utils/password");
const { generateToken } = require("../../utils/jwt");

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

module.exports = {
    loginAdmin
};