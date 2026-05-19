const express = require("express");
const { query } = require("../config/db");
const { syncUser } = require("../services/userSync");
const {
  buildPhoneUsername,
  createCasdoorUser,
  setCasdoorPassword,
  signInWithPassword,
} = require("../services/casdoorIdentity");
const {
  IDENTITY_COOKIE_NAME,
  createIdentitySessionToken,
  getIdentityClearCookieOptions,
  getIdentityCookieOptions,
  verifyIdentitySessionToken,
} = require("../services/identitySession");
const {
  issueVerificationCode,
  verifyVerificationCode,
} = require("../services/verificationCode");
const { logUserEvent } = require("../services/userEventLog");
const {
  ensureAppId,
  ensureDeviceId,
  ensureOptionalString,
  ensurePassword,
  ensurePhone,
  ensureRequiredString,
} = require("../utils/validation");
const { createHttpError } = require("../utils/http");

const router = express.Router();

async function ensureApplicationExists(appId) {
  const result = await query(
    `
      SELECT id, name, status
      FROM applications
      WHERE id = $1
      LIMIT 1
    `,
    [appId]
  );

  const application = result.rows[0];

  if (!application) {
    throw createHttpError(404, "Application does not exist");
  }

  if (application.status !== "active") {
    throw createHttpError(403, "Application is not active");
  }

  return application;
}

router.get("/applications", async (req, res, next) => {
  try {
    const result = await query(
      `
        SELECT id, name, type, status
        FROM applications
        WHERE status = 'active'
        ORDER BY created_at ASC
      `
    );

    return res.json({
      items: result.rows,
    });
  } catch (error) {
    return next(error);
  }
});

async function getMembership(userId, appId) {
  const result = await query(
    `
      SELECT *
      FROM user_app_memberships
      WHERE user_id = $1
        AND app_id = $2
      LIMIT 1
    `,
    [userId, appId]
  );

  return result.rows[0] || null;
}

async function getUserByPhone(phone) {
  const result = await query(
    `
      SELECT *
      FROM users
      WHERE phone = $1
      LIMIT 1
    `,
    [phone]
  );

  return result.rows[0] || null;
}

async function getAllowedAppIds(userId) {
  const result = await query(
    `
      SELECT app_id
      FROM user_app_memberships
      WHERE user_id = $1
        AND status = 'active'
      ORDER BY created_at ASC
    `,
    [userId]
  );

  return result.rows.map((row) => row.app_id);
}

async function upsertMembership({ userId, appId, registerSource }) {
  const result = await query(
    `
      INSERT INTO user_app_memberships (user_id, app_id, status, register_source, created_at)
      VALUES ($1, $2, 'active', $3, NOW())
      ON CONFLICT (user_id, app_id)
      DO UPDATE SET
        status = 'active',
        register_source = COALESCE(user_app_memberships.register_source, EXCLUDED.register_source)
      RETURNING *
    `,
    [userId, appId, registerSource]
  );

  return result.rows[0];
}

async function getDeviceBinding(userId, appId, deviceId) {
  const result = await query(
    `
      SELECT *
      FROM devices
      WHERE user_id = $1
        AND app_id = $2
        AND device_id = $3
      LIMIT 1
    `,
    [userId, appId, deviceId]
  );

  return result.rows[0] || null;
}

async function isSessionDeviceActive(userId, appId, deviceId) {
  if (!userId || !appId || !deviceId) {
    return false;
  }

  const device = await getDeviceBinding(userId, appId, deviceId);
  return Boolean(device && device.is_active !== false);
}

