const router = require("express").Router();
const pool = require("../db/db");
const requireAuth = require("../middleware/requireAuth");

router.get("/daily", requireAuth, async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ message: "date is required YYYY-MM-DD" });

  try {
    const start = `${date} 02:00:00+00`;
    const endRes = await pool.query(
      "SELECT ($1::timestamptz + interval '1 day') AS end_time",
      [start]
    );
    const end = endRes.rows[0].end_time;

    // Summary
    const summaryRes = await pool.query(
      `
      SELECT
        COALESCE(SUM(total_amount_omr), 0) AS total_revenue_omr,
        COALESCE(SUM(CASE WHEN payment_method='Cash' THEN total_amount_omr ELSE 0 END), 0) AS total_cash_omr,
        COALESCE(SUM(CASE WHEN payment_method='Visa' THEN total_amount_omr ELSE 0 END), 0) AS total_visa_omr
      FROM orders
      WHERE created_at >= $1::timestamptz
        AND created_at < $2::timestamptz
      `,
      [start, end]
    );

    // Orders + Items (one query)
    const ordersRes = await pool.query(
      `
      SELECT
        o.order_id,
        o.cashier_id,
        u.full_name AS cashier_name,
        o.payment_method,
        o.total_amount_omr,
        o.created_at,
        COALESCE(
          json_agg(
            json_build_object(
              'product_id', oi.product_id,
              'name', p.name,
              'category', p.category,
              'quantity', oi.quantity,
              'price_at_sale_omr', oi.price_at_sale_omr,
              'note', oi.note
            )
            ORDER BY oi.order_item_id
          ) FILTER (WHERE oi.order_item_id IS NOT NULL),
          '[]'::json
        ) AS items
      FROM orders o
      JOIN users u ON u.user_id = o.cashier_id
      LEFT JOIN order_items oi ON oi.order_id = o.order_id
      LEFT JOIN products p ON p.product_id = oi.product_id
      WHERE o.created_at >= $1::timestamptz
        AND o.created_at < $2::timestamptz
      GROUP BY o.order_id, u.full_name
      ORDER BY o.created_at DESC
      `,
      [start, end]
    );

    res.json({
      summary: summaryRes.rows[0],
      orders: ordersRes.rows,
      shift: { start, end },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
