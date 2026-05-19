const { createHttpError } = require("../utils/http");

const codeStore = new Map();
const CODE_TTL_MS = 5 * 60 * 1000;

function getStoreKey(appId, phone) {
  return `${appId}:${phone}`;
}

function getDevVerificationCode() {
  return process.env.DEV_PHONE_VERIFICATION_CODE || "123456";
}

function issueVerificationCode({ appId, phone }) {
  const code = getDevVerificationCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  codeStore.set(getStoreKey(appId, phone), {
    code,
    expiresAt: expiresAt.getTime(),
  });

  return {
    code,
    expires_at: expiresAt.toISOString(),
  };
}

function verifyVerificationCode({ appId, phone, code }) {
  const record = codeStore.get(getStoreKey(appId, phone));

  if (!record) {
    throw createHttpError(400, "Verification code has not been requested yet");
  }

  if (record.expiresAt < Date.now()) {
    codeStore.delete(getStoreKey(appId, phone));
    throw createHttpError(400, "Verification code has expired");
  }

  if (record.code !== code) {
    throw createHttpError(400, "Verification code is invalid");
  }

  codeStore.delete(getStoreKey(appId, phone));
}

module.exports = {
  getDevVerificationCode,
  issueVerificationCode,
  verifyVerificationCode,
};
