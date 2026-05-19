const express = require("express");
const { pool, query } = require("../config/db");
const { logPurchaseEvent } = require("../services/purchaseEventLog");
const { logUserEvent } = require("../services/userEventLog");
const {
  buildRedeemOrderNo,
  hashRedeemCode,
} = require("../services/redeemCodes");
const {
  ensureAppId,
  ensurePlanCode,
  ensureRedeemCode,
  ensureRequiredString,
} = require("../utils/validation");
const { createHttpError } = require("../utils/http");

const router = express.Router();

function serializePlanRow(row) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    price: Number(row.price || 0),
    original_price: row.original_price == null ? null : Number(row.original_price),
    duration_days: row.duration_days == null ? null : Number(row.duration_days),
    sort_order: Number(row.sort_order || 0),
    is_trial: Boolean(row.is_trial),
    is_renewable: Boolean(row.is_renewable),
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

async function withTransaction(run) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

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

async function getPurchaseContext(userId, appId, db = { query }) {
  const [userResult, membershipResult, latestPurchaseResult, currentEntitlementResult, trialUsageResult] =
    await Promise.all([
      db.query(
        `
          SELECT id, username, phone, email, COALESCE(account_status, 'active') AS account_status
          FROM users
          WHERE id = $1
          LIMIT 1
        `,
        [userId]
      ),
      db.query(
        `
          SELECT *
          FROM user_app_memberships
          WHERE user_id = $1
            AND app_id = $2
          LIMIT 1
        `,
        [userId, appId]
      ),
      db.query(
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
      db.query(
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
      db.query(
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

async function getRedeemCodeRecord(code, db = { query }, { lock = false } = {}) {
  const codeHash = hashRedeemCode(code);
  const lockClause = lock ? "FOR UPDATE OF rc" : "";
  const result = await db.query(
    `
      SELECT
        rc.*,
        batch.batch_no,
        batch.channel,
        batch.valid_from,
        batch.valid_until,
        batch.status AS batch_status,
        app_plan.name AS plan_name,
        app_plan.duration_days,
        app_plan.is_trial,
        app_plan.is_renewable,
        app_plan.price,
        app_plan.original_price,
        app_plan.currency,
        app_plan.features,
        app_plan.status AS plan_status
      FROM redeem_codes rc
      JOIN redeem_code_batches batch ON batch.id = rc.batch_id
      LEFT JOIN app_plans app_plan
        ON app_plan.app_id = rc.app_id
       AND app_plan.code = rc.plan_code
      WHERE rc.code_hash = $1
      LIMIT 1
      ${lockClause}
    `,
    [codeHash]
  );

  return result.rows[0] || null;
}

function buildRedeemPreviewPayload({
  redeemCode,
  context,
  allowed = true,
  reason = null,
  reasonCode = null,
  expectedExpiredAt = null,
}) {
  return {
    allowed,
    reason,
    reason_code: reasonCode,
    message: reason,
    code: {
      batch_no: redeemCode.batch_no,
      code_preview: redeemCode.code_preview,
      channel: redeemCode.channel || null,
      valid_from: redeemCode.valid_from || null,
      valid_until: redeemCode.valid_until || null,
      status: redeemCode.status,
    },
    plan: serializePlanRow({
      app_id: redeemCode.app_id,
      code: redeemCode.plan_code,
      name: redeemCode.plan_name,
      duration_days: redeemCode.duration_days,
      is_trial: redeemCode.is_trial,
      is_renewable: redeemCode.is_renewable,
      price: redeemCode.price,
      original_price: redeemCode.original_price,
      currency: redeemCode.currency,
      features: redeemCode.features,
      status: redeemCode.plan_status,
    }),
    current_plan: serializePurchaseRow(context.currentEntitlement),
    latest_purchase: serializePurchaseRow(context.latestPurchase),
    entitlement: {
      is_active: Boolean(context.currentEntitlement),
      trial_used: Boolean(context.trialUsed),
    },
    pricing: {
      amount: 0,
      currency: redeemCode.currency || "CNY",
      expected_expired_at: expectedExpiredAt,
    },
    ui_hints: {
      is_trial: Boolean(redeemCode.is_trial),
      trial_limit_message: redeemCode.is_trial ? "该试用套餐每个用户仅可领取一次" : null,
      redemption_message: "核销成功后会自动生成一条已支付购买记录，并立即更新当前权益。",
    },
  };
}

function calculateExpectedExpiredAt({ durationDays, currentEntitlement }) {
  if (!durationDays) {
    return null;
  }

  const now = Date.now();
  let baseTime = now;
  if (currentEntitlement?.expired_at) {
    baseTime = Math.max(baseTime, new Date(currentEntitlement.expired_at).getTime());
  }
  return new Date(baseTime + Number(durationDays) * 24 * 60 * 60 * 1000).toISOString();
}

function deriveRedeemViolation(redeemCode, context) {
  if (!context.user) {
    return {
      status: 404,
      code: "USER_NOT_FOUND",
      message: "User does not exist",
    };
  }

  if (context.user.account_status !== "active") {
    return {
      status: 403,
      code: "ACCOUNT_DISABLED",
      message: "This account has been disabled",
    };
  }

  if (!context.membership || context.membership.status !== "active") {
    return {
      status: 403,
      code: "APP_MEMBERSHIP_REQUIRED",
      message: "This account has not been registered in the target app",
    };
  }

  if (redeemCode.app_id !== context.membership.app_id) {
    return {
      status: 409,
      code: "REDEEM_APP_MISMATCH",
      message: "This redeem code does not belong to the current app",
    };
  }

  if (redeemCode.batch_status !== "active") {
    return {
      status: 409,
      code: "REDEEM_BATCH_DISABLED",
      message: "This redeem code batch has been disabled",
    };
  }

  if (redeemCode.plan_status !== "active") {
    return {
      status: 409,
      code: "PLAN_DISABLED",
      message: "The target plan is no longer active",
    };
  }

  if (redeemCode.status === "redeemed") {
    return {
      status: 409,
      code: "REDEEM_CODE_ALREADY_USED",
      message: "This redeem code has already been used",
    };
  }

  if (redeemCode.status === "disabled") {
    return {
      status: 409,
      code: "REDEEM_CODE_DISABLED",
      message: "This redeem code has been disabled",
    };
  }

  const now = Date.now();
  if (redeemCode.valid_from && new Date(redeemCode.valid_from).getTime() > now) {
    return {
      status: 409,
      code: "REDEEM_CODE_NOT_STARTED",
      message: "This redeem code is not active yet",
    };
  }

  if (redeemCode.valid_until && new Date(redeemCode.valid_until).getTime() < now) {
    return {
      status: 409,
      code: "REDEEM_CODE_EXPIRED",
      message: "This redeem code has expired",
    };
  }

  if (redeemCode.is_trial && context.trialUsed) {
    return {
      status: 409,
      code: "TRIAL_ALREADY_USED",
      message: "Trial plan has already been used in this app",
    };
  }

  if (!redeemCode.duration_days && context.currentEntitlement?.plan === redeemCode.plan_code && !context.currentEntitlement?.expired_at) {
    return {
      status: 409,
      code: "LIFETIME_PLAN_ALREADY_ACTIVE",
      message: "A lifetime entitlement for this plan is already active",
    };
  }

  return null;
}

router.post("/preview", async (req, res, next) => {
  try {
    const userId = ensureRequiredString(req.body.user_id, "user_id", { maxLength: 100 });
    const appId = ensureAppId(req.body.app_id);
    const code = ensureRedeemCode(req.body.code, "code");

    await ensureApplicationExists(appId);
    const redeemCode = await getRedeemCodeRecord(code);
    if (!redeemCode) {
      throw createHttpError(404, "Redeem code does not exist", { reason_code: "REDEEM_CODE_NOT_FOUND" });
    }

    const context = await getPurchaseContext(userId, appId);
    const violation = deriveRedeemViolation(redeemCode, context);
    const expectedExpiredAt = calculateExpectedExpiredAt({
      durationDays: redeemCode.duration_days,
      currentEntitlement: context.currentEntitlement,
    });

    if (violation) {
      return res.status(violation.status).json(
        buildRedeemPreviewPayload({
          redeemCode,
          context,
          allowed: false,
          reason: violation.message,
          reasonCode: violation.code,
          expectedExpiredAt,
        })
      );
    }

    return res.json(
      buildRedeemPreviewPayload({
        redeemCode,
        context,
        expectedExpiredAt,
      })
    );
  } catch (error) {
    return next(error);
  }
});

router.post("/claim", async (req, res, next) => {
  try {
    const userId = ensureRequiredString(req.body.user_id, "user_id", { maxLength: 100 });
    const appId = ensureAppId(req.body.app_id);
    const code = ensureRedeemCode(req.body.code, "code");

    await ensureApplicationExists(appId);
    const orderNo = buildRedeemOrderNo();

    const transactionResult = await withTransaction(async (client) => {
      const redeemCode = await getRedeemCodeRecord(code, client, { lock: true });
      if (!redeemCode) {
        throw createHttpError(404, "Redeem code does not exist", { reason_code: "REDEEM_CODE_NOT_FOUND" });
      }

      const context = await getPurchaseContext(userId, appId, client);
      const violation = deriveRedeemViolation(redeemCode, context);
      if (violation) {
        throw createHttpError(violation.status, violation.message, { reason_code: violation.code });
      }

      const expiredAt = calculateExpectedExpiredAt({
        durationDays: redeemCode.duration_days,
        currentEntitlement: context.currentEntitlement,
      });

      const purchaseResult = await client.query(
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
            external_order_no,
            confirmed_at,
            payment_payload,
            status,
            updated_at
          )
          VALUES ($1, $2, $3, 'new', $4, 0, $5, 'redeem_code', $6, NOW(), $7::jsonb, 'paid', NOW())
          RETURNING *
        `,
        [
          userId,
          appId,
          ensurePlanCode(redeemCode.plan_code, "plan_code"),
          orderNo,
          expiredAt,
          redeemCode.code_preview,
          JSON.stringify({
            source: "redeem_code",
            batch_no: redeemCode.batch_no,
            channel: redeemCode.channel || null,
            code_preview: redeemCode.code_preview,
          }),
        ]
      );

      const purchase = purchaseResult.rows[0];

      await client.query(
        `
          UPDATE redeem_codes
          SET status = 'redeemed',
              redeemed_by_user_id = $2,
              redeemed_at = NOW(),
              purchase_id = $3,
              external_order_no = $4
          WHERE id = $1
        `,
        [redeemCode.id, userId, purchase.id, orderNo]
      );

      await client.query(
        `
          INSERT INTO redeem_events (
            code_id,
            batch_id,
            event_type,
            operator_id,
            user_id,
            payload,
            created_at
          )
          VALUES ($1, $2, 'redeemed', $3, $3, $4::jsonb, NOW())
        `,
        [
          redeemCode.id,
          redeemCode.batch_id,
          userId,
          JSON.stringify({
            app_id: appId,
            plan_code: redeemCode.plan_code,
            batch_no: redeemCode.batch_no,
            order_no: orderNo,
            code_preview: redeemCode.code_preview,
          }),
        ]
      );

      return {
        redeemCode,
        purchase,
      };
    });

    await logPurchaseEvent({
      orderNo,
      userId,
      appId,
      eventType: "order_created",
      eventSource: "redeem_code",
      toStatus: "paid",
      details: {
        plan: transactionResult.redeemCode.plan_code,
        purchase_mode: "new",
        amount: 0,
        code_preview: transactionResult.redeemCode.code_preview,
        batch_no: transactionResult.redeemCode.batch_no,
        channel: transactionResult.redeemCode.channel || null,
      },
    });

    await logUserEvent({
      userId,
      appId,
      eventType: "redeem_code_claimed",
      eventSource: "redeem_code",
      actorMode: "user",
      actorId: userId,
      details: {
        order_no: orderNo,
        code_preview: transactionResult.redeemCode.code_preview,
        batch_no: transactionResult.redeemCode.batch_no,
        plan_code: transactionResult.redeemCode.plan_code,
      },
    });

    const context = await getPurchaseContext(userId, appId);

    return res.status(201).json({
      success: true,
      purchase: serializePurchaseRow(transactionResult.purchase),
      entitlement: {
        is_active: Boolean(context.currentEntitlement),
        current_plan: serializePurchaseRow(context.currentEntitlement),
        latest_purchase: serializePurchaseRow(context.latestPurchase),
        trial_used: Boolean(context.trialUsed),
      },
      code: {
        batch_no: transactionResult.redeemCode.batch_no,
        code_preview: transactionResult.redeemCode.code_preview,
      },
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
