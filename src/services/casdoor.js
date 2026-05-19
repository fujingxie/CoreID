const crypto = require("crypto");
const { URL } = require("url");
const { createRemoteJWKSet, jwtVerify } = require("jose");

let discoveryCache = null;
let jwksCache = null;

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isCasdoorEnabled() {
  return Boolean(
    process.env.CASDOOR_ENDPOINT &&
      process.env.CASDOOR_CLIENT_ID &&
      process.env.CASDOOR_CLIENT_SECRET &&
      process.env.CASDOOR_REDIRECT_URI
  );
}

function normalizeEndpoint(endpoint) {
  return String(endpoint || "").replace(/\/+$/, "");
}

function getPublicEndpoint() {
  return normalizeEndpoint(process.env.CASDOOR_ENDPOINT);
}

function getInternalEndpoint() {
  return normalizeEndpoint(process.env.CASDOOR_INTERNAL_ENDPOINT || process.env.CASDOOR_ENDPOINT);
}

function getDiscoveryUrl() {
  const endpoint = getInternalEndpoint();
  return `${endpoint}/.well-known/openid-configuration`;
}

function rewriteEndpointOrigin(urlString, endpoint) {
  const targetEndpoint = normalizeEndpoint(endpoint);

  if (!targetEndpoint) {
    return urlString;
  }

  const sourceUrl = new URL(urlString);
  const targetUrl = new URL(targetEndpoint);

  sourceUrl.protocol = targetUrl.protocol;
  sourceUrl.username = targetUrl.username;
  sourceUrl.password = targetUrl.password;
  sourceUrl.hostname = targetUrl.hostname;
  sourceUrl.port = targetUrl.port;

  return sourceUrl.toString();
}

function getBrowserIssuer(discovery) {
  return rewriteEndpointOrigin(discovery.issuer, getPublicEndpoint());
}

function getBrowserAuthorizationEndpoint(discovery) {
  return rewriteEndpointOrigin(discovery.authorization_endpoint, getPublicEndpoint());
}

function getInternalServiceUrl(urlString) {
  return rewriteEndpointOrigin(urlString, getInternalEndpoint());
}

function getAllowedIssuers(discovery) {
  return Array.from(
    new Set(
      [
        normalizeEndpoint(discovery.issuer),
        getBrowserIssuer(discovery),
        rewriteEndpointOrigin(discovery.issuer, getInternalEndpoint()),
      ].filter(Boolean)
    )
  );
}

async function getDiscoveryDocument() {
  if (!isCasdoorEnabled()) {
    throw new Error("Casdoor environment variables are incomplete");
  }

  if (discoveryCache) {
    return discoveryCache;
  }

  const response = await fetch(getDiscoveryUrl(), {
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to load Casdoor discovery document: ${response.status}`);
  }

  discoveryCache = await response.json();
  return discoveryCache;
}

async function getRemoteJwks() {
  if (jwksCache) {
    return jwksCache;
  }

  const discovery = await getDiscoveryDocument();
  jwksCache = createRemoteJWKSet(new URL(getInternalServiceUrl(discovery.jwks_uri)));
  return jwksCache;
}

function generateOpaqueValue(size = 24) {
  return crypto.randomBytes(size).toString("hex");
}

function getScopes() {
  return process.env.CASDOOR_SCOPE || "openid profile email phone offline_access";
}

async function buildAuthorizationUrl({ state, nonce }) {
  const discovery = await getDiscoveryDocument();
  const browserAuthorizationEndpoint = getBrowserAuthorizationEndpoint(discovery);
  const url = new URL(browserAuthorizationEndpoint);
  url.searchParams.set("client_id", process.env.CASDOOR_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", process.env.CASDOOR_REDIRECT_URI);
  url.searchParams.set("scope", getScopes());
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  return url.toString();
}

async function exchangeCodeForTokens(code) {
  const discovery = await getDiscoveryDocument();
  const tokenEndpoint = getInternalServiceUrl(discovery.token_endpoint);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: process.env.CASDOOR_CLIENT_ID,
    client_secret: process.env.CASDOOR_CLIENT_SECRET,
    code,
    redirect_uri: process.env.CASDOOR_REDIRECT_URI,
  });

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || "Failed to exchange Casdoor authorization code");
  }

  return payload;
}

function normalizeRoles(payload) {
  if (Array.isArray(payload.roles)) {
    return payload.roles.map(String);
  }

  if (typeof payload.roles === "string") {
    return splitCsv(payload.roles);
  }

  return [];
}

function normalizeUserProfile(payload) {
  const username =
    payload.preferred_username ||
    payload.name ||
    payload.username ||
    payload.sub;

  return {
    sub: payload.sub,
    username,
    email: payload.email || null,
    phone: payload.phone || payload.phone_number || null,
    picture: payload.picture || payload.avatar || null,
    roles: normalizeRoles(payload),
    isAdmin: Boolean(payload.isAdmin),
    isGlobalAdmin: Boolean(payload.isGlobalAdmin),
  };
}

async function verifyCasdoorJwt(token, { nonce } = {}) {
  if (!token || typeof token !== "string" || token.split(".").length !== 3) {
    throw new Error("Casdoor token must be a JWT");
  }

  const discovery = await getDiscoveryDocument();
  const jwks = await getRemoteJwks();
  const allowedIssuers = getAllowedIssuers(discovery);
  const { payload } = await jwtVerify(token, jwks, {
    audience: process.env.CASDOOR_CLIENT_ID,
  });

  const normalizedIssuer = normalizeEndpoint(payload.iss);
  if (!allowedIssuers.includes(normalizedIssuer)) {
    throw new Error(`Unexpected Casdoor issuer: ${payload.iss}`);
  }

  if (nonce && payload.nonce !== nonce) {
    throw new Error("Casdoor nonce verification failed");
  }

  return payload;
}

function isAdminProfile(user) {
  if (!user) {
    return false;
  }

  if (user.isAdmin || user.isGlobalAdmin) {
    return true;
  }

  const allowedUsers = splitCsv(process.env.CASDOOR_ADMIN_USERS);
  const allowedRoles = splitCsv(process.env.CASDOOR_ADMIN_ROLES);

  if (
    allowedUsers.includes(user.username) ||
    allowedUsers.includes(user.sub) ||
    (user.email && allowedUsers.includes(user.email))
  ) {
    return true;
  }

  if (allowedRoles.length && Array.isArray(user.roles)) {
    return user.roles.some((role) => allowedRoles.includes(role));
  }

  return false;
}

function getAdminUiUrl() {
  return process.env.ADMIN_UI_URL || "/admin";
}

module.exports = {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generateOpaqueValue,
  getAdminUiUrl,
  getDiscoveryDocument,
  getInternalEndpoint,
  getPublicEndpoint,
  isAdminProfile,
  isCasdoorEnabled,
  normalizeUserProfile,
  verifyCasdoorJwt,
};
