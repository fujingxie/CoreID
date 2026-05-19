const crypto = require("crypto");
const { query } = require("../config/db");
const { sendSmsCode, getSmsProvider } = require("./sms");
const { createHttpError, isProduction } = require("../utils/http");

const PURPOSES = ["register", "reset_password"];
const DEFAULT_TTL_SECONDS = 5 * 60;
const DEFAULT_COOLDOWN_SECONDS = 60;
const DEFAULT_MAX_SENDS_PER_HOUR = 10;
const DEFAULT_MAX_VERIFY_ATTEMPTS = 5;
const DEFAULT_CODE_LENGTH = 6;

function getVerificationMode() {
  const configured = (process.env.PHONE_VERIFICATION_MODE || "").trim().toLowerCase();

  if (configured === "sms") {
    return "sms";
  }

  if (configured === "dev") {
    return "dev";
  }

  if (String(process.env.SMS_ENABLED || "").toLowerCase() === "true") {
    return "sms";
  }

  return isProduction() ? "sms" : "dev";
}

function getDevVerificationCode() {
  return process.env.DEV_PHONE_VERIFICATION_CODE || "123456";
}

function getCodeLength() {
  const value = Number(process.env.SMS_CODE_LENGTH || DEFAULT_CODE_LENGTH);
  if (!Number.isInteger(value) || value < 4 || value > 8) {
    return DEFAULT_CODE_LENGTH;
  }
  return value;
}

function getTtlSeconds() {
  const value = Number(process.env.SMS_CODE_TTL_SECONDS || DEFAULT_TTL_SECONDS);
  if (!Number.isInteger(value) || value < 60 || value > 30 * 60) {
    return DEFAULT_TTL_SECONDS;
  }
  return value;
}

function getCooldownSeconds() {
  const value = Number(process.env.SMS_SEND_COOLDOWN_SECONDS || DEFAULT_COOLDOWN_SECONDS);
  if (!Number.isInteger(value) || value < 10 || value > 10 * 60) {
    return DEFAULT_COOLDOWN_SECONDS;
  }
  return value;
}

function getMaxSendsPerHour() {
  const value = Number(process.env.SMS_MAX_SENDS_PER_HOUR || DEFAULT_MAX_SENDS_PER_HOUR);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    return DEFAULT_MAX_SENDS_PER_HOUR;
  }
  return value;
}

function getMaxVerifyAttempts() {
  const value = Number(process.env.SMS_MAX_VERIFY_ATTEMPTS || DEFAULT_MAX_VERIFY_ATTEMPTS);
  if (!Number.isInteger(value) || value < 1 || value > 20) {
    return DEFAULT_MAX_VERIFY_ATTEMPTS;
  }
  return value;
}

function ensurePurpose(purpose) {
  if (!PURPOSES.includes(purpose)) {
    throw createHttpError(400, `Unsupported verification purpose: ${purpose}`);
  }
  return purpose;
}

function randomNumericCode(length) {
  const max = 10 ** length;
  const value = crypto.randomInt(0, max);
  return String(value).padStart(length, "0");
}

function buildVerificationCode(mode) {
  if (mode === "dev") {
    return getDevVerificationCode();
  }
  return randomNumericCode(getCodeLength());
}

