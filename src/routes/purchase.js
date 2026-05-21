const express = require("express");
const { query } = require("../config/db");
const { logPurchaseEvent } = require("../services/purchaseEventLog");
const { verifyPaymentCallbackSignature } = require("../services/paymentCallback");
const {
  purchaseStatuses,
  purchaseModes,
  canTransitionPurchaseStatus,
} = require("../services/purchaseLifecycle");
const {
  ensureAppId,
  ensureDateInput,
  ensureEnum,
  ensureMoneyAmount,
  ensureOptionalUrl,
  ensurePlanCode,
  ensureOptionalString,
  ensureOrderNo,
  parsePagination,
  ensureRequiredString,
} = require("../utils/validation");
const { createHttpError } = require("../utils/http");

const router = express.Router();

function serializePlanRow(row) {
  return {
    ...row,
    price: Number(row.price || 0),
    original_price: row.original_price == null ? null : Number(row.original_price),
    duration_days: row.duration_days == null ? null : Number(row.duration_days),
    sort_order: Number(row.sort_order || 0),
    is_trial: Boolean(row.is_trial),
    is_renewable: Boolean(row.is_renewable),
    is_recommended: Boolean(row.is_recommended),
    is_visible: row.is_visible !== false,
    features: Array.isArray(row.features) ? row.features : [],
  };
}

function serializePurchaseRow(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    amount: Number(row.amount || 0),
    payment_payload:
      row.payment_payload && typeof row.payment_payload === "object" ? row.payment_payload : row.payment_payload || null,
  };
}

function buildPurchaseErrorPayload(reasonCode, message, extra = {}) {
  return {
    allowed: false,
    reason: message,
    reason_code: reasonCode,
    message,
    ...extra,
  };
}

function derivePurchaseBlockReason(configuredPlan, context, purchaseMode, renewalBasePurchase) {
  if (context.user?.account_status !== "active") {
    return buildPurchaseErrorPayload("ACCOUNT_DISABLED", "This account has been disabled");
  }

  if (!context.membership || context.membership.status !== "active") {
    return buildPurchaseErrorPayload("APP_MEMBERSHIP_REQUIRED", "This account has not been registered in the target app");
  }

  if (configuredPlan.is_trial && context.trialUsed) {
    return buildPurchaseErrorPayload("TRIAL_ALREADY_USED", "Trial plan has already been used in this app");
  }

  if (purchaseMode === "renew") {
    if (!configuredPlan.is_renewable) {
      return buildPurchaseErrorPayload("PLAN_NOT_RENEWABLE", "This plan does not support renewal");
    }

    if (!renewalBasePurchase) {
      return buildPurchaseErrorPayload("RENEWAL_NOT_AVAILABLE", "No renewable purchase record exists for this plan");
    }

    if (renewalBasePurchase.plan !== configuredPlan.code) {
      return buildPurchaseErrorPayload("RENEWAL_PLAN_MISMATCH", "Only the current active plan can be renewed");
    }
  }

  if (
    purchaseMode === "new" &&
    configuredPlan.is_renewable &&
    context.currentEntitlement &&
    context.currentEntitlement.plan === configuredPlan.code
  ) {
    return buildPurchaseErrorPayload("USE_RENEW_INSTEAD", "Use renew for the current active plan");
  }

  return null;
}

async function getPurchaseByOrderNo(orderNo) {
  const result = await query(
    `
      SELECT p.*, plan_config.name AS plan_name, plan_config.is_trial, plan_config.is_renewable
      FROM purchases p
      LEFT JOIN app_plans plan_config
        ON plan_config.app_id = p.app_id
       AND plan_config.code = p.plan
      WHERE p.order_no = $1
      LIMIT 1
    `,
    [orderNo]
  );

  return result.rows[0] || null;
}

async function getDetailedPurchaseByOrderNo(orderNo) {
  const result = await query(
    `
      SELECT
        p.*,
        u.username,
        u.phone,
        u.email,
        a.name AS app_name,
        plan_config.name AS plan_name,
        plan_config.description AS plan_description,
        plan_config.duration_days,
        plan_config.is_trial,
        plan_config.is_renewable
      FROM purchases p
      JOIN users u ON u.id = p.user_id
      JOIN applications a ON a.id = p.app_id
      LEFT JOIN app_plans plan_config
        ON plan_config.app_id = p.app_id
       AND plan_config.code = p.plan
      WHERE p.order_no = $1
      LIMIT 1
    `,
    [orderNo]
  );

  return result.rows[0] || null;
}

