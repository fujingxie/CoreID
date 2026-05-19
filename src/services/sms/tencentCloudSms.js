const crypto = require("crypto");
const { createHttpError } = require("../../utils/http");

const TENCENT_SMS_HOST = "sms.tencentcloudapi.com";
const TENCENT_SMS_VERSION = "2021-01-11";
const TENCENT_SMS_ACTION = "SendSms";
const TENCENT_SMS_SERVICE = "sms";
const DEFAULT_REGION = "ap-guangzhou";
const DEFAULT_COUNTRY_CODE = "+86";

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

function hmacSha256(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value).digest(encoding);
}

function buildAuthorization({ timestamp, payload, secretId, secretKey, region }) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const credentialScope = `${date}/${TENCENT_SMS_SERVICE}/tc3_request`;
  const canonicalHeaders =
    `content-type:application/json; charset=utf-8\n` +
    `host:${TENCENT_SMS_HOST}\n` +
    `x-tc-action:${TENCENT_SMS_ACTION.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const hashedRequestPayload = sha256Hex(payload);
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    hashedRequestPayload,
  ].join("\n");

  const stringToSign = [
    "TC3-HMAC-SHA256",
    String(timestamp),
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const secretDate = hmacSha256(`TC3${secretKey}`, date);
  const secretService = hmacSha256(secretDate, TENCENT_SMS_SERVICE);
  const secretSigning = hmacSha256(secretService, "tc3_request");
  const signature = hmacSha256(secretSigning, stringToSign, "hex");

  return `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function buildPhoneNumber(phone) {
  const configured = (process.env.SMS_DEFAULT_COUNTRY_CODE || DEFAULT_COUNTRY_CODE).trim();
  const prefix = configured.startsWith("+") ? configured : `+${configured}`;
  return `${prefix}${phone}`;
}

function buildTemplateIdForPurpose(purpose) {
  if (purpose === "register") {
    return getRequiredEnv("SMS_TENCENT_TEMPLATE_REGISTER");
  }
  if (purpose === "reset_password") {
    return getRequiredEnv("SMS_TENCENT_TEMPLATE_RESET_PASSWORD");
  }
  throw createHttpError(400, `Unsupported SMS purpose: ${purpose}`);
}

async function sendTencentCloudSms({ phone, code, purpose, ttlMinutes }) {
  const secretId = getRequiredEnv("SMS_TENCENT_SECRET_ID");
  const secretKey = getRequiredEnv("SMS_TENCENT_SECRET_KEY");
  const sdkAppId = getRequiredEnv("SMS_TENCENT_SDK_APP_ID");
  const signName = getRequiredEnv("SMS_TENCENT_SIGN_NAME");
  const templateId = buildTemplateIdForPurpose(purpose);
  const region = process.env.SMS_TENCENT_REGION || DEFAULT_REGION;
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    SmsSdkAppId: sdkAppId,
    SignName: signName,
    TemplateId: templateId,
    TemplateParamSet: [String(code), String(ttlMinutes)],
    PhoneNumberSet: [buildPhoneNumber(phone)],
    SessionContext: `${purpose}:${phone}`,
  });

  const authorization = buildAuthorization({
    timestamp,
    payload: body,
    secretId,
    secretKey,
    region,
  });

  const response = await fetch(`https://${TENCENT_SMS_HOST}/`, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json; charset=utf-8",
      Host: TENCENT_SMS_HOST,
      "X-TC-Action": TENCENT_SMS_ACTION,
      "X-TC-Version": TENCENT_SMS_VERSION,
      "X-TC-Region": region,
      "X-TC-Timestamp": String(timestamp),
    },
    body,
  });

  const payload = await response.json();
  const sendResult = payload?.Response?.SendStatusSet?.[0];

  if (!response.ok) {
    const errorMessage =
      payload?.Response?.Error?.Message || payload?.message || "Tencent Cloud SMS request failed";
    throw createHttpError(response.status, errorMessage);
  }

  if (!sendResult || sendResult.Code !== "Ok") {
    throw createHttpError(
      502,
      sendResult?.Message || payload?.Response?.Error?.Message || "Tencent Cloud SMS send failed"
    );
  }

  return {
    provider: "tencentcloud",
    provider_request_id: payload?.Response?.RequestId || null,
    provider_serial_no: sendResult.SerialNo || null,
    payload,
  };
}

module.exports = {
  sendTencentCloudSms,
};
