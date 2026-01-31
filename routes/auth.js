const router = require("express").Router();
const bcrypt = require("bcrypt");
const pool = require("../db/db");

// Seed cashier user (safe to call multiple times)
router.post("/seed", async (req, res) => {
  const full_name = "Default Cashier";
  const email = "cashier@coffee.com";
  const password = "123456";

  try {
    const existing = await pool.query("SELECT user_id FROM users WHERE email=$1", [email]);

    if (existing.rows.length > 0) {
      return res.json({
        message: "Cashier already exists",
        user: { user_id: existing.rows[0].user_id, full_name, email },
        login: { email, password }
      });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const created = await pool.query(
      "INSERT INTO users (full_name, email, password_hash) VALUES ($1,$2,$3) RETURNING user_id, full_name, email",
      [full_name, email, password_hash]
    );

    res.json({
      message: "Cashier seeded",
      user: created.rows[0],
      login: { email, password }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);

    if (!ok) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    res.json({
      user: {
        user_id: user.user_id,
        full_name: user.full_name,
        email: user.email,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