async function bindSingleActiveDevice({ userId, appId, deviceId, deviceName }) {
  const existingCurrentDevice = await getDeviceBinding(userId, appId, deviceId);
  const replacedDevicesResult = await query(
    `
      UPDATE devices
      SET is_active = false,
          revoked_at = NOW(),
          revoked_reason = 'replaced_by_new_login'
      WHERE user_id = $1
        AND app_id = $2
        AND device_id <> $3
        AND COALESCE(is_active, true) = true
      RETURNING *
    `,
    [userId, appId, deviceId]
  );

  const upsertResult = await query(
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
      RETURNING *
    `,
    [userId, appId, deviceId, deviceName]
  );

  return {
    device: upsertResult.rows[0],
    replacedDevices: replacedDevicesResult.rows,
    existingCurrentDevice,
  };
}

async function revokeDeviceSession({ userId, appId, deviceId, reason }) {
  if (!userId || !appId || !deviceId) {
    return null;
  }

  const result = await query(
    `
      UPDATE devices
      SET is_active = false,
          revoked_at = NOW(),
          revoked_reason = $4
      WHERE user_id = $1
        AND app_id = $2
        AND device_id = $3
        AND COALESCE(is_active, true) = true
      RETURNING *
    `,
    [userId, appId, deviceId, reason]
  );

  return result.rows[0] || null;
}

async function buildIdentityResponse(localUser, membership, casdoorAccessToken = null, sessionContext = {}) {
  const appIds = await getAllowedAppIds(localUser.id);
  const token = await createIdentitySessionToken({
    sub: localUser.id,
    username: localUser.username,
    email: localUser.email,
    phone: localUser.phone,
    picture: null,
    appIds,
    appId: sessionContext.appId || null,
    deviceId: sessionContext.deviceId || null,
  });

  return {
    token,
    user: {
      id: localUser.id,
      username: localUser.username,
      phone: localUser.phone,
      email: localUser.email,
      app_ids: appIds,
    },
    membership: membership
      ? {
          app_id: membership.app_id,
          status: membership.status,
          register_source: membership.register_source,
          created_at: membership.created_at,
          last_login_at: membership.last_login_at,
        }
      : null,
    device: sessionContext.device
      ? {
          app_id: sessionContext.device.app_id,
          device_id: sessionContext.device.device_id,
          device_name: sessionContext.device.device_name,
          is_active: sessionContext.device.is_active !== false,
          last_login: sessionContext.device.last_login,
          replaced_previous_device: Boolean(sessionContext.replacedPreviousDevice),
        }
      : null,
    casdoor_access_token: casdoorAccessToken,
  };
}

function resolveIdentityToken(req) {
  const cookieToken = req.cookies?.[IDENTITY_COOKIE_NAME];
  if (cookieToken) {
    return cookieToken;
  }

  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) {
    return header.slice(7);
  }

  return null;
}

async function getAuthenticatedSessionUser(req) {
  const token = resolveIdentityToken(req) || ensureRequiredString(req.body.token, "token");
  let sessionUser = null;

  try {
    sessionUser = await verifyIdentitySessionToken(token);
  } catch (error) {
    throw createHttpError(401, "Invalid identity session token");
  }

  const userResult = await query(
    `
      SELECT *
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [sessionUser.sub]
  );
  const localUser = userResult.rows[0];

  if (!localUser) {
    throw createHttpError(401, "Current identity session is no longer valid");
  }

  if (localUser.account_status && localUser.account_status !== "active") {
    throw createHttpError(403, "This account has been disabled");
  }

  if (!(await isSessionDeviceActive(localUser.id, sessionUser.appId, sessionUser.deviceId))) {
    throw createHttpError(401, "Current identity session is no longer valid");
  }

  return {
    token,
    sessionUser,
    localUser,
  };
}

