const router = require("express").Router();
const pool = require("../db/db");
const requireAuth = require("../middleware/requireAuth");

// create order
router.post("/", requireAuth, async (req, res) => {
  const { payment_method, items } = req.body;
  const cashier_id = req.userId;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: "Order items required" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Load products for items
    const ids = items.map((x) => x.product_id);
    const prodRes = await client.query(
      "SELECT product_id, name, price_omr, category, is_active FROM products WHERE product_id = ANY($1)",
      [ids]
    );

    if (prodRes.rows.length !== ids.length) {
      return res.status(400).json({ message: "One or more products not found" });
    }

    // Ensure active
    for (const p of prodRes.rows) {
      if (!p.is_active) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: `Inactive product: ${p.name}` });
      }
    }

    // Build map
    const byId = {};
    for (const p of prodRes.rows) byId[p.product_id] = p;

    // Calculate total + check snack inventory
    let total = 0;
    const snackNeeds = [];

    for (const it of items) {
      const p = byId[it.product_id];
      const qty = Number(it.quantity);

      if (!qty || qty <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Invalid quantity" });
      }

      total += Number(p.price_omr) * qty;

      if (p.category === "snack") {
        snackNeeds.push({ product_id: p.product_id, name: p.name, need: qty });
      }
    }

    total = Math.round(total * 1000) / 1000;

    // Check snack inventory availability
    const insufficient = [];
    for (const s of snackNeeds) {
      const inv = await client.query("SELECT quantity FROM inventory WHERE product_id=$1 FOR UPDATE", [
        s.product_id,
      ]);

      const available = inv.rows.length ? Number(inv.rows[0].quantity) : 0;
      if (available < s.need) {
        insufficient.push({ product_id: s.product_id, name: s.name, need: s.need, available });
      }
    }

    if (insufficient.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        message: "Insufficient snack inventory",
        insufficient_items: insufficient,
      });
    }

    // Create order
    const orderRes = await client.query(
      "INSERT INTO orders (cashier_id, payment_method, total_amount_omr) VALUES ($1,$2,$3) RETURNING *",
      [cashier_id, payment_method, total]
    );
    const order = orderRes.rows[0];

    // Insert order items
    for (const it of items) {
      const p = byId[it.product_id];
      const qty = Number(it.quantity);
      const note = it.note || "";

      await client.query(
        "INSERT INTO order_items (order_id, product_id, quantity, price_at_sale_omr, note) VALUES ($1,$2,$3,$4,$5)",
        [order.order_id, p.product_id, qty, p.price_omr, note]
      );
    }

    // Reduce inventory for snacks
    for (const s of snackNeeds) {
      await client.query(
        "UPDATE inventory SET quantity = quantity - $1, updated_at=NOW() WHERE product_id=$2",
        [s.need, s.product_id]
      );
    }

    await client.query("COMMIT");
    res.json({ order });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ message: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
