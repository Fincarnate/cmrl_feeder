// authController.js purely handles http requests

const { loginIdentity, registerIdentity } = require("./authServices");

async function login(request, reply) {
    try {
        const { email, password } = request.body || {};

        // Validate the request body
        if (
            typeof email !== "string" ||
            typeof password !== "string" ||
            !email.trim() ||
            !password
        ) {
            return reply.code(400).send({
                message: "Email and password are required."
            });
        }

        const result = await loginIdentity(email.trim().toLowerCase(), password);

        // Reject invalid credentials
        if (!result) {
            return reply.code(401).send({
                message: "Invalid email or password."
            });
        }

        // Return the JWT and safe admin details
        return reply.code(200).send({
            message: "Login successful.",
            token: result.token,
            identity: result.identity
        });
    } catch (error) {
        request.log.error(error);

        return reply.code(500).send({
            message: "Internal server error."
        });
    }
}

async function register(request, reply) {
    try {
        const result = await registerIdentity(request.body || {});
        return reply.code(201).send({ message: "Registration successful.", token: result.token, identity: result.identity });
    } catch (error) {
        if (error.statusCode === 400) return reply.code(400).send({ message: error.message });
        if (error.statusCode === 409) return reply.code(409).send({ message: error.message });
        if (error.code === "23505") return reply.code(409).send({ message: "An account already uses that email, phone, license, or vehicle registration." });
        request.log.error(error);
        return reply.code(500).send({ message: "Unable to create account." });
    }
}

module.exports = {
    login,
    register
};
