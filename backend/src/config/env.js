// to load the .env variables into the source code, we use dotenv.
// env.js loads .env variables or sets default values if not present.

require("dotenv").config();         //loads .env

module.exports = {
    port: process.env.PORT || 5000,

    db: {
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD
    },

    jwt: {
        secret: process.env.JWT_SECRET,
        expiresIn: process.env.JWT_EXPIRES_IN || "1d"
    }
};