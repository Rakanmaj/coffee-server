const crypto = require("crypto");
const router = require("express").Router();
const pool = require("../db/db");
const { encodeDatabaseText } = require("../db/databaseText");
const requireAuth = require("../middleware/requireAuth");
const { verifyAuthToken } = require("../middleware/authToken");

const orders = new Map();
const COMPLETE_CLEANUP_MS = 15 * 60 * 1000;

function public_order(order) {
  return {
    id: order.id,
    status: order.status,
    car_type: order.car_type,
    payment_method: order.payment_method,
    total_amount_omr: order.total_amount_omr,
    created_at: order.created_at,
    accepted_at: order.accepted_at || null,
    ready_at: order.ready_at || null,
    delivered_at: order.delivered_at || null,
    not_delivered_at: order.not_delivered_at || null,
    order_id: order.order_id || null,
    items: order.items,
  };
}

function cashier_orders() {
  return Array.from(orders.values())
    .filter((order) => !["delivered", "not_delivered"].includes(order.status))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map(public_order);
}

function emit_cashiers(req) {
  const io = req.app.get("io");
  if (!io) return;
  io.to("cashiers").emit("orders-changed", { orders: cashier_orders() });
}

function emit_customer(req, order, event_name) {
  const io = req.app.get("io");
  if (!io) return;
  io.to(`drive-through:${order.id}`).emit(event_name, { order: public_order(order) });
}

function normalize_items(raw_items) {
  if (!Array.isArray(raw_items) || raw_items.length === 0) return null;

  const normalized = [];
  for (const item of raw_items) {
    const product_id = Number(item.product_id);
    const quantity = Number(item.quantity);

    if (!Number.isInteger(product_id) || product_id <= 0) return null;
    if (!Number.isFinite(quantity) || quantity <= 0) return null;

    normalized.push({
      product_id,
      quantity,
      note: String(item.note || "").trim().slice(0, 300),
    });
  }

  return normalized;
}

async function build_order_payload({ car_type, payment_method, items }) {
  const normalized_items = normalize_items(items);
  const car = String(car_type || "").trim();

  if (!car) {
    return { error: { status: 400, message: "Car type is required" } };
  }

  if (!["Cash", "Visa"].includes(payment_method)) {
    return { error: { status: 400, message: "Payment method must be Cash or Visa" } };
  }

  if (!normalized_items) {
    return { error: { status: 400, message: "Order items are required" } };
  }

  const ids = [...new Set(normalized_items.map((item) => item.product_id))];
  const products_res = await pool.query(
    "SELECT product_id, name, price_omr, category, is_active FROM products WHERE product_id = ANY($1)",
    [ids]
  );

  if (products_res.rows.length !== ids.length) {
    return { error: { status: 400, message: "One or more products were not found" } };
  }

  const by_id = {};
  for (const product of products_res.rows) {
    if (!product.is_active) {
      return { error: { status: 400, message: `Inactive product: ${product.name}` } };
    }
    by_id[product.product_id] = product;
  }

  let total = 0;
  const order_items = normalized_items.map((item) => {
    const product = by_id[item.product_id];
    total += Number(product.price_omr) * Number(item.quantity);

    return {
      product_id: product.product_id,
      name: product.name,
      category: product.category,
      price_omr: product.price_omr,
      quantity: item.quantity,
      note: item.note,
    };
  });

  total = Math.round(total * 1000) / 1000;

  return {
    order: {
      id: crypto.randomUUID(),
      status: "pending",
      car_type: car.slice(0, 160),
      payment_method,
      total_amount_omr: total,
      created_at: new Date().toISOString(),
      items: order_items,
    },
  };
}

async function save_order_to_pos(order, cashier_id) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const ids = order.items.map((item) => item.product_id);
    const products_res = await client.query(
      "SELECT product_id, name, price_omr, category, is_active FROM products WHERE product_id = ANY($1)",
      [ids]
    );

    if (products_res.rows.length !== ids.length) {
      await client.query("ROLLBACK");
      return { error: { status: 400, message: "One or more products were not found" } };
    }

    const by_id = {};
    for (const product of products_res.rows) {
      if (!product.is_active) {
        await client.query("ROLLBACK");
        return { error: { status: 400, message: `Inactive product: ${product.name}` } };
      }
      by_id[product.product_id] = product;
    }

    let total = 0;
    const snack_needs = [];

    for (const item of order.items) {
      const product = by_id[item.product_id];
      const quantity = Number(item.quantity);

      if (!quantity || quantity <= 0) {
        await client.query("ROLLBACK");
        return { error: { status: 400, message: "Invalid quantity" } };
      }

      total += Number(product.price_omr) * quantity;

      if (product.category === "snack") {
        snack_needs.push({
          product_id: product.product_id,
          name: product.name,
          need: quantity,
        });
      }
    }

    const insufficient = [];
    for (const snack of snack_needs) {
      const inv = await client.query(
        "SELECT quantity FROM inventory WHERE product_id=$1 FOR UPDATE",
        [snack.product_id]
      );

      const available = inv.rows.length ? Number(inv.rows[0].quantity) : 0;
      if (available < snack.need) {
        insufficient.push({
          product_id: snack.product_id,
          name: snack.name,
          need: snack.need,
          available,
        });
      }
    }

    if (insufficient.length > 0) {
      await client.query("ROLLBACK");
      return {
        error: {
          status: 400,
          message: "Insufficient snack inventory",
          insufficient_items: insufficient,
        },
      };
    }

    total = Math.round(total * 1000) / 1000;

    const order_res = await client.query(
      "INSERT INTO orders (cashier_id, payment_method, total_amount_omr) VALUES ($1,$2,$3) RETURNING *",
      [cashier_id, order.payment_method, total]
    );
    const saved_order = order_res.rows[0];

    for (const item of order.items) {
      const product = by_id[item.product_id];
      const car_type = String(order.car_type || "").trim() || "not provided";
      const item_note = String(item.note || "").trim();
      const note_parts = [`[Drive-through | Car: ${car_type}]`];
      if (item_note) note_parts.push(item_note);
      const database_note = encodeDatabaseText(note_parts.join(" "));

      await client.query(
        "INSERT INTO order_items (order_id, product_id, quantity, price_at_sale_omr, note) VALUES ($1,$2,$3,$4,$5)",
        [saved_order.order_id, product.product_id, item.quantity, product.price_omr, database_note]
      );
    }

    for (const snack of snack_needs) {
      await client.query(
        "UPDATE inventory SET quantity = quantity - $1, updated_at=NOW() WHERE product_id=$2",
        [snack.need, snack.product_id]
      );
    }

    await client.query("COMMIT");
    return { order: saved_order };
  } catch (err) {
    await client.query("ROLLBACK");
    return { error: { status: 500, message: err.message } };
  } finally {
    client.release();
  }
}

