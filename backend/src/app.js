
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth.routes");
const adminRoutes = require("./routes/admin.routes");

const app = express();

app.use(express.json({ limit: "10kb" }));

app.use(cors({
  origin: "http://localhost:5173"
}));

app.get("/", (req, res) => {
  res.json({
    message: "CMRL Feeder API is running"
  });
});

app.use("/api/auth", authRoutes);

app.use("/api/admin", adminRoutes);

module.exports = app;