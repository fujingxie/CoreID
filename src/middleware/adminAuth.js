const { SESSION_COOKIE_NAME, verifySessionToken } = require("../services/session");
const { isAdminProfile } = require("../services/casdoor");

function getBearerToken(req) {
  const authorization = req.header("authorization");
  if (!authorization) {
    return null;
  }

  return authorization.replace(/^Bearer\s+/i, "").trim();
}

async function adminAuth(req, res, next) {
  const enforceSecret = process.env.ENFORCE_ADMIN_SECRET === "true";
  const enforceCasdoor = process.env.ENFORCE_CASDOOR_AUTH === "true";

  if (!enforceSecret && !enforceCasdoor) {
    return next();
  }

  const secret = req.header("x-admin-secret") || getBearerToken(req);
  if (enforceSecret && secret === process.env.ADMIN_SECRET) {
    req.admin = {
      mode: "secret",
    };
    return next();
  }

  if (!enforceCasdoor) {
    return res.status(401).json({ error: "Unauthorized admin request" });
  }

  const sessionToken = req.cookies?.[SESSION_COOKIE_NAME] || getBearerToken(req);
  if (!sessionToken) {
    return res.status(401).json({
      error: "Casdoor authentication required",
      login_url: "/api/auth/login?redirect=1",
    });
  }

  try {
    const user = await verifySessionToken(sessionToken);
    if (!isAdminProfile(user)) {
      return res.status(403).json({ error: "Authenticated user is not allowed to access admin APIs" });
    }

    req.admin = {
      mode: "casdoor",
      user,
    };
    req.currentUser = user;
    return next();
  } catch (error) {
    return res.status(401).json({
      error: "Casdoor session is invalid or expired",
      login_url: "/api/auth/login?redirect=1",
    });
  }
}

module.exports = adminAuth;
