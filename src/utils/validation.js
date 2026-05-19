const { URL } = require("url");
const { createHttpError } = require("./http");

const APP_ID_PATTERN = /^[a-z0-9][a-z0-9-_]{1,49}$/i;
const PLAN_CODE_PATTERN = /^[a-z0-9][a-z0-9-_]{1,49}$/i;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,99}$/i;
const VERSION_PATTERN = /^[a-zA-Z0-9._-]{1,50}$/;
const DEVICE_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,200}$/;
const ORDER_NO_PATTERN = /^[a-zA-Z0-9._-]{1,100}$/;
const REDEEM_CODE_PATTERN = /^[A-Z0-9-]{8,80}$/;
const PHONE_PATTERN = /^[0-9]{6,20}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function ensureRequiredString(value, fieldName, { maxLength = 200 } = {}) {
  const normalized = normalizeString(value);
  if (!normalized) {
    throw createHttpError(400, `${fieldName} is required`);
  }
  if (normalized.length > maxLength) {
    throw createHttpError(400, `${fieldName} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function ensureOptionalString(value, { maxLength = 200, defaultValue = null } = {}) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return defaultValue;
  }
  if (normalized.length > maxLength) {
    throw createHttpError(400, `Value must be at most ${maxLength} characters`);
  }
  return normalized;
}

function ensurePattern(value, fieldName, pattern, maxLength) {
  const normalized = ensureRequiredString(value, fieldName, { maxLength });
  if (!pattern.test(normalized)) {
    throw createHttpError(400, `${fieldName} format is invalid`);
  }
  return normalized;
}

function ensureAppId(value, fieldName = "app_id") {
  return ensurePattern(value, fieldName, APP_ID_PATTERN, 50);
}

function ensurePlanCode(value, fieldName = "code") {
  return ensurePattern(value, fieldName, PLAN_CODE_PATTERN, 50).toLowerCase();
}

function ensureSlug(value, fieldName = "slug") {
  return ensurePattern(value, fieldName, SLUG_PATTERN, 100).toLowerCase();
}

function ensureVersion(value, fieldName = "version") {
  const normalized = ensureOptionalString(value, { maxLength: 50, defaultValue: null });
  if (!normalized) {
    return null;
  }
  if (!VERSION_PATTERN.test(normalized)) {
    throw createHttpError(400, `${fieldName} format is invalid`);
  }
  return normalized;
}

function ensureOrderNo(value, fieldName = "order_no") {
  return ensurePattern(value, fieldName, ORDER_NO_PATTERN, 100);
}

function ensureRedeemCode(value, fieldName = "code") {
  const normalized = ensureRequiredString(value, fieldName, { maxLength: 80 })
    .toUpperCase()
    .replace(/\s+/g, "");
  if (!REDEEM_CODE_PATTERN.test(normalized)) {
    throw createHttpError(400, `${fieldName} format is invalid`);
  }
  return normalized;
}

function ensureDeviceId(value, fieldName = "device_id") {
  return ensurePattern(value, fieldName, DEVICE_ID_PATTERN, 200);
}

function ensurePhone(value, fieldName = "phone") {
  return ensurePattern(value, fieldName, PHONE_PATTERN, 20);
}

function ensurePassword(value, fieldName = "password") {
  const normalized = ensureRequiredString(value, fieldName, { maxLength: 100 });
  if (normalized.length < 6) {
    throw createHttpError(400, `${fieldName} must be at least 6 characters`);
  }
  return normalized;
}

function ensureOptionalEmail(value, fieldName = "email") {
  const normalized = ensureOptionalString(value, { maxLength: 120, defaultValue: null });
  if (!normalized) {
    return null;
  }
  if (!EMAIL_PATTERN.test(normalized)) {
    throw createHttpError(400, `${fieldName} format is invalid`);
  }
  return normalized.toLowerCase();
}

function ensureEnum(value, fieldName, allowedValues) {
  const normalized = ensureRequiredString(value, fieldName, { maxLength: 50 });
  if (!allowedValues.includes(normalized)) {
    throw createHttpError(400, `${fieldName} must be one of: ${allowedValues.join(", ")}`);
  }
  return normalized;
}

function ensureOptionalUrl(value, fieldName = "url") {
  const normalized = ensureOptionalString(value, { maxLength: 500, defaultValue: null });
  if (!normalized) {
    return null;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(normalized);
  } catch (error) {
    throw createHttpError(400, `${fieldName} must be a valid URL`);
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw createHttpError(400, `${fieldName} must use http or https`);
  }

  return parsedUrl.toString();
}

function ensureMoneyAmount(value, fieldName = "amount") {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw createHttpError(400, `${fieldName} must be a valid non-negative number`);
  }

  return Math.round(number * 100) / 100;
}

function ensureDateInput(value, fieldName) {
  const normalized = ensureOptionalString(value, { maxLength: 40, defaultValue: null });
  if (!normalized) {
    return null;
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw createHttpError(400, `${fieldName} must be a valid date`);
  }

  return parsed.toISOString();
}

function ensureDateOnly(value, fieldName) {
  const normalized = ensureOptionalString(value, { maxLength: 20, defaultValue: null });
  if (!normalized) {
    return null;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw createHttpError(400, `${fieldName} must be in YYYY-MM-DD format`);
  }

  return normalized;
}

function ensurePositiveInteger(value, fieldName = "id") {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw createHttpError(400, `${fieldName} must be a positive integer`);
  }
  return number;
}

function parsePagination(query, { defaultLimit = 10, maxLimit = 100 } = {}) {
  const parsedPage = Number(query.page || 1);
  const parsedLimit = Number(query.limit || defaultLimit);
  const page = Number.isFinite(parsedPage) ? Math.max(1, Math.floor(parsedPage)) : 1;
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(maxLimit, Math.max(1, Math.floor(parsedLimit)))
    : defaultLimit;
  const offset = (page - 1) * limit;

  return { page, limit, offset };
}

function escapeCsvValue(value) {
  const stringValue = value == null ? "" : String(value);
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

module.exports = {
  ensureAppId,
  ensureDateInput,
  ensureDateOnly,
  ensureDeviceId,
  ensureEnum,
  ensureMoneyAmount,
  ensureOptionalEmail,
  ensureOptionalString,
  ensureOptionalUrl,
  ensureOrderNo,
  ensurePassword,
  ensurePlanCode,
  ensurePhone,
  ensureRedeemCode,
  ensurePositiveInteger,
  ensureRequiredString,
  ensureSlug,
  ensureVersion,
  escapeCsvValue,
  parsePagination,
};
