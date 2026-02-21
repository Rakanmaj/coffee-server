// routes/analytics.js
const router = require("express").Router();
const pool = require("../db/db.js"); // adjust if your path is different
const requireAuth = require("../middleware/requireAuth.js");

// Helpers: build UTC shift range (02:00 UTC like your reports.js concept)
function startTsFromYMD(ymdStr) {
  // ymdStr = "YYYY-MM-DD"
  return `${ymdStr}T02:00:00.000Z`;
}

function startTsFromMonth(monthStr) {
  // monthStr = "YYYY-MM"
  return `${monthStr}-01T02:00:00.000Z`;
}

function addDaysISO(isoStr, days) {
  const d = new Date(isoStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function addMonthsISO(isoStr, months) {
  const d = new Date(isoStr);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
}

router.get("/", requireAuth, async (req, res) => {
  const { start, end, month } = req.query;

  // Build range
  let startTs, endTs, mode;

  if (month) {
    mode = "month";
    startTs = startTsFromMonth(month);
    endTs = addMonthsISO(startTs, 1);
  } else if (start && end) {
    mode = "range";
    startTs = startTsFromYMD(start);
    // end is inclusive => endTs = (end at 02:00 UTC) + 1 day
    const endStart = startTsFromYMD(end);
    endTs = addDaysISO(endStart, 1);
  } else {
    return res.status(400).json({
      message: "Provide either ?month=YYYY-MM OR ?start=YYYY-MM-DD&end=YYYY-MM-DD",
    });
  }

  try {
    // Common base for order filtering
    const RANGE_WHERE = `o.created_at >= $1::timestamptz AND o.created_at < $2::timestamptz`;

    // 1) Summary totals + AOV
    const summaryQ = pool.query(
      `
      SELECT
        COUNT(*)::int AS orders_count,
        COALESCE(SUM(o.total_amount_omr), 0)::numeric(12,3) AS total_revenue_omr,
        CASE WHEN COUNT(*)=0 THEN 0
             ELSE (SUM(o.total_amount_omr) / COUNT(*)) END::numeric(12,3) AS aov_omr
      FROM orders o
      WHERE ${RANGE_WHERE}
      `,
      [startTs, endTs]
    );

    // 2) Payments split
    const paymentsQ = pool.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN o.payment_method='Cash' THEN o.total_amount_omr ELSE 0 END), 0)::numeric(12,3) AS cash_omr,
        COALESCE(SUM(CASE WHEN o.payment_method='Visa' THEN o.total_amount_omr ELSE 0 END), 0)::numeric(12,3) AS visa_omr
      FROM orders o
      WHERE ${RANGE_WHERE}
      `,
      [startTs, endTs]
    );

    // Product aggregation base
    const PRODUCT_BASE = `
      FROM order_items oi
      JOIN orders o ON o.order_id = oi.order_id
      JOIN products p ON p.product_id = oi.product_id
      WHERE ${RANGE_WHERE}
    `;

    // 3) Top product by units
    const topByUnitsQ = pool.query(
      `
      SELECT
        p.product_id, p.name, p.category,
        SUM(oi.quantity)::int AS units,
        SUM(oi.quantity * oi.price_at_sale_omr)::numeric(12,3) AS revenue_omr
      ${PRODUCT_BASE}
      GROUP BY p.product_id, p.name, p.category
      ORDER BY units DESC, revenue_omr DESC
      LIMIT 1
      `,
      [startTs, endTs]
    );

    // 4) Top product by revenue
    const topByRevenueQ = pool.query(
      `
      SELECT
        p.product_id, p.name, p.category,
        SUM(oi.quantity)::int AS units,
        SUM(oi.quantity * oi.price_at_sale_omr)::numeric(12,3) AS revenue_omr
      ${PRODUCT_BASE}
      GROUP BY p.product_id, p.name, p.category
      ORDER BY revenue_omr DESC, units DESC
      LIMIT 1
      `,
      [startTs, endTs]
    );

    // 5) Top 5 products table
    const top5Q = pool.query(
      `
      SELECT
        p.product_id, p.name, p.category,
        SUM(oi.quantity)::int AS units,
        SUM(oi.quantity * oi.price_at_sale_omr)::numeric(12,3) AS revenue_omr
      ${PRODUCT_BASE}
      GROUP BY p.product_id, p.name, p.category
      ORDER BY revenue_omr DESC
      LIMIT 5
      `,
      [startTs, endTs]
    );

    // 6) Slow movers (include 0 sales using LEFT JOIN)
    const slowMoversQ = pool.query(
      `
      SELECT
        p.product_id, p.name, p.category,
        COALESCE(SUM(oi.quantity), 0)::int AS units,
        COALESCE(SUM(oi.quantity * oi.price_at_sale_omr), 0)::numeric(12,3) AS revenue_omr
      FROM products p
      LEFT JOIN order_items oi ON oi.product_id = p.product_id
      LEFT JOIN orders o ON o.order_id = oi.order_id
        AND ${RANGE_WHERE}
      GROUP BY p.product_id, p.name, p.category
      ORDER BY units ASC, revenue_omr ASC, p.name ASC
      LIMIT 10
      `,
      [startTs, endTs]
    );

    // 7) Category performance
    const categoryQ = pool.query(
      `
      SELECT
        p.category,
        COALESCE(SUM(oi.quantity),0)::int AS units,
        COALESCE(SUM(oi.quantity * oi.price_at_sale_omr),0)::numeric(12,3) AS revenue_omr
      ${PRODUCT_BASE}
      GROUP BY p.category
      ORDER BY revenue_omr DESC
      `,
      [startTs, endTs]
    );

    // 8) Avg items per order
    const itemsPerOrderQ = pool.query(
      `
      SELECT
        CASE WHEN COUNT(DISTINCT o.order_id)=0 THEN 0
             ELSE (SUM(COALESCE(oi.quantity,0))::numeric / COUNT(DISTINCT o.order_id)) END
        AS avg_items_per_order
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.order_id
      WHERE ${RANGE_WHERE}
      `,
      [startTs, endTs]
    );

    // 9) Busiest hours table (orders per hour)
    const hoursQ = pool.query(
      `
      SELECT
        to_char(date_trunc('hour', o.created_at), 'HH24:00') AS hour,
        COUNT(*)::int AS orders
      FROM orders o
      WHERE ${RANGE_WHERE}
      GROUP BY 1
      ORDER BY orders DESC, hour ASC
      LIMIT 24
      `,
      [startTs, endTs]
    );

    // 10) Sales by day-of-week
    const dowQ = pool.query(
      `
      SELECT
        to_char(o.created_at, 'Dy') AS day,
        EXTRACT(DOW FROM o.created_at)::int AS dow_index,
        COUNT(*)::int AS orders,
        COALESCE(SUM(o.total_amount_omr),0)::numeric(12,3) AS revenue_omr
      FROM orders o
      WHERE ${RANGE_WHERE}
      GROUP BY day, dow_index
      ORDER BY dow_index
      `,
      [startTs, endTs]
    );

    // 11) Daily revenue list
    const dailyQ = pool.query(
      `
      SELECT
        (o.created_at::date) AS day,
        COUNT(*)::int AS orders,
        SUM(o.total_amount_omr)::numeric(12,3) AS revenue_omr
      FROM orders o
      WHERE ${RANGE_WHERE}
      GROUP BY 1
      ORDER BY day ASC
      `,
      [startTs, endTs]
    );

    // 12) “Top product per day” average
    const topPerDayAvgQ = pool.query(
      `
      WITH per_day AS (
        SELECT
          o.created_at::date AS day,
          p.product_id,
          SUM(oi.quantity)::int AS units
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.order_id
        JOIN products p ON p.product_id = oi.product_id
        WHERE ${RANGE_WHERE}
        GROUP BY 1,2
      ),
      daily_top AS (
        SELECT day, MAX(units)::int AS top_units
        FROM per_day
        GROUP BY day
      )
      SELECT
        CASE WHEN COUNT(*)=0 THEN 0
             ELSE AVG(top_units)::numeric(12,2) END AS avg_top_units
      FROM daily_top
      `,
      [startTs, endTs]
    );

    // 13) All-time best seller (within selected range)
    const allTimeTopQ = pool.query(
      `
      SELECT
        p.product_id, p.name, p.category,
        SUM(oi.quantity)::int AS units,
        SUM(oi.quantity * oi.price_at_sale_omr)::numeric(12,3) AS revenue_omr
      ${PRODUCT_BASE}
      GROUP BY p.product_id, p.name, p.category
      ORDER BY units DESC, revenue_omr DESC
      LIMIT 1
      `,
      [startTs, endTs]
    );

    // Run in parallel
    const [
      summaryR,
      paymentsR,
      topByUnitsR,
      topByRevenueR,
      top5R,
      slowMoversR,
      categoryR,
      itemsPerOrderR,
      hoursR,
      dowR,
      dailyR,
      topPerDayAvgR,
      allTimeTopR,
    ] = await Promise.all([
      summaryQ,
      paymentsQ,
      topByUnitsQ,
      topByRevenueQ,
      top5Q,
      slowMoversQ,
      categoryQ,
      itemsPerOrderQ,
      hoursQ,
      dowQ,
      dailyQ,
      topPerDayAvgQ,
      allTimeTopQ,
    ]);

    // Daily stats: avg + best/worst
    const days = dailyR.rows || [];
    let dailyAvg = 0;
    let bestDay = null;
    let worstDay = null;

    if (days.length) {
      const total = days.reduce((a, r) => a + Number(r.revenue_omr), 0);
      dailyAvg = total / days.length;

      bestDay = days.reduce(
        (best, r) => (!best || Number(r.revenue_omr) > Number(best.revenue_omr) ? r : best),
        null
      );

      worstDay = days.reduce(
        (worst, r) => (!worst || Number(r.revenue_omr) < Number(worst.revenue_omr) ? r : worst),
        null
      );
    }

    // Peak hour and peak day (by revenue)
    const peakHour = hoursR.rows[0]?.hour || null;

    const peakDayRow = (dowR.rows || []).reduce(
      (best, r) => (!best || Number(r.revenue_omr) > Number(best.revenue_omr) ? r : best),
      null
    );
    const peakDay = peakDayRow?.day || null;

    // Best category
    const categories = categoryR.rows || [];
    const bestCatRevenueRow = categories.reduce(
      (best, r) => (!best || Number(r.revenue_omr) > Number(best.revenue_omr) ? r : best),
      null
    );
    const bestCatUnitsRow = categories.reduce(
      (best, r) => (!best || Number(r.units) > Number(best.units) ? r : best),
      null
    );

    // Payment percents
    const cash = Number(paymentsR.rows[0]?.cash_omr || 0);
    const visa = Number(paymentsR.rows[0]?.visa_omr || 0);
    const totalRev = Number(summaryR.rows[0]?.total_revenue_omr || 0);
    const cashPct = totalRev ? (cash / totalRev) * 100 : 0;
    const visaPct = totalRev ? (visa / totalRev) * 100 : 0;

    // Month compare (only if month mode)
    let month_compare = null;
    if (mode === "month") {
      const prevStart = addMonthsISO(startTs, -1);
      const prevEnd = startTs; // current month start = prev month end

      const prevSummary = await pool.query(
        `
        SELECT COALESCE(SUM(o.total_amount_omr),0)::numeric(12,3) AS prev_revenue_omr
        FROM orders o
        WHERE o.created_at >= $1::timestamptz AND o.created_at < $2::timestamptz
        `,
        [prevStart, prevEnd]
      );

      month_compare = {
        prev_start: prevStart,
        prev_end: prevEnd,
        prev_revenue_omr: prevSummary.rows[0].prev_revenue_omr,
      };
    }

    // Final response
    res.json({
      range: { mode, startTs, endTs },

      summary: summaryR.rows[0],

      daily: {
        list: days,
        avg_revenue_omr: Number(dailyAvg.toFixed(3)),
        best_day: bestDay,
        worst_day: worstDay,
      },

      payments: {
        cash_omr: paymentsR.rows[0].cash_omr,
        visa_omr: paymentsR.rows[0].visa_omr,
        cash_pct: Number(cashPct.toFixed(2)),
        visa_pct: Number(visaPct.toFixed(2)),
      },

      top_products: {
        top_by_units: topByUnitsR.rows[0] || null,
        top_by_revenue: topByRevenueR.rows[0] || null,
        top5: top5R.rows || [],
        slow_movers: slowMoversR.rows || [],
        all_time_best_seller: allTimeTopR.rows[0] || null,
        top_product_daily_avg_units: Number(topPerDayAvgR.rows[0]?.avg_top_units || 0),
      },

      category_performance: {
        rows: categories,
        best_by_revenue: bestCatRevenueRow?.category || null,
        best_by_units: bestCatUnitsRow?.category || null,
      },

      peak: {
        busiest_hours: hoursR.rows || [],
        peak_hour: peakHour,
        peak_day: peakDay,
        sales_by_day: dowR.rows || [],
      },

      avg_items_per_order: Number(itemsPerOrderR.rows[0]?.avg_items_per_order || 0),

      month_compare,
    });
  } catch (err) {
    console.error("Analytics error:", err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;