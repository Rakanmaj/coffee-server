const router = require("express").Router();
const pool = require("../db/db");
const requireAuth = require("../middleware/requireAuth");

// list all products
router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM products ORDER BY category, product_id");
    res.json({ products: result.rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// list active only
router.get("/active", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM products WHERE is_active=true ORDER BY category, product_id"
    );
    res.json({ products: result.rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// create product
router.post("/", requireAuth, async (req, res) => {
  const { name, price_omr, category } = req.body;

  try {
    const created = await pool.query(
      "INSERT INTO products (name, price_omr, category, is_active) VALUES ($1,$2,$3,true) RETURNING *",
      [name, price_omr, category]
    );
    res.json({ product: created.rows[0] });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// update product
router.put("/:id", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { name, price_omr, category, is_active } = req.body;

  try {
    const updated = await pool.query(
      "UPDATE products SET name=$1, price_omr=$2, category=$3, is_active=$4 WHERE product_id=$5 RETURNING *",
      [name, price_omr, category, is_active, id]
    );
    res.json({ product: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// delete product
router.delete("/:id", requireAuth, async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query("DELETE FROM products WHERE product_id=$1", [id]);
    res.json({ message: "Deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
