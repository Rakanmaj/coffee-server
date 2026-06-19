const pool = require("../db/db");
const { verifyAuthToken } = require("./authToken");

async function requireAuth(req, res, next) {
  const authorization = req.get("authorization") || "";
  const [scheme, token] = authorization.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ message: "Authentication required" });
  }

  try {
    const payload = verifyAuthToken(token);
    if (!payload) {
      return res.status(401).json({ message: "Invalid or expired session" });
    }

    const result = await pool.query(
      "SELECT user_id, full_name, email FROM users WHERE user_id=$1",
      [payload.sub]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ message: "Invalid or expired session" });
    }

    req.userId = Number(payload.sub);
    req.user = result.rows[0];
    next();
  } catch (err) {
    console.error("Authentication error:", err);
    res.status(500).json({ message: "Authentication failed" });
  }
}

module.exports = requireAuth;
