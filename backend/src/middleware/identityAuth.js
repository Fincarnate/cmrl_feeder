const { verifyToken } = require("../utils/jwt");

function authenticateIdentity(expectedRole) {
    return async function identityPreHandler(request, reply) {
        const authorization = request.headers.authorization || "";
        const [scheme, token, extra] = authorization.split(" ");
        if (scheme !== "Bearer" || !token || extra) {
            return reply.code(401).send({ message: "A valid bearer token is required." });
        }
        try {
            const identity = verifyToken(token);
            if (!identity.identityId || identity.role !== expectedRole) {
                return reply.code(403).send({ message: `${expectedRole} access required.` });
            }
            request.identity = identity;
        } catch {
            return reply.code(401).send({ message: "Invalid or expired token." });
        }
    };
}

module.exports = authenticateIdentity;