router.get("/menu", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM products WHERE is_active=true ORDER BY category, product_id"
    );
    res.json({ products: result.rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/orders", async (req, res) => {
  try {
    const built = await build_order_payload(req.body || {});
    if (built.error) {
      return res.status(built.error.status).json({ message: built.error.message });
    }

    orders.set(built.order.id, built.order);

    const io = req.app.get("io");
    if (io) {
      io.to("cashiers").emit("new-order", { order: public_order(built.order) });
    }
    emit_cashiers(req);

    res.status(201).json({ order: public_order(built.order) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/orders/:id", async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ message: "Order not found" });
  res.json({ order: public_order(order) });
});

router.get("/orders", requireAuth, async (req, res) => {
  res.json({ orders: cashier_orders() });
});

router.post("/orders/:id/accept", requireAuth, async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ message: "Order not found" });
  if (order.status !== "pending") {
    return res.status(400).json({ message: "Only pending orders can be accepted" });
  }

  order.status = "working";
  order.accepted_at = new Date().toISOString();
  order.cashier_id = req.userId;

  emit_customer(req, order, "order-accepted");
  emit_cashiers(req);

  res.json({ order: public_order(order) });
});

router.post("/orders/:id/ready", requireAuth, async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ message: "Order not found" });
  if (order.status !== "working") {
    return res.status(400).json({ message: "Only working orders can be marked ready" });
  }

  order.status = "ready";
  order.ready_at = new Date().toISOString();

  emit_customer(req, order, "order-ready");
  emit_cashiers(req);

  res.json({ order: public_order(order) });
});

router.post("/orders/:id/delivered", requireAuth, async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ message: "Order not found" });
  if (!["working", "ready"].includes(order.status)) {
    return res.status(400).json({ message: "Only active orders can be marked delivered" });
  }

  const saved = await save_order_to_pos(order, order.cashier_id || req.userId);
  if (saved.error) {
    return res.status(saved.error.status).json({
      message: saved.error.message,
      insufficient_items: saved.error.insufficient_items,
    });
  }

  order.status = "delivered";
  order.order_id = saved.order.order_id;
  order.delivered_at = new Date().toISOString();
  order.cashier_id = order.cashier_id || req.userId;

  emit_customer(req, order, "order-delivered");
  emit_cashiers(req);

  setTimeout(() => {
    orders.delete(order.id);
  }, COMPLETE_CLEANUP_MS);

  res.json({ order: public_order(order) });
});

router.post("/orders/:id/not-delivered", requireAuth, async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ message: "Order not found" });
  if (order.status === "not_delivered") {
    return res.json({ order: public_order(order) });
  }
  if (!["pending", "working", "ready"].includes(order.status)) {
    return res.status(400).json({ message: "Only active orders can be marked not delivered" });
  }

  order.status = "not_delivered";
  order.not_delivered_at = new Date().toISOString();
  order.cashier_id = order.cashier_id || req.userId;

  emit_customer(req, order, "order-not-delivered");
  emit_cashiers(req);

  setTimeout(() => {
    orders.delete(order.id);
  }, COMPLETE_CLEANUP_MS);

  res.json({ order: public_order(order) });
});

function setupDriveThroughSockets(io) {
  io.on("connection", (socket) => {
    socket.on("drive-through:join", ({ orderId } = {}) => {
      if (!orderId || !orders.has(orderId)) return;
      socket.join(`drive-through:${orderId}`);
      socket.emit("order-updated", { order: public_order(orders.get(orderId)) });
    });

    socket.on("cashier:join", async ({ token } = {}) => {
      const payload = verifyAuthToken(token);
      if (!payload) {
        socket.emit("socket-error", { message: "Authentication required" });
        return;
      }

      try {
        const result = await pool.query("SELECT user_id FROM users WHERE user_id=$1", [payload.sub]);
        if (result.rows.length === 0) {
          socket.emit("socket-error", { message: "Authentication required" });
          return;
        }

        socket.join("cashiers");
        socket.emit("orders-changed", { orders: cashier_orders() });
      } catch (err) {
        socket.emit("socket-error", { message: err.message });
      }
    });

    socket.on("cashier:leave", () => {
      socket.leave("cashiers");
    });
  });
}

module.exports = {
  router,
  setupDriveThroughSockets,
};