async function listPurchaseEvents(orderNo) {
  const result = await query(
    `
      SELECT *
      FROM purchase_events
      WHERE order_no = $1
      ORDER BY created_at DESC, id DESC
    `,
    [orderNo]
  );

  return result.rows;
}

async function getActivePlan(appId, planCode) {
  const result = await query(
    `
      SELECT *
      FROM app_plans
      WHERE app_id = $1
        AND code = $2
        AND status = 'active'
      LIMIT 1
    `,
    [appId, planCode]
  );

  return result.rows[0] || null;
}

async function getPurchaseContext(userId, appId) {
  const [userResult, membershipResult, latestPurchaseResult, currentEntitlementResult, trialUsageResult] =
    await Promise.all([
      query(
        `
          SELECT id, username, phone, email, COALESCE(account_status, 'active') AS account_status
          FROM users
          WHERE id = $1
          LIMIT 1
        `,
        [userId]
      ),
      query(
        `
          SELECT *
          FROM user_app_memberships
          WHERE user_id = $1
            AND app_id = $2
          LIMIT 1
        `,
        [userId, appId]
      ),
      query(
        `
          SELECT p.*, plan_config.name AS plan_name, plan_config.is_trial, plan_config.is_renewable
          FROM purchases p
          LEFT JOIN app_plans plan_config
            ON plan_config.app_id = p.app_id
           AND plan_config.code = p.plan
          WHERE p.user_id = $1
            AND p.app_id = $2
          ORDER BY p.created_at DESC
          LIMIT 1
        `,
        [userId, appId]
      ),
      query(
        `
          SELECT p.*, plan_config.name AS plan_name, plan_config.is_trial, plan_config.is_renewable
          FROM purchases p
          LEFT JOIN app_plans plan_config
            ON plan_config.app_id = p.app_id
           AND plan_config.code = p.plan
          WHERE p.user_id = $1
            AND p.app_id = $2
            AND p.status = 'paid'
            AND (p.expired_at IS NULL OR p.expired_at > NOW())
          ORDER BY COALESCE(p.expired_at, NOW() + INTERVAL '100 years') DESC, p.created_at DESC
          LIMIT 1
        `,
        [userId, appId]
      ),
      query(
        `
          SELECT EXISTS (
            SELECT 1
            FROM purchases p
            JOIN app_plans plan_config
              ON plan_config.app_id = p.app_id
             AND plan_config.code = p.plan
            WHERE p.user_id = $1
              AND p.app_id = $2
              AND plan_config.is_trial = true
              AND p.status NOT IN ('failed', 'refunded')
          ) AS trial_used
        `,
        [userId, appId]
      ),
    ]);

  return {
    user: userResult.rows[0] || null,
    membership: membershipResult.rows[0] || null,
    latestPurchase: latestPurchaseResult.rows[0] || null,
    currentEntitlement: currentEntitlementResult.rows[0] || null,
    trialUsed: Boolean(trialUsageResult.rows[0]?.trial_used),
  };
}

function calculateExpectedExpiry({ durationDays, renewalBasePurchase, purchaseMode }) {
  if (!durationDays) {
    return null;
  }

  const now = Date.now();
  let baseTime = now;

  if (purchaseMode === "renew" && renewalBasePurchase?.expired_at) {
    baseTime = Math.max(now, new Date(renewalBasePurchase.expired_at).getTime());
  }

  return new Date(baseTime + Number(durationDays) * 24 * 60 * 60 * 1000).toISOString();
}

function buildPreviewPayload({
  purchaseMode,
  configuredPlan,
  context,
  amount,
  expectedExpiredAt,
  allowed = true,
  reason = null,
  reasonCode = null,
}) {
  return {
    allowed,
    reason,
    reason_code: reasonCode,
    message: reason,
    purchase_mode: purchaseMode,
    plan: serializePlanRow(configuredPlan),
    current_plan: serializePurchaseRow(context.currentEntitlement),
    latest_purchase: serializePurchaseRow(context.latestPurchase),
    entitlement: {
      is_active: Boolean(context.currentEntitlement),
      trial_used: Boolean(context.trialUsed),
      can_renew: Boolean(
        configuredPlan.is_renewable &&
          context.currentEntitlement &&
          context.currentEntitlement.plan === configuredPlan.code
      ),
    },
    pricing: {
      amount,
      currency: configuredPlan.currency,
      expected_expired_at: expectedExpiredAt,
    },
    ui_hints: {
      is_trial: Boolean(configuredPlan.is_trial),
      trial_limit_message: configuredPlan.is_trial ? "该试用套餐每个用户仅可领取一次" : null,
    },
  };
}