router.post("/send-code", async (req, res, next) => {
  try {
    const appId = ensureAppId(req.body.app_id);
    const phone = ensurePhone(req.body.phone);
    const purpose = req.body?.purpose
      ? ensureRequiredString(req.body.purpose, "purpose", { maxLength: 30 })
      : "register";
    await ensureApplicationExists(appId);

    if (purpose === "reset_password") {
      const localUser = await getUserByPhone(phone);
      if (!localUser) {
        throw createHttpError(404, "This phone number has not been registered yet");
      }

      const membership = await getMembership(localUser.id, appId);
      if (!membership || membership.status !== "active") {
        throw createHttpError(403, "This account has not been registered in the target app");
      }
    } else if (purpose !== "register") {
      throw createHttpError(400, "purpose must be register or reset_password");
    }

    const issued = await issueVerificationCode({ appId, phone, purpose });

    return res.json({
      success: true,
      mode: issued.mode,
      app_id: appId,
      phone,
      purpose,
      expires_at: issued.expires_at,
      cooldown_seconds: issued.cooldown_seconds,
      ...(issued.code ? { debug_code: issued.code } : {}),
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/register", async (req, res, next) => {
  try {
    const appId = ensureAppId(req.body.app_id);
    const phone = ensurePhone(req.body.phone);
    const code = ensureRequiredString(req.body.code, "code", { maxLength: 20 });
    const password = ensurePassword(req.body.password);
    const displayName = ensureOptionalString(req.body.display_name, {
      maxLength: 100,
      defaultValue: phone,
    });

    await ensureApplicationExists(appId);
    await verifyVerificationCode({ appId, phone, purpose: "register", code });

    let localUser = null;
    let accountExisted = false;

    const existingUserResult = await query(
      `
        SELECT *
        FROM users
        WHERE phone = $1
        LIMIT 1
      `,
      [phone]
    );

    localUser = existingUserResult.rows[0] || null;

    if (localUser) {
      accountExisted = true;
      try {
        await signInWithPassword({
          username: localUser.username,
          password,
        });
      } catch (error) {
        throw createHttpError(
          409,
          "This phone number already has a unified account. Use the existing password to register another app."
        );
      }
    } else {
      const casdoorUser = await createCasdoorUser({
        phone,
        password,
        displayName,
      });

      localUser = await syncUser({
        sub: casdoorUser.id,
        username: casdoorUser.name || buildPhoneUsername(phone),
        phone: casdoorUser.phone || phone,
        email: casdoorUser.email || null,
        picture: casdoorUser.avatar || null,
        roles: Array.isArray(casdoorUser.roles) ? casdoorUser.roles : [],
        isAdmin: Boolean(casdoorUser.isAdmin),
        isGlobalAdmin: false,
      });
    }

    const existingMembership = await getMembership(localUser.id, appId);
    if (existingMembership) {
      throw createHttpError(409, "This phone number is already registered in the target app");
    }

    const membership = await upsertMembership({
      userId: localUser.id,
      appId,
      registerSource: "self_service_phone",
    });

    if (!accountExisted) {
      await logUserEvent({
        userId: localUser.id,
        appId,
        eventType: "account_created",
        eventSource: "self_service_phone",
        actorMode: "user-self-service",
        actorId: localUser.id,
        actorName: localUser.username,
        details: {
          phone: localUser.phone,
        },
      });
    }

    await logUserEvent({
      userId: localUser.id,
      appId,
      eventType: "membership_registered",
      eventSource: "self_service_phone",
      actorMode: "user-self-service",
      actorId: localUser.id,
      actorName: localUser.username,
      details: {
        register_source: "self_service_phone",
        account_existed: accountExisted,
      },
    });

    return res.status(201).json({
      success: true,
      account_existed: accountExisted,
      user: {
        id: localUser.id,
        username: localUser.username,
        phone: localUser.phone,
        email: localUser.email,
      },
      membership,
      next_action: "login",
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/login/password", async (req, res, next) => {
  try {
    const appId = ensureAppId(req.body.app_id);
    const phone = ensurePhone(req.body.phone);
    const password = ensurePassword(req.body.password);
    const deviceId = ensureDeviceId(req.body.device_id);
    const deviceName = ensureRequiredString(req.body.device_name, "device_name", { maxLength: 100 });

    await ensureApplicationExists(appId);

    const localUser = await getUserByPhone(phone);

    if (!localUser) {
      throw createHttpError(404, "This phone number has not been registered yet");
    }

    if (localUser.account_status && localUser.account_status !== "active") {
      throw createHttpError(403, "This account has been disabled");
    }

    const signInResult = await signInWithPassword({
      username: localUser.username,
      password,
    });

    const syncedUser = await syncUser(signInResult.profile);
    const membership = await getMembership(syncedUser.id, appId);

    if (!membership || membership.status !== "active") {
      throw createHttpError(403, "This account has not been registered in the target app");
    }

    const updatedMembershipResult = await query(
      `
        UPDATE user_app_memberships
        SET last_login_at = NOW()
        WHERE user_id = $1
          AND app_id = $2
        RETURNING *
      `,
      [syncedUser.id, appId]
    );

    const { device, replacedDevices, existingCurrentDevice } = await bindSingleActiveDevice({
      userId: syncedUser.id,
      appId,
      deviceId,
      deviceName,
    });

    const response = await buildIdentityResponse(
      syncedUser,
      updatedMembershipResult.rows[0] || membership,
      signInResult.accessToken,
      {
        appId,
        deviceId,
        device,
        replacedPreviousDevice: replacedDevices.length > 0,
      }
    );

    if (!existingCurrentDevice || existingCurrentDevice.is_active === false) {
      await logUserEvent({
        userId: syncedUser.id,
        appId,
        eventType: "device_bound",
        eventSource: "password_login",
        actorMode: "user",
        actorId: syncedUser.id,
        actorName: syncedUser.username,
        details: {
          device_id: deviceId,
          device_name: deviceName,
        },
      });
    }

    if (replacedDevices.length > 0) {
      await logUserEvent({
        userId: syncedUser.id,
        appId,
        eventType: "device_replaced",
        eventSource: "password_login",
        actorMode: "user",
        actorId: syncedUser.id,
        actorName: syncedUser.username,
        details: {
          current_device_id: deviceId,
          current_device_name: deviceName,
          previous_devices: replacedDevices.map((item) => ({
            device_id: item.device_id,
            device_name: item.device_name,
          })),
        },
      });
    }

    await logUserEvent({
      userId: syncedUser.id,
      appId,
      eventType: "login_password",
      eventSource: "password_login",
      actorMode: "user",
      actorId: syncedUser.id,
      actorName: syncedUser.username,
      details: {
        phone: syncedUser.phone,
        device_id: deviceId,
        device_name: deviceName,
        replaced_previous_device: replacedDevices.length > 0,
      },
    });

    res.cookie(IDENTITY_COOKIE_NAME, response.token, getIdentityCookieOptions());
    return res.json({
      success: true,
      ...response,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/reset-password", async (req, res, next) => {
  try {
    const appId = ensureAppId(req.body.app_id);
    const phone = ensurePhone(req.body.phone);
    const code = ensureRequiredString(req.body.code, "code", { maxLength: 20 });
    const newPassword = ensurePassword(req.body.new_password, "new_password");

    await ensureApplicationExists(appId);
    const localUser = await getUserByPhone(phone);
    if (!localUser) {
      throw createHttpError(404, "This phone number has not been registered yet");
    }

    const membership = await getMembership(localUser.id, appId);
    if (!membership || membership.status !== "active") {
      throw createHttpError(403, "This account has not been registered in the target app");
    }

    await verifyVerificationCode({
      appId,
      phone,
      purpose: "reset_password",
      code,
    });

    await setCasdoorPassword({
      username: localUser.username,
      oldPassword: null,
      newPassword,
      resetMode: true,
    });

    await logUserEvent({
      userId: localUser.id,
      appId,
      eventType: "password_reset_by_code",
      eventSource: "self_service_reset_password",
      actorMode: "user-self-service",
      actorId: localUser.id,
      actorName: localUser.username,
      details: {
        phone: localUser.phone,
      },
    });

    return res.json({
      success: true,
      message: "Password reset successfully",
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/change-password", async (req, res, next) => {
  try {
    const currentPassword = ensurePassword(req.body.current_password, "current_password");
    const newPassword = ensurePassword(req.body.new_password, "new_password");

    if (currentPassword === newPassword) {
      throw createHttpError(400, "new_password must be different from current_password");
    }

    const { sessionUser, localUser } = await getAuthenticatedSessionUser(req);

    await setCasdoorPassword({
      username: localUser.username,
      oldPassword: currentPassword,
      newPassword,
    });

    await logUserEvent({
      userId: localUser.id,
      appId: sessionUser.appId || null,
      eventType: "password_changed",
      eventSource: "self_service_change_password",
      actorMode: "user",
      actorId: localUser.id,
      actorName: localUser.username,
      details: {
        device_id: sessionUser.deviceId || null,
      },
    });

    return res.json({
      success: true,
      message: "Password updated successfully",
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/me", async (req, res, next) => {
  try {
    const token = resolveIdentityToken(req);
    const appId = req.query.app_id ? ensureAppId(req.query.app_id) : null;

    if (!token) {
      return res.json({
        authenticated: false,
        user: null,
      });
    }

    const sessionUser = await verifyIdentitySessionToken(token);
    const userResult = await query(
      `
        SELECT *
        FROM users
        WHERE id = $1
        LIMIT 1
      `,
      [sessionUser.sub]
    );
    const localUser = userResult.rows[0];

    if (!localUser) {
      res.clearCookie(IDENTITY_COOKIE_NAME, getIdentityClearCookieOptions());
      return res.json({
        authenticated: false,
        user: null,
      });
    }

    if (localUser.account_status && localUser.account_status !== "active") {
      res.clearCookie(IDENTITY_COOKIE_NAME, getIdentityClearCookieOptions());
      return res.json({
        authenticated: false,
        user: null,
      });
    }

    if (!(await isSessionDeviceActive(localUser.id, sessionUser.appId, sessionUser.deviceId))) {
      res.clearCookie(IDENTITY_COOKIE_NAME, getIdentityClearCookieOptions());
      return res.json({
        authenticated: false,
        user: null,
      });
    }

    const membershipsResult = await query(
      `
        SELECT *
        FROM user_app_memberships
        WHERE user_id = $1
        ORDER BY created_at ASC
      `,
      [localUser.id]
    );

    const memberships = membershipsResult.rows.map((membership) => ({
      app_id: membership.app_id,
      status: membership.status,
      register_source: membership.register_source,
      created_at: membership.created_at,
      last_login_at: membership.last_login_at,
    }));

    const currentMembership = appId
      ? memberships.find((membership) => membership.app_id === appId) || null
      : null;

    return res.json({
      authenticated: true,
      user: {
        id: localUser.id,
        username: localUser.username,
        phone: localUser.phone,
        email: localUser.email,
        app_ids: memberships
          .filter((membership) => membership.status === "active")
          .map((membership) => membership.app_id),
      },
      session: {
        app_id: sessionUser.appId,
        device_id: sessionUser.deviceId,
      },
      memberships,
      current_membership: currentMembership,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/access-check", async (req, res, next) => {
  try {
    const token = resolveIdentityToken(req) || ensureRequiredString(req.body.token, "token");
    const appId = ensureAppId(req.body.app_id);
    let sessionUser = null;

    try {
      sessionUser = await verifyIdentitySessionToken(token);
    } catch (error) {
      return res.status(401).json({
        valid: false,
        app_id: appId,
        user_id: null,
        session: {
          app_id: null,
          device_id: null,
          device_valid: false,
        },
        membership: null,
        error: "Invalid identity session token",
      });
    }

    const userResult = await query(
      `
        SELECT account_status
        FROM users
        WHERE id = $1
        LIMIT 1
      `,
      [sessionUser.sub]
    );
    const localUser = userResult.rows[0];
    const membership = await getMembership(sessionUser.sub, appId);
    const deviceValid = await isSessionDeviceActive(sessionUser.sub, sessionUser.appId, sessionUser.deviceId);

    return res.json({
      valid: Boolean(
        localUser?.account_status === "active" &&
          membership &&
          membership.status === "active" &&
          deviceValid
      ),
      app_id: appId,
      user_id: sessionUser.sub,
      session: {
        app_id: sessionUser.appId,
        device_id: sessionUser.deviceId,
        device_valid: deviceValid,
      },
      membership: membership
        ? {
            app_id: membership.app_id,
            status: membership.status,
            register_source: membership.register_source,
            created_at: membership.created_at,
            last_login_at: membership.last_login_at,
          }
        : null,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/logout", async (req, res) => {
  try {
    const token = resolveIdentityToken(req);
    if (token) {
      try {
        const sessionUser = await verifyIdentitySessionToken(token);
        await revokeDeviceSession({
          userId: sessionUser.sub,
          appId: sessionUser.appId,
          deviceId: sessionUser.deviceId,
          reason: "user_logout",
        });
      } catch (error) {
        // Ignore expired or invalid session tokens during logout.
      }
    }

    res.clearCookie(IDENTITY_COOKIE_NAME, getIdentityClearCookieOptions());
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
