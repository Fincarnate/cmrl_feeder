const express = require("express");

const { authenticate } = require("../middleware/auth.middleware");
const { authorize } = require("../middleware/role.middleware");

const router = express.Router();

router.get(
  "/test",
  authenticate,
  authorize("ADMIN"),
  (req, res) => {
    res.status(200).json({
      message: "Admin access granted",
      user: req.user
    });
  }
);

module.exports = router;