const crypto = require("crypto");
const { createHttpError } = require("../../utils/http");

const ALIYUN_SMS_HOST = "dysmsapi.aliyuncs.com";
const ALIYUN_SMS_VERSION = "2017-05-25";
const ALIYUN_SMS_ACTION = "SendSms";
const DEFAULT_COUNTRY_CODE = "+86";
const EMPTY_BODY_SHA256 = crypto.createHash("sha256").update("").digest("hex");

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw createHttpError(503, `${name} is not configured`);
  }
  return value;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmacSha256Hex(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest("hex");
}

function buildIsoTimestamp(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function buildNonce() {
  return crypto.randomBytes(16).toString("hex");
}

function percentEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function buildCanonicalQueryString(query) {
  return Object.keys(query)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(query[key])}`)
    .join("&");
}

function buildAuthorization({
  canonicalQueryString,
  accessKeyId,
  accessKeySecret,
  date,
  nonce,
  securityToken = "",
}) {
  const headers = {
    host: ALIYUN_SMS_HOST,
    "x-acs-action": ALIYUN_SMS_ACTION,
    "x-acs-content-sha256": EMPTY_BODY_SHA256,
    "x-acs-date": date,
    "x-acs-signature-nonce": nonce,
    "x-acs-version": ALIYUN_SMS_VERSION,
  };

  if (securityToken) {
    headers["x-acs-security-token"] = securityToken;
  }

  const signedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderKeys.map((key) => `${key}:${headers[key]}`).join("\n");
  const signedHeaders = signedHeaderKeys.join(";");
  const canonicalRequest = ["POST", "/", canonicalQueryString, canonicalHeaders, "", signedHeaders, EMPTY_BODY_SHA256].join("\n");
  const stringToSign = `ACS3-HMAC-SHA256\n${sha256Hex(canonicalRequest)}`;
  const signature = hmacSha256Hex(accessKeySecret, stringToSign);

  return {
    authorization: `ACS3-HMAC-SHA256 Credential=${accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`,
    headers,
  };
}

function buildPhoneNumber(phone) {
  const configured = (process.env.SMS_DEFAULT_COUNTRY_CODE || DEFAULT_COUNTRY_CODE).trim();
  const prefix = configured.startsWith("+") ? configured : `+${configured}`;
  if (phone.startsWith("+")) {
    return phone;
  }
  return `${prefix}${phone}`;
}

function buildTemplateCodeForPurpose(purpose) {
  if (purpose === "register") {
    return getRequiredEnv("SMS_ALIYUN_TEMPLATE_REGISTER");
  }
  if (purpose === "reset_password") {
    return getRequiredEnv("SMS_ALIYUN_TEMPLATE_RESET_PASSWORD");
  }
  throw createHttpError(400, `Unsupported SMS purpose: ${purpose}`);
}

async function sendAliyunSms({ phone, code, purpose }) {
  const accessKeyId = getRequiredEnv("SMS_ALIYUN_ACCESS_KEY_ID");
  const accessKeySecret = getRequiredEnv("SMS_ALIYUN_ACCESS_KEY_SECRET");
  const signName = getRequiredEnv("SMS_ALIYUN_SIGN_NAME");
  const templateCode = buildTemplateCodeForPurpose(purpose);
  const securityToken = (process.env.SMS_ALIYUN_SECURITY_TOKEN || "").trim();
  const date = buildIsoTimestamp();
  const nonce = buildNonce();
  const query = {
    PhoneNumbers: buildPhoneNumber(phone),
    SignName: signName,
    TemplateCode: templateCode,
    TemplateParam: JSON.stringify({ code: String(code) }),
  };
  const canonicalQueryString = buildCanonicalQueryString(query);
  const { authorization, headers } = buildAuthorization({
    canonicalQueryString,
    accessKeyId,
    accessKeySecret,
    date,
    nonce,
    securityToken,
  });

  const response = await fetch(`https://${ALIYUN_SMS_HOST}/?${canonicalQueryString}`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      Host: ALIYUN_SMS_HOST,
      "X-ACS-Action": ALIYUN_SMS_ACTION,
      "X-ACS-Version": ALIYUN_SMS_VERSION,
      "X-ACS-Date": date,
      "X-ACS-Signature-Nonce": nonce,
      "X-ACS-Content-Sha256": EMPTY_BODY_SHA256,
      ...(securityToken ? { "X-ACS-Security-Token": securityToken } : {}),
      Accept: "application/json",
    },
  });

  const payload = await response.json();
  if (!response.ok) {
    throw createHttpError(response.status, payload?.Message || payload?.message || "Aliyun SMS request failed");
  }

  if (payload?.Code !== "OK") {
    throw createHttpError(502, payload?.Message || payload?.Code || "Aliyun SMS send failed");
  }

  return {
    provider: "aliyun",
    provider_request_id: payload?.RequestId || null,
    provider_serial_no: payload?.BizId || null,
    payload,
  };
}

module.exports = {
  sendAliyunSms,
};
