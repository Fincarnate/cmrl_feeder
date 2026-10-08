const jwt = require("jsonwebtoken");
const config = require("../config/env");

// Generate a token after successful login
function generateToken(admin) {
    const payload = {
        accountId: admin.account_id,
        name: admin.name,
        email: admin.email,
        role: admin.role
    };

    return jwt.sign(payload, config.jwt.secret, {
        expiresIn: config.jwt.expiresIn
    });
}

// Verify a token received from a client
function verifyToken(token) {
    return jwt.verify(token, config.jwt.secret);
}

module.exports = {
    generateToken,
    verifyToken
};