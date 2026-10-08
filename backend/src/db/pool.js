// Creates a pool of connections, anytime a user connects using pool.query(...) an available connection is estabilished..
// Note: module.exports is the equivalent of a return type to other directories.

const { Pool } = require("pg");                     //create a new object Pool from 'pg' dependency
const config = require("../config/env");            //.env config

const pool = new Pool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password
});

module.exports = pool;