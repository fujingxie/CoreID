const fs = require("fs");
const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
require("dotenv").config();

const adminAuth = require("./middleware/adminAuth");
const { createRateLimit } = require("./middleware/rateLimit");
const authRoutes = require("./routes/auth");
const identityRoutes = require("./routes/identity");
const purchaseRoutes = require("./routes/purchase");
const redeemRoutes = require("./routes/redeem");
const adminRoutes = require("./routes/admin");
const releaseRoutes = require("./routes/release");
const landingRoutes = require("./routes/landing");
const { ensureRuntimeSchema } = require("./services/bootstrap");
const { isProduction } = require("./utils/http");

const app = express();
const port = Number(process.env.PORT || 3000);

for (const directory of [
  path.join(process.cwd(), "src", "uploads", "releases"),
  path.join(process.cwd(), "src", "uploads", "landing"),
]) {
  fs.mkdirSync(directory, { recursive: true });
}

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (isProduction()) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

app.use(
  express.json({
    limit: "1mb",
    verify: (req, res, buf) => {
      req.rawBody = buf ? buf.toString("utf8") : "";
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(cookieParser());
app.use(
  "/api/auth/login",
  createRateLimit({
    windowMs: 10 * 60 * 1000,
    max: 20,
    keyPrefix: "auth-login",
    message: "Too many login attempts, please try again later",
  })
);
app.use(
  "/api/auth/callback",
  createRateLimit({
    windowMs: 10 * 60 * 1000,
    max: 30,
    keyPrefix: "auth-callback",
    message: "Too many authentication callbacks, please try again later",
  })
);
app.use(
  "/api/purchase/create",
  createRateLimit({
    windowMs: 60 * 1000,
    max: 30,
    keyPrefix: "purchase-create",
    message: "Purchase requests are too frequent, please slow down",
  })
);
app.use(
  "/api/redeem/preview",
  createRateLimit({
    windowMs: 60 * 1000,
    max: 40,
    keyPrefix: "redeem-preview",
    message: "Redeem preview requests are too frequent, please slow down",
  })
);
app.use(
  "/api/redeem/claim",
  createRateLimit({
    windowMs: 10 * 60 * 1000,
    max: 30,
    keyPrefix: "redeem-claim",
    message: "Redeem attempts are too frequent, please try again later",
  })
);
app.use(
  "/api/identity/send-code",
  createRateLimit({
    windowMs: 60 * 1000,
    max: 10,
    keyPrefix: "identity-send-code",
    message: "Verification code requests are too frequent, please slow down",
  })
);
app.use(
  "/api/identity/register",
  createRateLimit({
    windowMs: 10 * 60 * 1000,
    max: 20,
    keyPrefix: "identity-register",
    message: "Registration attempts are too frequent, please try again later",
  })
);
app.use(
  "/api/identity/login/password",
  createRateLimit({
    windowMs: 10 * 60 * 1000,
    max: 30,
    keyPrefix: "identity-login-password",
    message: "Password login attempts are too frequent, please try again later",
  })
);
app.use(
  "/api/identity/reset-password",
  createRateLimit({
    windowMs: 10 * 60 * 1000,
    max: 20,
    keyPrefix: "identity-reset-password",
    message: "Password reset attempts are too frequent, please try again later",
  })
);

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "coreid-user-center",
    now: new Date().toISOString(),
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/identity", identityRoutes);
app.use("/api/purchase", purchaseRoutes);
app.use("/api/redeem", redeemRoutes);
app.use("/api/admin", adminAuth, adminRoutes);
app.use("/api/admin/release", adminAuth, releaseRoutes.adminRouter);
app.use("/api/admin/landing", adminAuth, landingRoutes.adminRouter);
app.use(releaseRoutes.publicRouter);
app.use(landingRoutes.publicRouter);

app.use("/admin", express.static(path.join(process.cwd(), "public", "admin")));
app.use("/auth", express.static(path.join(process.cwd(), "public", "auth")));

app.get("/", (req, res) => {
  res.redirect("/admin");
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "admin", "index.html"));
});

app.get("/auth/register-test", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "auth", "register-test.html"));
});

app.get("/auth/login-test", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "auth", "login-test.html"));
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) {
    return next(error);
  }
  let status = error.statusCode || 500;
  let message = error.message || "Internal server error";

  if (error.type === "entity.too.large" || error.code === "LIMIT_FILE_SIZE") {
    status = 400;
    message = "Uploaded payload is too large";
  } else if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    status = 400;
    message = "Request body must be valid JSON";
  }

  res.status(status).json({
    error: status >= 500 && isProduction() ? "Internal server error" : message,
  });
});

async function start() {
  await ensureRuntimeSchema();
  app.listen(port, () => {
    console.log(`CoreID user center is running at http://localhost:${port}`);
  });
}

start().catch((error) => {
  console.error("Failed to start CoreID user center:", error);
  process.exit(1);
});
