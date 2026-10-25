// while this entire code may look big, it merely imports the verifyToken function and checks for JWT validation.
// The code here identifies each possible error with its own reply.code(..)


const authenticateIdentity = require("./identityAuth");
const requireAdmin = authenticateIdentity("ADMIN");

async function authenticateAdmin(request, reply) {
    await requireAdmin(request, reply);
    if (request.identity) request.admin = request.identity;
}

module.exports = authenticateAdmin;
