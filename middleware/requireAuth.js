const pool = require("../db/db");

async function requireAuth(req, res, next) {
  const user_id = req.headers["x-user-id"];

  if (!user_id) {
    return res.status(401).json({ message: "Missing x-user-id header" });
  }

  try {
    const result = await pool.query(
      "SELECT user_id FROM users WHERE user_id = $1",
      [user_id]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ message: "Invalid user" });
    }

    req.userId = Number(user_id);
    next();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

module.exports = requireAuth;
