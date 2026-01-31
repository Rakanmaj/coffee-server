const router = require("express").Router();
const pool = require("../db/db");
const requireAuth = require("../middleware/requireAuth");

// list snack inventory
router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.product_id,
        p.name,
        i.quantity,
        i.updated_at
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.product_id
      WHERE p.category='snack'
      ORDER BY p.product_id
    `);
    res.json({ items: result.rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// adjust inventory: delta can be + or -
router.post("/adjust", requireAuth, async (req, res) => {
  const { product_id, delta } = req.body;

  try {
    // ensure product is snack
    const prod = await pool.query("SELECT * FROM products WHERE product_id=$1", [product_id]);
    if (prod.rows.length === 0) return res.status(400).json({ message: "Product not found" });
    if (prod.rows[0].category !== "snack") {
      return res.status(400).json({ message: "Only snacks have inventory" });
    }

    // create inventory row if missing
    await pool.query(
      "INSERT INTO inventory (product_id, quantity) VALUES ($1,0) ON CONFLICT (product_id) DO NOTHING",
      [product_id]
    );

    // check not going below zero
    const inv = await pool.query("SELECT quantity FROM inventory WHERE product_id=$1", [product_id]);
    const current = Number(inv.rows[0].quantity);
    const next = current + Number(delta);

    if (next < 0) {
      return res.status(400).json({ message: `Insufficient stock. Current=${current}` });
    }

    const updated = await pool.query(
      "UPDATE inventory SET quantity=$1, updated_at=NOW() WHERE product_id=$2 RETURNING *",
      [next, product_id]
    );

    res.json({ inventory: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
