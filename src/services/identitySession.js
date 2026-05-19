const { SignJWT, jwtVerify } = require("jose");
const { getCookieOptions, getClearCookieOptions } = require("./session");

const encoder = new TextEncoder();
const IDENTITY_COOKIE_NAME = "coreid_identity_session";
const IDENTITY_ISSUER = "coreid-identity";
const IDENTITY_AUDIENCE = "coreid-app";

function getIdentitySecret() {
  const secret = process.env.AUTH_SESSION_SECRET || "coreid-dev-session-secret-change-me";
  return encoder.encode(secret);
}

async function createIdentitySessionToken(user) {
  return new SignJWT({
    sub: user.sub,
    username: user.username,
    email: user.email || null,
    phone: user.phone || null,
    picture: user.picture || null,
    app_ids: Array.isArray(user.appIds) ? user.appIds : [],
    app_id: user.appId || null,
    device_id: user.deviceId || null,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setIssuer(IDENTITY_ISSUER)
    .setAudience(IDENTITY_AUDIENCE)
    .setExpirationTime("12h")
    .sign(getIdentitySecret());
}

async function verifyIdentitySessionToken(token) {
  const { payload } = await jwtVerify(token, getIdentitySecret(), {
    issuer: IDENTITY_ISSUER,
    audience: IDENTITY_AUDIENCE,
  });

  return {
    sub: payload.sub,
    username: payload.username,
    email: payload.email || null,
    phone: payload.phone || null,
    picture: payload.picture || null,
    appIds: Array.isArray(payload.app_ids) ? payload.app_ids : [],
    appId: payload.app_id || null,
    deviceId: payload.device_id || null,
  };
}

module.exports = {
  IDENTITY_COOKIE_NAME,
  createIdentitySessionToken,
  getIdentityClearCookieOptions: getClearCookieOptions,
  getIdentityCookieOptions: getCookieOptions,
  verifyIdentitySessionToken,
};
