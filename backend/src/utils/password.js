const bcrypt = require("bcrypt");

const SALT_ROUNDS = 12; // this is just the degree of hashing

// Convert a plain-text password into a secure hash using bcrypt.
async function hashPassword(password) {
    return bcrypt.hash(password, SALT_ROUNDS);
}

// Check a password against its stored hash. (the admin entered password from frontend is checked with backend)
// Note that this is just a function that is called so no db variables are involved yet.
async function comparePassword(password, hashedPassword) {
    return bcrypt.compare(password, hashedPassword);
}

module.exports = {
    hashPassword,
    comparePassword
};
// Here the functions have been exported to run asynchronusly in the background.
// hashing takes time.