
const jwt = require("jsonwebtoken");            // For jwt generation. 

function generateToken(user) {
  return jwt.sign(
    {
      role: user.role                           //generates jwt token
    },
    process.env.JWT_SECRET,
    {
      subject: String(user.id),
      expiresIn: process.env.JWT_EXPIRES_IN || "1h",
      algorithm: "HS256"
    }
  );
}

module.exports = { generateToken };