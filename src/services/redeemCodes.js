const crypto = require("crypto");

function randomChunk(length = 4) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  const bytes = crypto.randomBytes(length);
  for (let index = 0; index < length; index += 1) {
    result += alphabet[bytes[index] % alphabet.length];
  }
  return result;
}

function generateRedeemCode() {
  return [randomChunk(4), randomChunk(4), randomChunk(4), randomChunk(4)].join("-");
}

function hashRedeemCode(code) {
  return crypto.createHash("sha256").update(String(code || "").trim().toUpperCase()).digest("hex");
}

function buildCodePreview(code) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) {
    return "";
  }
  const compact = normalized.replace(/-/g, "");
  if (compact.length <= 8) {
    return normalized;
  }
  return `${compact.slice(0, 4)}••••${compact.slice(-4)}`;
}

function generateBatchNo() {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  return `RC-${timestamp}-${randomChunk(4)}`;
}

function buildRedeemOrderNo() {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  return `REDEEM-${timestamp}-${randomChunk(6)}`;
}

module.exports = {
  buildCodePreview,
  buildRedeemOrderNo,
  generateBatchNo,
  generateRedeemCode,
  hashRedeemCode,
};
