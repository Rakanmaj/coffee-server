require("dotenv").config();
const express = require("express");
const cors = require("cors");
const compression = require("compression");

const auth_routes = require("./routes/auth");
const products_routes = require("./routes/products");
const inventory_routes = require("./routes/inventory");
const orders_routes = require("./routes/orders");
const reports_routes = require("./routes/reports");
const analyticsRoutes = require("./routes/analytics");

const app = express();
const driveThroughEnabled = process.env.ENABLE_DRIVE_THROUGH === "true";
const productionClientUrl = "https://coffee-client-production.up.railway.app";

app.set("trust proxy", 1);
app.disable("x-powered-by");

/* 🌍 PUBLIC API — allow everyone */
const corsOptions = {
  origin(origin, callback) {
    const isLocal = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin || "");
    if (!origin || origin === productionClientUrl || isLocal) {
      return callback(null, true);
    }
    return callback(new Error("Origin not allowed"));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(compression());

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

app.use(express.json({ limit: "100kb" }));

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

if (driveThroughEnabled) {
  const http = require("http");
  const { Server } = require("socket.io");
  const {
    router: driveThroughRoutes,
    setupDriveThroughSockets,
  } = require("./routes/driveThrough");

  app.use("/api/drive-through", driveThroughRoutes);

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: [productionClientUrl, /^http:\/\/(localhost|127\.0\.0\.1):\d+$/],
      methods: ["GET", "POST", "PUT", "DELETE"],
    },
  });

  app.set("io", io);
  setupDriveThroughSockets(io);

  server.listen(PORT, () =>
    console.log(`Server running on port ${PORT}`)
  );
} else {
  app.listen(PORT, () =>
    console.log(`Server running on port ${PORT}`)
  );
}
