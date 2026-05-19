const crypto = require("crypto");
const { createHttpError } = require("../utils/http");

function getPaymentCallbackSecret() {
  return process.env.PAYMENT_CALLBACK_SECRET || "";
}

function isPaymentCallbackSignatureEnabled() {
  return process.env.PAYMENT_CALLBACK_ENABLED === "true" && Boolean(getPaymentCallbackSecret());
}

function buildSignatureFromRawBody(rawBody, secret) {
  return crypto.createHmac("sha256", secret).update(rawBody || "").digest("hex");
}

function parseIncomingSignature(headerValue) {
  if (!headerValue) {
    return "";
  }

  const normalized = String(headerValue).trim();
  if (!normalized) {
    return "";
  }

  if (normalized.startsWith("sha256=")) {
    return normalized.slice("sha256=".length);
  }

  return normalized;
}

function timingSafeEqualHex(a, b) {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function verifyPaymentCallbackSignature(req) {
  if (!isPaymentCallbackSignatureEnabled()) {
    return {
      verified: false,
      skipped: true,
      reason: "disabled",
    };
  }

  const incomingSignature = parseIncomingSignature(req.get("X-CoreID-Signature"));
  if (!incomingSignature) {
    throw createHttpError(401, "Missing payment callback signature");
  }

  const secret = getPaymentCallbackSecret();
  const expectedSignature = buildSignatureFromRawBody(req.rawBody || "", secret);

  if (!timingSafeEqualHex(incomingSignature, expectedSignature)) {
    throw createHttpError(401, "Invalid payment callback signature");
  }

  return {
    verified: true,
    skipped: false,
    reason: null,
  };
}

module.exports = {
  buildSignatureFromRawBody,
  getPaymentCallbackSecret,
  isPaymentCallbackSignatureEnabled,
  verifyPaymentCallbackSignature,
};
