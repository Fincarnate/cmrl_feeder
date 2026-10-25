// jwt.js generates a jwt only after successful login.
// also exports a function that checks for jwt validity

const jwt = require("jsonwebtoken");
const config = require("../config/env");

function generateToken(identity) {
    const payload = {
        sub: identity.id,
        identityId: identity.id,
        email: identity.email,
        role: identity.role
    };
    if (identity.role === "ADMIN") payload.adminId = identity.id;
    if (identity.role === "PASSENGER") payload.userId = identity.id;
    if (identity.role === "DRIVER") payload.driverId = identity.id;

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
