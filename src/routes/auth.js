const express = require("express");
const { query } = require("../config/db");
const {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generateOpaqueValue,
  getAdminUiUrl,
  isAdminProfile,
  isCasdoorEnabled,
  normalizeUserProfile,
  verifyCasdoorJwt,
} = require("../services/casdoor");
const {
  SESSION_COOKIE_NAME,
  createSessionToken,
  getClearCookieOptions,
  getCookieOptions,
  verifySessionToken,
} = require("../services/session");
const { syncUser } = require("../services/userSync");

const router = express.Router();
const AUTH_STATE_COOKIE = "coreid_auth_state";
const AUTH_NONCE_COOKIE = "coreid_auth_nonce";

function getEphemeralCookieOptions() {
  return {
    ...getCookieOptions(),
    maxAge: 10 * 60 * 1000,
  };
}

function isDevTokenBypassEnabled() {
  return process.env.ALLOW_DEV_TOKEN_BYPASS !== "false";
}

function resolveDevToken(token) {
  if (!token) {
    return null;
  }

  if (token.startsWith("user:")) {
    return token.slice(5);
  }

  return token;
}

async function loadPurchaseStatus(userId, appId) {
  const result = await query(
    `
      SELECT plan, expired_at
      FROM purchases
      WHERE user_id = $1
        AND app_id = $2
        AND status = 'paid'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [userId, appId]
  );

  const purchase = result.rows[0];
  const isPurchased =
    !!purchase &&
    (!purchase.expired_at || new Date(purchase.expired_at).getTime() > Date.now());

  return {
    isPurchased,
    purchase,
  };
}

async function registerDevice(userId, appId, deviceId, deviceName = "Auto registered device") {
  if (!deviceId) {
    return;
  }

  await query(
    `
      UPDATE devices
      SET is_active = false,
          revoked_at = NOW(),
          revoked_reason = 'replaced_by_verify'
      WHERE user_id = $1
        AND app_id = $2
        AND device_id <> $3
        AND COALESCE(is_active, true) = true
    `,
    [userId, appId, deviceId]
  );

  await query(
    `
      INSERT INTO devices (
        user_id,
        app_id,
        device_id,
        device_name,
        is_active,
        revoked_at,
        revoked_reason,
        last_login
      )
      VALUES ($1, $2, $3, $4, true, NULL, NULL, NOW())
      ON CONFLICT (user_id, app_id, device_id)
      DO UPDATE SET
        device_name = EXCLUDED.device_name,
        is_active = true,
        revoked_at = NULL,
        revoked_reason = NULL,
        last_login = NOW()
    `,
    [userId, appId, deviceId, deviceName]
  );
}

async function buildVerifyResponse(profile, appId, deviceId, deviceName) {
  const user = await syncUser(profile);
  const { isPurchased, purchase } = await loadPurchaseStatus(user.id, appId);

  await registerDevice(user.id, appId, deviceId, deviceName || profile.username);

  return {
    valid: true,
    user_id: user.id,
    username: user.username,
    is_purchased: isPurchased,
    plan: purchase?.plan || null,
    expired_at: purchase?.expired_at || null,
  };
}

router.get("/me", async (req, res) => {
  const authEnabled = process.env.ENFORCE_CASDOOR_AUTH === "true";
  const sessionToken = req.cookies?.[SESSION_COOKIE_NAME];

  if (!sessionToken) {
    return res.json({
      enabled: authEnabled,
      authenticated: false,
      login_url: authEnabled ? "/api/auth/login?redirect=1" : null,
      user: null,
    });
  }

  try {
    const user = await verifySessionToken(sessionToken);
    return res.json({
      enabled: authEnabled,
      authenticated: true,
      user: {
        ...user,
        can_access_admin: isAdminProfile(user),
      },
    });
  } catch (error) {
    res.clearCookie(SESSION_COOKIE_NAME, getClearCookieOptions());
    return res.json({
      enabled: authEnabled,
      authenticated: false,
      login_url: authEnabled ? "/api/auth/login?redirect=1" : null,
      user: null,
    });
  }
});

router.get("/login", async (req, res, next) => {
  try {
    if (!isCasdoorEnabled()) {
      return res.status(503).json({
        error: "Casdoor is not configured yet",
      });
    }

    const state = generateOpaqueValue();
    const nonce = generateOpaqueValue();
    const authorizationUrl = await buildAuthorizationUrl({ state, nonce });

    res.cookie(AUTH_STATE_COOKIE, state, getEphemeralCookieOptions());
    res.cookie(AUTH_NONCE_COOKIE, nonce, getEphemeralCookieOptions());

    if (req.query.redirect === "1") {
      return res.redirect(authorizationUrl);
    }

    return res.json({
      authorization_url: authorizationUrl,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/callback", async (req, res, next) => {
  try {
    const { code, state, error, error_description: errorDescription } = req.query;

    if (error) {
      return res.status(400).send(`Casdoor login failed: ${errorDescription || error}`);
    }

    if (!code || !state) {
      return res.status(400).send("Casdoor callback is missing code or state");
    }

    if (req.cookies?.[AUTH_STATE_COOKIE] !== state) {
      return res.status(400).send("Casdoor state verification failed");
    }

    const tokenSet = await exchangeCodeForTokens(code);
    const idToken = tokenSet.id_token || tokenSet.access_token;
    const payload = await verifyCasdoorJwt(idToken, {
      nonce: req.cookies?.[AUTH_NONCE_COOKIE],
    });
    const profile = normalizeUserProfile(payload);

    await syncUser(profile);

    const sessionToken = await createSessionToken(profile);
    res.cookie(SESSION_COOKIE_NAME, sessionToken, getCookieOptions());
    res.clearCookie(AUTH_STATE_COOKIE, getClearCookieOptions());
    res.clearCookie(AUTH_NONCE_COOKIE, getClearCookieOptions());

    return res.redirect(getAdminUiUrl());
  } catch (error) {
    return next(error);
  }
});

router.post("/logout", (req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME, getClearCookieOptions());
  res.clearCookie(AUTH_STATE_COOKIE, getClearCookieOptions());
  res.clearCookie(AUTH_NONCE_COOKIE, getClearCookieOptions());
  res.json({ success: true });
});

router.post("/verify", async (req, res, next) => {
  try {
    const { token, app_id: appId, device_id: deviceId, device_name: deviceName } = req.body;

    if (!token || !appId) {
      return res.status(400).json({ error: "token and app_id are required" });
    }

    if (isDevTokenBypassEnabled() && !isCasdoorEnabled()) {
      const userId = resolveDevToken(token);
      const userResult = await query(
        `
          SELECT id, username, phone, email
          FROM users
          WHERE id = $1
          LIMIT 1
        `,
        [userId]
      );
      const user = userResult.rows[0];

      if (!user) {
        return res.json({ valid: false });
      }

      const response = await buildVerifyResponse(
        {
          sub: user.id,
          username: user.username,
          phone: user.phone,
          email: user.email,
          roles: [],
          isAdmin: false,
          isGlobalAdmin: false,
        },
        appId,
        deviceId,
        deviceName
      );

      return res.json(response);
    }

    if (!isCasdoorEnabled()) {
      return res.status(503).json({
        error: "Casdoor is not configured and development token bypass is disabled",
      });
    }

    const payload = await verifyCasdoorJwt(token);
    const profile = normalizeUserProfile(payload);
    const response = await buildVerifyResponse(profile, appId, deviceId, deviceName);
    return res.json(response);
  } catch (error) {
    if (error.message.includes("JWT")) {
      return res.json({ valid: false, error: error.message });
    }

    return next(error);
  }
});

module.exports = router;
