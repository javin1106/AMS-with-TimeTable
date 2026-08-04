// require("dotenv").config(); // must be first — loads .env before any process.env reads

const User = require("../../../models/usermanagement/user");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const jwtSecret = process.env.JWT_SECRET;

const OTP = require("../../../models/usermanagement/otp");
const otpGenerator = require("otp-generator");
const fs = require("fs");
const ejs = require("ejs");
const path = require("path");
const ejsTemplatePath = path.join(__dirname, "otpbody.ejs");
const mailSender = require("../../mailsender");
const { notifyUserCreated } = require("./adminNotifier");
const { sendWelcomeEmail, resolveFrontendBase } = require("./welcomeMailer");
const {
  getFacultyDepartmentByEmail,
  getTimetableDepartment,
  findDepartmentCoordinator,
} = require("./facultyDepartment");
const { issueChallenge, verifyChallenge } = require("../captcha");
const captchaGate = require("../captchaGate");

exports.register = async (req, res, next) => {
  const { email, password, roles, dept } = req.body;
  let resolvedDepartment = typeof dept === "string" ? dept.trim() : "";

  const existingUser = await User.findOne({ email: email })
  if (existingUser !== null) {
    if (existingUser.email.includes(email)) {
      return res.status(400).json({ message: "User already exists, use forgot password to reset your password" })
    }
  }

  if (!password || password.length < 6) {
    return res.status(400).json({ message: "Password less than 6 characters" });
  }
  try {
    if (resolvedDepartment) {
      const timetableDepartment = await getTimetableDepartment(resolvedDepartment);
      if (!timetableDepartment) {
        return res.status(400).json({
          message: "Select a valid department from the timetable",
        });
      }
      resolvedDepartment = timetableDepartment;
    }

    if (roles?.includes("iams-dept-admin")) {
      if (!resolvedDepartment) {
        resolvedDepartment = await getFacultyDepartmentByEmail(email);
      }
      if (!resolvedDepartment) {
        return res.status(400).json({
          message: "Department is required for an iLEED Department Admin",
        });
      }

      const existingCoordinator = await findDepartmentCoordinator(resolvedDepartment);
      if (existingCoordinator) {
        return res.status(409).json({
          message: `${resolvedDepartment} already has an iLEED Department Admin`,
        });
      }
    }

    // Hash the password using bcrypt
    bcrypt.hash(password, 10, async (hashErr, hash) => {
      if (hashErr) {
        return res
          .status(500)
          .json({ message: "Password hashing failed", error: hashErr.message });
      }

      // Create the user with the hashed password
      try {
        const user = await User.create({
          name: email,
          email: email,
          password: hash,
          role: roles,
          dept: resolvedDepartment,
          attendanceDepartments: resolvedDepartment ? [resolvedDepartment] : [],
          isEmailVerified: false,
          isFirstLogin: false,
        });

        const isStudentOnly = (roles || []).every((r) => String(r).toUpperCase() === "STUDENT");
        if (!isStudentOnly) {
          notifyUserCreated(user);
        }

        sendWelcomeEmail({
          email,
          frontendBase: resolveFrontendBase(req),
          heading: "Your XCEED account has been created",
          intro: `<p>An account has been created for this email address on the
                    XCEED platform (NIT Jalandhar)${
                      roles?.length
                        ? ` with the role(s): <strong>${roles.join(", ")}</strong>`
                        : ""
                    }.</p>`,
          accountCreated: true,
        });

        const userResponse = user.toObject();
        delete userResponse.password;
        res.status(201).json({
          message: "User successfully created",
          user: userResponse,
        });
      } catch (createErr) {
        res.status(400).json({
          message: "User not successful created",
          error: createErr.message,
        });
      }
    });
  } catch (err) {
    res.status(401).json({
      message: "User not successful created",
      error: err.message,
    });
  }
};

//verifying otp entered
exports.verification = async (req, res) => {
  try {
    const { email, otp } = req.body;
    const validOTP = await OTP.findOne({ email, otp });
    console.log(validOTP);
    if (!validOTP) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP",
      });
    }

    await OTP.deleteOne({ email, otp });
    const update = {
      $set: { isEmailVerified: true }
    };
    const user = await User.findOneAndUpdate(
      { email: email },
      update,
      { returnOriginal: false }
    )
    res.status(200).json({
      success: true,
      message: "Email verified successfully",
    });
  } catch (e) {
    console.log("Error in verifying OTP ", e);
    res.status(500).json({
      success: false,
      message: "Error in verifying OTP",
    });
  }
}

/**
 * A bcrypt hash of a value nobody knows, compared against when the account does
 * not exist.
 *
 * Without it the not-found path skips bcrypt entirely and answers in about a
 * millisecond, while a wrong password takes the ~100ms bcrypt costs. That gap is
 * readable over the network, so identical wording would still tell an attacker
 * which addresses are registered. Doing the same work either way closes it.
 */
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString("hex"), 10);

// One answer for every way of failing. Distinguishing "no such user" from "wrong
// password" turns the login form into a directory of who holds an account here.
const INVALID_CREDENTIALS = "Invalid email or password.";

/** Only what the client actually needs; never the document. */
const sessionUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
});

