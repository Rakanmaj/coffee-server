require("dotenv").config();
const express = require("express");
const cors = require("cors");

const auth_routes = require("./routes/auth");
const products_routes = require("./routes/products");
const inventory_routes = require("./routes/inventory");
const orders_routes = require("./routes/orders");
const reports_routes = require("./routes/reports");
const analyticsRoutes = require("./routes/analytics");

const app = express();

/* 🌍 PUBLIC API — allow everyone */
app.use(cors());
app.options("*", cors());

app.use(express.json());

app.get("/", (req, res) => {
  res.json({ message: "Coffee POS API running 🚀" });
});

app.use("/api/auth", auth_routes);
app.use("/api/products", products_routes);
app.use("/api/inventory", inventory_routes);
app.use("/api/orders", orders_routes);
app.use("/api/reports", reports_routes);
app.use("/api/analytics", analyticsRoutes);
const PORT = process.env.PORT || 5000;
app.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`)
);