function resolvePurchaseMode(requestedMode, configuredPlan, context) {
  const normalizedRequestedMode = requestedMode
    ? ensureEnum(requestedMode, "purchase_mode", purchaseModes)
    : null;

  if (normalizedRequestedMode) {
    return normalizedRequestedMode;
  }

  if (
    configuredPlan.is_renewable &&
    context.currentEntitlement &&
    context.currentEntitlement.plan === configuredPlan.code
  ) {
    return "renew";
  }

  return "new";
}

function ensurePurchaseAllowed(configuredPlan, context, purchaseMode, renewalBasePurchase) {
  const violation = derivePurchaseBlockReason(configuredPlan, context, purchaseMode, renewalBasePurchase);
  if (violation) {
    const statusCode = ["ACCOUNT_DISABLED", "APP_MEMBERSHIP_REQUIRED"].includes(violation.reason_code) ? 403 : 409;
    throw createHttpError(statusCode, violation.message, { reason_code: violation.reason_code });
  }
}

async function buildPurchasePreview({ userId, appId, planCode, requestedMode }) {
  const configuredPlan = await getActivePlan(appId, planCode);
  if (!configuredPlan) {
    throw createHttpError(404, "Plan does not exist or is inactive");
  }

  const context = await getPurchaseContext(userId, appId);
  if (!context.user) {
    throw createHttpError(404, "User does not exist");
  }

  const purchaseMode = resolvePurchaseMode(requestedMode, configuredPlan, context);
  const renewalBasePurchase =
    purchaseMode === "renew" &&
    context.latestPurchase &&
    context.latestPurchase.plan === configuredPlan.code &&
    !["failed", "refunded"].includes(context.latestPurchase.status)
      ? context.latestPurchase
      : context.currentEntitlement && context.currentEntitlement.plan === configuredPlan.code
        ? context.currentEntitlement
        : null;

  try {
    ensurePurchaseAllowed(configuredPlan, context, purchaseMode, renewalBasePurchase);
  } catch (error) {
    if (error.statusCode && error.statusCode < 500) {
      return buildPreviewPayload({
        purchaseMode,
        configuredPlan,
        context,
        amount: Number(configuredPlan.price || 0),
        expectedExpiredAt: calculateExpectedExpiry({
          durationDays: configuredPlan.duration_days,
          renewalBasePurchase,
          purchaseMode,
        }),
        allowed: false,
        reason: error.message,
        reasonCode: error.details?.reason_code || null,
      });
    }
    throw error;
  }

  return buildPreviewPayload({
    purchaseMode,
    configuredPlan,
    context,
    amount: Number(configuredPlan.price || 0),
    expectedExpiredAt: calculateExpectedExpiry({
      durationDays: configuredPlan.duration_days,
      renewalBasePurchase,
      purchaseMode,
    }),
  });
}

router.post("/preview", async (req, res, next) => {
  try {
    const userId = ensureRequiredString(req.body.user_id, "user_id", { maxLength: 100 });
    const appId = ensureAppId(req.body.app_id);
    const planCode = ensurePlanCode(req.body.plan, "plan");
    const preview = await buildPurchasePreview({
      userId,
      appId,
      planCode,
      requestedMode: req.body.purchase_mode || null,
    });

    return res.json(preview);
  } catch (error) {
    return next(error);
  }
});

