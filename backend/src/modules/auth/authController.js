// authController.js purely handles http requests

const { loginAdmin } = require("./authServices");

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

        // Authenticate the admin
        const result = await loginAdmin(email.trim(), password);

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
            admin: result.admin
        });
    } catch (error) {
        request.log.error(error);

        return reply.code(500).send({
            message: "Internal server error."
        });
    }
}

module.exports = {
    login
};