// while this entire code may look big, it merely imports the verifyToken function and checks for JWT validation.
// The code here identifies each possible error with its own reply.code(..)


const { verifyToken } = require("../utils/jwt");

async function authenticateAdmin(request, reply) {
    const authorization = request.headers.authorization;

    // Check whether the Authorization header exists
    if (!authorization) {
        return reply.code(401).send({
            message: "Authentication token is required."
        });
    }

    // Expect: Authorization: Bearer <token>
    const [scheme, token] = authorization.split(" ");

    if (scheme !== "Bearer" || !token) {
        return reply.code(401).send({
            message: "Invalid authorization format."
        });
    }

    try {
        const payload = verifyToken(token);

        // This endpoint is restricted to admins
        if (payload.role !== "ADMIN" || !payload.adminId) {
            return reply.code(403).send({
                message: "Admin access required."
            });
        }

        // Make verified identity available to later handlers
        request.admin = payload;
    } catch (error) {
        return reply.code(401).send({
            message: "Invalid or expired token."
        });
    }
}

module.exports = authenticateAdmin;