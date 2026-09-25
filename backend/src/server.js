require('dotenv').config();         //read from .env file
const express = require('express');
const app = express();              //start express server
const PORT = process.env.PORT || 5000;   //either .env or 5000

app.get('/', (req, res) => {                            //testing root route here
    res.json({ 
        message: "CMRL feeder backend is running" 
    });
});
async function startServer() {                           //database connection
  try {
    if (!process.env.JWT_SECRET ||
        process.env.JWT_SECRET.length < 32) {
      throw new Error("Set a JWT_SECRET of at least 32 characters");
    }

    await pool.query("SELECT 1");

    console.log("PostgreSQL connected successfully");

    app.listen(PORT, () => {
      console.log(
        `Server running at http://localhost:${PORT}`
      );
    });

  } catch (error) {
    console.error("Server startup failed:", error.message);
    process.exit(1);
  }
}

app.listen(PORT, () => {
  console.log(`SERVER is running the port is ${PORT}`);
});