router.post("/create", async (req, res, next) => {
  try {
    const userId = ensureRequiredString(req.body.user_id, "user_id", { maxLength: 100 });
    const appId = ensureAppId(req.body.app_id);
    const plan = ensurePlanCode(req.body.plan, "plan");
    const orderNo = ensureOrderNo(req.body.order_no);
    const preview = await buildPurchasePreview({
      userId,
      appId,
      planCode: plan,
      requestedMode: req.body.purchase_mode || null,
    });
    if (!preview.allowed) {
      throw createHttpError(409, preview.reason || "Purchase is not allowed");
    }

    const amount =
      req.body.amount == null || req.body.amount === ""
        ? Number(preview.plan.price || 0)
        : ensureMoneyAmount(req.body.amount);
    const expiredAt = req.body.expired_at
      ? ensureDateInput(req.body.expired_at, "expired_at")
      : preview.pricing.expected_expired_at;
    const paymentMethod = ensureOptionalString(req.body.payment_method, { maxLength: 50 });
    const status = ensureRequiredString(req.body.status || "paid", "status", { maxLength: 20 });
    if (!purchaseStatuses.includes(status)) {
      throw createHttpError(400, `status must be one of: ${purchaseStatuses.join(", ")}`);
    }

    const result = await query(
      `
        INSERT INTO purchases (
          user_id,
          app_id,
          plan,
          purchase_mode,
          order_no,
          amount,
          expired_at,
          payment_method,
          status,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        ON CONFLICT (order_no)
        DO UPDATE SET
          plan = EXCLUDED.plan,
          purchase_mode = EXCLUDED.purchase_mode,
          amount = EXCLUDED.amount,
          expired_at = EXCLUDED.expired_at,
          payment_method = EXCLUDED.payment_method,
          status = EXCLUDED.status,
          updated_at = NOW()
        RETURNING *
      `,
      [
        userId,
        appId,
        plan,
        preview.purchase_mode,
        orderNo,
        amount,
        expiredAt || null,
        paymentMethod || null,
        status,
      ]
    );

    await logPurchaseEvent({
      orderNo,
      userId,
      appId,
      eventType: "order_created",
      eventSource: "purchase_api",
      toStatus: status,
      details: {
        plan,
        purchase_mode: preview.purchase_mode,
        amount,
        payment_method: paymentMethod || null,
      },
    });

    return res.status(201).json({
      success: true,
      purchase_mode: preview.purchase_mode,
      purchase: {
        ...result.rows[0],
        amount: Number(result.rows[0].amount || 0),
        plan_name: preview.plan.name,
      },
      plan: preview.plan,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/confirm", async (req, res, next) => {
  try {
    const signatureState = verifyPaymentCallbackSignature(req);
    const orderNo = ensureOrderNo(req.body.order_no);
    const status = ensureEnum(req.body.status, "status", purchaseStatuses);
    const paymentMethod = ensureOptionalString(req.body.payment_method, { maxLength: 50 });
    const externalOrderNo = ensureOptionalString(req.body.external_order_no, { maxLength: 120 });
    const amount =
      req.body.amount == null || req.body.amount === ""
        ? null
        : ensureMoneyAmount(req.body.amount);
    const expiredAt = req.body.expired_at ? ensureDateInput(req.body.expired_at, "expired_at") : null;
    const confirmedAt = req.body.confirmed_at ? ensureDateInput(req.body.confirmed_at, "confirmed_at") : null;
    const callbackUrl = ensureOptionalUrl(req.body.callback_url, "callback_url");
    const paymentPayload =
      req.body.payment_payload && typeof req.body.payment_payload === "object"
        ? req.body.payment_payload
        : callbackUrl
          ? { callback_url: callbackUrl }
          : null;

    const existingPurchase = await getPurchaseByOrderNo(orderNo);
    if (!existingPurchase) {
      throw createHttpError(404, "Order does not exist");
    }

    if (!canTransitionPurchaseStatus(existingPurchase.status, status)) {
      throw createHttpError(409, `Cannot transition purchase status from ${existingPurchase.status} to ${status}`);
    }

    const updatedResult = await query(
      `
        UPDATE purchases
        SET amount = COALESCE($2, amount),
            expired_at = COALESCE($3, expired_at),
            payment_method = COALESCE($4, payment_method),
            external_order_no = COALESCE($5, external_order_no),
            confirmed_at = COALESCE($6, confirmed_at, NOW()),
            payment_payload = COALESCE($7::jsonb, payment_payload),
            status = $8,
            updated_at = NOW()
        WHERE order_no = $1
        RETURNING *
      `,
      [
        orderNo,
        amount,
        expiredAt,
        paymentMethod,
        externalOrderNo,
        confirmedAt,
        paymentPayload ? JSON.stringify(paymentPayload) : null,
        status,
      ]
    );

    const purchase = updatedResult.rows[0];
    const context = await getPurchaseContext(purchase.user_id, purchase.app_id);

    await logPurchaseEvent({
      orderNo,
      userId: purchase.user_id,
      appId: purchase.app_id,
      eventType: "payment_confirmed",
      eventSource: signatureState.verified ? "payment_callback" : "manual_confirm",
      fromStatus: existingPurchase.status,
      toStatus: status,
      details: {
        payment_method: paymentMethod || existingPurchase.payment_method || null,
        external_order_no: externalOrderNo || existingPurchase.external_order_no || null,
        signature_verified: signatureState.verified,
        signature_skipped: signatureState.skipped,
        callback_url: callbackUrl || null,
      },
      req,
    });

    return res.json({
      success: true,
      signature: signatureState,
      purchase: serializePurchaseRow({
        ...purchase,
        plan_name: existingPurchase.plan_name,
        is_trial: existingPurchase.is_trial,
        is_renewable: existingPurchase.is_renewable,
      }),
      entitlement: {
        is_active: Boolean(context.currentEntitlement),
        current_plan: serializePurchaseRow(context.currentEntitlement),
        latest_purchase: serializePurchaseRow(context.latestPurchase),
        can_renew: Boolean(context.currentEntitlement?.is_renewable),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/plans", async (req, res, next) => {
  try {
    const appId = ensureAppId(req.query.app_id);
    const result = await query(
      `
        SELECT *
        FROM app_plans
        WHERE app_id = $1
          AND status = 'active'
          AND COALESCE(is_visible, true) = true
        ORDER BY sort_order ASC, created_at ASC
      `,
      [appId]
    );

    return res.json({
      items: result.rows.map((row) => ({
        ...serializePlanRow(row),
        ui_hints: {
          trial_limit_message: row.is_trial ? "该试用套餐每个用户仅可领取一次" : null,
        },
      })),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/orders/:order_no", async (req, res, next) => {
  try {
    const orderNo = ensureOrderNo(req.params.order_no);
    const [purchase, events] = await Promise.all([getDetailedPurchaseByOrderNo(orderNo), listPurchaseEvents(orderNo)]);

    if (!purchase) {
      throw createHttpError(404, "Order does not exist");
    }

    const context = await getPurchaseContext(purchase.user_id, purchase.app_id);

    return res.json({
      purchase: serializePurchaseRow(purchase),
      events,
      entitlement: {
        is_active: Boolean(context.currentEntitlement),
        current_plan: serializePurchaseRow(context.currentEntitlement),
        latest_purchase: serializePurchaseRow(context.latestPurchase),
        can_renew: Boolean(context.currentEntitlement?.is_renewable),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/orders", async (req, res, next) => {
  try {
    const userId = ensureRequiredString(req.query.user_id, "user_id", { maxLength: 100 });
    const appId = req.query.app_id ? ensureAppId(req.query.app_id) : null;
    const status = req.query.status
      ? ensureEnum(req.query.status, "status", purchaseStatuses)
      : null;
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    const params = [userId];
    const conditions = ["p.user_id = $1"];

    if (appId) {
      params.push(appId);
      conditions.push(`p.app_id = $${params.length}`);
    }

    if (status) {
      params.push(status);
      conditions.push(`p.status = $${params.length}`);
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;
    params.push(limit);
    params.push(offset);

    const [itemsResult, totalResult] = await Promise.all([
      query(
        `
          SELECT p.*, plan_config.name AS plan_name, plan_config.is_trial, plan_config.is_renewable
          FROM purchases p
          LEFT JOIN app_plans plan_config
            ON plan_config.app_id = p.app_id
           AND plan_config.code = p.plan
          ${whereClause}
          ORDER BY p.created_at DESC
          LIMIT $${params.length - 1}
          OFFSET $${params.length}
        `,
        params
      ),
      query(
        `
          SELECT COUNT(*) AS total
          FROM purchases p
          ${whereClause}
        `,
        params.slice(0, status ? (appId ? 3 : 2) : appId ? 2 : 1)
      ),
    ]);

    return res.json({
      items: itemsResult.rows.map(serializePurchaseRow),
      pagination: {
        page,
        limit,
        total: Number(totalResult.rows[0]?.total || 0),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/current-plan", async (req, res, next) => {
  try {
    const userId = ensureRequiredString(req.query.user_id, "user_id", { maxLength: 100 });
    const appId = ensureAppId(req.query.app_id);
    const context = await getPurchaseContext(userId, appId);

    if (!context.user) {
      throw createHttpError(404, "User does not exist");
    }

    return res.json({
      app_id: appId,
      user_id: userId,
      account_status: context.user.account_status,
      membership: context.membership
        ? {
            app_id: context.membership.app_id,
            status: context.membership.status,
            register_source: context.membership.register_source,
            created_at: context.membership.created_at,
            last_login_at: context.membership.last_login_at,
          }
        : null,
      entitlement: {
        is_active: Boolean(context.currentEntitlement),
        trial_used: Boolean(context.trialUsed),
        current_plan: serializePurchaseRow(context.currentEntitlement),
        latest_purchase: serializePurchaseRow(context.latestPurchase),
        can_renew: Boolean(context.currentEntitlement?.is_renewable),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/status", async (req, res, next) => {
  try {
    const userId = ensureRequiredString(req.query.user_id, "user_id", { maxLength: 100 });
    const appId = ensureAppId(req.query.app_id);
    const context = await getPurchaseContext(userId, appId);
    const purchase = context.latestPurchase;
    const isActive = Boolean(context.currentEntitlement);

    return res.json({
      is_purchased: isActive,
      purchase: serializePurchaseRow(purchase),
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
