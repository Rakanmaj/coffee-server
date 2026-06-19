const router = require("express").Router();
const bcrypt = require("bcrypt");
const pool = require("../db/db");
const requireAuth = require("../middleware/requireAuth");
const { signAuthToken } = require("../middleware/authToken");

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_LOGINS = 8;
const failedLogins = new Map();

router.post("/login", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const attemptKey = `${req.ip}:${email}`;

  if (!email || email.length > 254 || !password || password.length > 200) {
    return res.status(401).json({ message: "Invalid credentials" });
  }
  if (isBlocked(attemptKey)) {
    return res.status(429).json({ message: "Too many login attempts. Try again later." });
  }

  try {
    const result = await pool.query(
      "SELECT user_id, full_name, email, password_hash FROM users WHERE LOWER(email)=$1",
      [email]
    );
    const user = result.rows[0];
    const ok = user ? await bcrypt.compare(password, user.password_hash) : false;

    if (!ok) {
      recordFailure(attemptKey);
      return res.status(401).json({ message: "Invalid credentials" });
    }

    failedLogins.delete(attemptKey);
    const publicUser = {
      user_id: user.user_id,
      full_name: user.full_name,
      email: user.email,
    };
    res.json({ user: publicUser, token: signAuthToken(publicUser) });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: "Login failed" });
  }
});

router.get("/session", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

function isBlocked(key) {
  const entry = failedLogins.get(key);
  if (!entry) return false;
  if (entry.resetAt <= Date.now()) {
    failedLogins.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILED_LOGINS;
}

function recordFailure(key) {
  const now = Date.now();
  const entry = failedLogins.get(key);
  if (!entry || entry.resetAt <= now) {
    failedLogins.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

module.exports = router;
