// jwt.js generates a jwt only after successful login.
// also exports a function that checks for jwt validity

const jwt = require("jsonwebtoken");
const config = require("../config/env");

function generateToken(admin) {
    const payload = {
        adminId: admin.id,
        email: admin.email,
        role: admin.role
    };

    return jwt.sign(payload, config.jwt.secret, {
        expiresIn: config.jwt.expiresIn
    });
}

function verifyToken(token) {
    return jwt.verify(token, config.jwt.secret);
}

module.exports = {
    generateToken,
    verifyToken
};