async function assertSendAllowed({ appId, phone, purpose }) {
  const cooldownSeconds = getCooldownSeconds();
  const maxSendsPerHour = getMaxSendsPerHour();
  const latestResult = await query(
    `
      SELECT created_at
      FROM verification_codes
      WHERE app_id = $1
        AND phone = $2
        AND purpose = $3
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [appId, phone, purpose]
  );

  const latest = latestResult.rows[0];
  if (latest) {
    const createdAtMs = new Date(latest.created_at).getTime();
    const diffSeconds = Math.floor((Date.now() - createdAtMs) / 1000);
    if (diffSeconds < cooldownSeconds) {
      throw createHttpError(
        429,
        `Verification code requests are too frequent. Please wait ${cooldownSeconds - diffSeconds} seconds`
      );
    }
  }

  const hourlyResult = await query(
    `
      SELECT COUNT(*)::INT AS count
      FROM verification_codes
      WHERE app_id = $1
        AND phone = $2
        AND purpose = $3
        AND created_at >= NOW() - INTERVAL '1 hour'
        AND send_status IN ('sent', 'pending')
    `,
    [appId, phone, purpose]
  );

  const count = hourlyResult.rows[0]?.count || 0;
  if (count >= maxSendsPerHour) {
    throw createHttpError(429, "Verification code requests have reached the hourly limit");
  }
}

async function markPreviousCodesReplaced({ appId, phone, purpose }) {
  await query(
    `
      UPDATE verification_codes
      SET consumed_at = NOW(),
          consumed_reason = 'replaced'
      WHERE app_id = $1
        AND phone = $2
        AND purpose = $3
        AND consumed_at IS NULL
    `,
    [appId, phone, purpose]
  );
}

async function createVerificationRecord({ appId, phone, purpose, code, mode, provider }) {
  const ttlSeconds = getTtlSeconds();
  const result = await query(
    `
      INSERT INTO verification_codes (
        app_id,
        phone,
        purpose,
        code,
        mode,
        provider,
        expires_at,
        send_status
      )
      VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 * INTERVAL '1 second'), 'pending')
      RETURNING *
    `,
    [appId, phone, purpose, code, mode, provider, ttlSeconds]
  );

  return result.rows[0];
}

async function finalizeVerificationRecord({ id, sendStatus, providerRequestId = null, providerSerialNo = null, errorMessage = null }) {
  const result = await query(
    `
      UPDATE verification_codes
      SET send_status = $2,
          provider_request_id = $3,
          provider_serial_no = $4,
          error_message = $5
      WHERE id = $1
      RETURNING *
    `,
    [id, sendStatus, providerRequestId, providerSerialNo, errorMessage]
  );

  return result.rows[0];
}

async function issueVerificationCode({ appId, phone, purpose }) {
  const normalizedPurpose = ensurePurpose(purpose);
  const mode = getVerificationMode();
  const provider = mode === "sms" ? getSmsProvider() : "dev";

  await assertSendAllowed({ appId, phone, purpose: normalizedPurpose });
  await markPreviousCodesReplaced({ appId, phone, purpose: normalizedPurpose });

  const code = buildVerificationCode(mode);
  const record = await createVerificationRecord({
    appId,
    phone,
    purpose: normalizedPurpose,
    code,
    mode,
    provider,
  });

  try {
    if (mode === "sms") {
      const smsResult = await sendSmsCode({
        phone,
        code,
        purpose: normalizedPurpose,
        ttlMinutes: Math.ceil(getTtlSeconds() / 60),
      });

      await finalizeVerificationRecord({
        id: record.id,
        sendStatus: "sent",
        providerRequestId: smsResult.provider_request_id,
        providerSerialNo: smsResult.provider_serial_no,
      });
    } else {
      await finalizeVerificationRecord({
        id: record.id,
        sendStatus: "sent",
      });
    }
  } catch (error) {
    await finalizeVerificationRecord({
      id: record.id,
      sendStatus: "failed",
      errorMessage: error.message,
    });
    throw error;
  }

  return {
    mode,
    provider,
    purpose: normalizedPurpose,
    code: mode === "dev" ? code : null,
    expires_at: record.expires_at,
    cooldown_seconds: getCooldownSeconds(),
  };
}

async function verifyVerificationCode({ appId, phone, purpose, code }) {
  const normalizedPurpose = ensurePurpose(purpose);
  const maxAttempts = getMaxVerifyAttempts();
  const result = await query(
    `
      SELECT *
      FROM verification_codes
      WHERE app_id = $1
        AND phone = $2
        AND purpose = $3
        AND send_status = 'sent'
        AND consumed_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [appId, phone, normalizedPurpose]
  );

  const record = result.rows[0];
  if (!record) {
    throw createHttpError(400, "Verification code has not been requested yet");
  }

  if (new Date(record.expires_at).getTime() < Date.now()) {
    await query(
      `
        UPDATE verification_codes
        SET consumed_at = NOW(),
            consumed_reason = 'expired'
        WHERE id = $1
      `,
      [record.id]
    );
    throw createHttpError(400, "Verification code has expired");
  }

  if (record.attempt_count >= maxAttempts) {
    throw createHttpError(400, "Verification code retry limit has been reached");
  }

  if (record.code !== code) {
    const nextAttempts = record.attempt_count + 1;
    await query(
      `
        UPDATE verification_codes
        SET attempt_count = $2::int,
            consumed_at = CASE WHEN $2::int >= $3::int THEN NOW() ELSE consumed_at END,
            consumed_reason = CASE WHEN $2::int >= $3::int THEN 'max_attempts' ELSE consumed_reason END
        WHERE id = $1
      `,
      [record.id, nextAttempts, maxAttempts]
    );
    throw createHttpError(400, "Verification code is invalid");
  }

  await query(
    `
      UPDATE verification_codes
      SET consumed_at = NOW(),
          consumed_reason = 'verified'
      WHERE id = $1
    `,
    [record.id]
  );

  return {
    id: record.id,
    app_id: record.app_id,
    phone: record.phone,
    purpose: record.purpose,
    mode: record.mode,
  };
}

module.exports = {
  getDevVerificationCode,
  getVerificationMode,
  issueVerificationCode,
  verifyVerificationCode,
};
