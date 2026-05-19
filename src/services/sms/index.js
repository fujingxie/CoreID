const { createHttpError } = require("../../utils/http");
const { sendAliyunSms } = require("./aliyunSms");
const { sendTencentCloudSms } = require("./tencentCloudSms");

function getSmsProvider() {
  return (process.env.SMS_PROVIDER || "tencentcloud").trim().toLowerCase();
}

async function sendSmsCode({ phone, code, purpose, ttlMinutes }) {
  const provider = getSmsProvider();

  if (provider === "aliyun") {
    return sendAliyunSms({ phone, code, purpose, ttlMinutes });
  }

  if (provider === "tencentcloud") {
    return sendTencentCloudSms({ phone, code, purpose, ttlMinutes });
  }

  throw createHttpError(503, `Unsupported SMS provider: ${provider}`);
}

module.exports = {
  getSmsProvider,
  sendSmsCode,
};
