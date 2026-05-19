const { SignJWT, jwtVerify } = require("jose");

const SESSION_COOKIE_NAME = "coreid_session";
const SESSION_ISSUER = "coreid-user-center";
const SESSION_AUDIENCE = "coreid-admin";
const encoder = new TextEncoder();

function getSessionSecret() {
  const secret = process.env.AUTH_SESSION_SECRET || "coreid-dev-session-secret-change-me";
  return encoder.encode(secret);
}

function getCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 12 * 60 * 60 * 1000,
  };
}

function getClearCookieOptions() {
  const { httpOnly, sameSite, secure, path } = getCookieOptions();
  return {
    httpOnly,
    sameSite,
    secure,
    path,
  };
}

async function createSessionToken(user) {
  return new SignJWT({
    sub: user.sub,
    username: user.username,
    email: user.email || null,
    phone: user.phone || null,
    roles: user.roles || [],
    isAdmin: Boolean(user.isAdmin),
    isGlobalAdmin: Boolean(user.isGlobalAdmin),
    picture: user.picture || null,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setExpirationTime("12h")
    .sign(getSessionSecret());
}

async function verifySessionToken(token) {
  const { payload } = await jwtVerify(token, getSessionSecret(), {
    issuer: SESSION_ISSUER,
    audience: SESSION_AUDIENCE,
  });

  return {
    sub: payload.sub,
    username: payload.username,
    email: payload.email || null,
    phone: payload.phone || null,
    roles: Array.isArray(payload.roles) ? payload.roles : [],
    isAdmin: Boolean(payload.isAdmin),
    isGlobalAdmin: Boolean(payload.isGlobalAdmin),
    picture: payload.picture || null,
  };
}

module.exports = {
  SESSION_COOKIE_NAME,
  createSessionToken,
  verifySessionToken,
  getCookieOptions,
  getClearCookieOptions,
};