/** A fresh captcha image for the login form. */
exports.captcha = (req, res) => {
  const { token, svg, expiresIn } = issueChallenge();
  // No-store: a cached challenge is a challenge somebody else already solved.
  res.set("Cache-Control", "no-store");
  return res.status(200).json({ token, svg, expiresIn });
};

// login
exports.login = async (req, res) => {
  const { email, password, captchaToken, captchaAnswer } = req.body;

  // Typed, not merely present. A JSON body can carry `{"email": {"$ne": null}}`,
  // which reaches findOne as a Mongo operator and matches an arbitrary account.
  // It is not an authentication bypass — the password still has to verify
  // against whoever it matched — but it lets an unauthenticated caller pick
  // which document the server goes and looks at, and there is no reason to
  // allow it.
  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    return res.status(400).json({ message: "Email and password are required." });
  }

  // Checked before the database and before bcrypt. The point of the captcha is
  // to make an automated attempt cost something, which it only does if the
  // attempt is refused before the server spends the ~100ms bcrypt costs.
  //
  // A failed captcha is not counted as a failed sign-in: it never got as far as
  // testing a password, and counting it would let anybody push a colleague over
  // the rate limit by posting nonsense with their address in it.
  if (captchaGate.captchaRequired(email)) {
    const check = verifyChallenge(captchaToken, captchaAnswer);
    if (!check.ok) {
      return res.status(400).json({
        message:
          check.reason === "expired" || check.reason === "reused"
            ? "That challenge has expired. Please try the new one."
            : "The characters did not match. Please try again.",
        captchaRequired: true,
        // Expired and already-spent tokens need a new image; a plain wrong
        // answer does not, so the user is not made to re-read a fresh one for a
        // typo.
        captchaStale: check.reason !== "wrong",
      });
    }
  }

  try {
    // `+password` because the field is select:false on the schema — the hash is
    // pulled deliberately, here, and nowhere else.
    const user = await User.findOne({ email }).select("+password");

    // Compared in both branches so the timing does not differ; see
    // DUMMY_PASSWORD_HASH.
    const matches = await bcrypt.compare(password, user?.password || DUMMY_PASSWORD_HASH);

    if (!user || !matches) {
      captchaGate.noteFailure(email);
      return res.status(401).json({
        message: INVALID_CREDENTIALS,
        // Told to the client so the next attempt can carry one, rather than
        // making it discover the requirement by being refused again.
        captchaRequired: captchaGate.captchaRequired(email),
      });
    }

    captchaGate.noteSuccess(email);

    const maxAge = 3 * 60 * 60; // 3 hours in seconds
    const token = jwt.sign({ id: user._id, email, role: user.role }, jwtSecret, {
      expiresIn: maxAge,
    });

    res.cookie("jwt", token, {
      httpOnly: true,
      maxAge: maxAge * 1000,
      secure: true,
      sameSite: "none",
    });

    return res.status(200).json({
      message: "User successfully logged in",
      // Still returned alongside the httpOnly cookie because the client stores
      // it for the Authorization header. Worth revisiting — a token in
      // localStorage is readable by any XSS, which is exactly what httpOnly on
      // the cookie is there to prevent — but removing it is a client-wide change
      // rather than a login fix.
      token,
      user: sessionUser(user),
    });
  } catch (error) {
    console.error("[usermanagement] login", error.message);
    // Never echo the underlying error: it has previously carried database
    // details straight to an unauthenticated caller.
    return res.status(500).json({ message: "An error occurred while signing in." });
  }
};

exports.update = async (req, res, next) => {
  try {
    const updatebody = req.body;
    const { email, password } = req.body;

    // Verify if the email is present
    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    // Find the user by email
    const user = await User.findOne({ email });

    // If user is not found
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    updatebody.password = hashedPassword;


    const newUser = await User.findOneAndUpdate(
      { email: email },
      updatebody,
      { returnOriginal: false },
    )

    // Save the updated user
    await newUser.save();

    return res.status(201).json({ message: "Update successful", user });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "An error occurred", error: error.message });
  }
};

const sendOTP = async (email) => {
  try {

    let result = await OTP.findOne({ email });
    var otp = null;
    if (result) {
      otp = result.otp;
      console.log("OTP already exists:", otp);
    } else {
      otp = otpGenerator.generate(6, {
        lowerCaseAlphabets: false,
        upperCaseAlphabets: false,
        specialChars: false,
      });
      await OTP.create({ email, otp });
      console.log("New OTP generated:", otp);
    }

    console.log(otp);
    const otpInfo = {
      title: "Email verification for NITJ",
      purpose:
        "Thank you for registering with NITJ. To complete your registration, please use the following OTP (One-Time Password) to verify your account:",
      OTP: otp,
    };

    const otpBody = fs.readFileSync(ejsTemplatePath, "utf-8");
    const renderedHTML = ejs.render(otpBody, otpInfo);

    // Add await here
    await mailSender(email, "Password reset OTP", renderedHTML);
    return {
      success: true,
      message: "OTP sent successfully",
    };
  } catch (e) {
    console.log("Error in sending OTP ", e);
    return {
      success: false,
      message: "Error in sending OTP",
    };
  }
};

exports.otp = async (req, res) => {
  const email = req.body.email;
  const otp = await sendOTP(email);
  res.status(201).json({
    message: "OTP sent successfully",
  });
}
