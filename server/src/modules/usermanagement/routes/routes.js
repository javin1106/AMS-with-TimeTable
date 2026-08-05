const express = require("express");
const router = express.Router();
const {
  register,
  login,
  update,
  verification, // Include the resetPassword function
  otp,
  captcha
} = require("../controllers/usercontroller.js");
const { forgotPassword } = require("../controllers/forgotpasswordroute.js");
const { resetPassword } = require("../controllers/resetpasswordroute.js");
const { checkRole} = require("../../checkRole.middleware.js")

router.route("/login").post(login);
// Unauthenticated by necessity — it is the challenge you solve *before* signing
// in. It reads no database and stores nothing per request (the answer travels in
// a signed token, see captcha.js), so the only thing there is to abuse is CPU,
// which `captchaLimiter` in loginRateLimit.js caps.
router.get("/captcha", captcha);
router.route("/update").put(checkRole(['admin']), update);
router.post("/register", checkRole(['admin']) , register);
router.post("/verify",verification)
router.post("/otp",otp);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword); // Include the new endpoint

module.exports = router;
