const express = require("express");
const fs = require("fs");
const { pool, query } = require("../config/db");
const { logAdminAction } = require("../services/auditLog");
const { syncUser } = require("../services/userSync");
const { createCasdoorUser, updateCasdoorUser } = require("../services/casdoorIdentity");
const { createDefaultLandingDraftFile } = require("../services/landingDraft");
const { buildSdkMarkdown, buildSdkExportFileName } = require("../services/sdkDocs");
const { logUserEvent } = require("../services/userEventLog");
const { logPurchaseEvent } = require("../services/purchaseEventLog");
const { generateBatchNo, generateRedeemCode, hashRedeemCode, buildCodePreview } = require("../services/redeemCodes");
const { purchaseStatuses, canTransitionPurchaseStatus } = require("../services/purchaseLifecycle");
const {
  ensureAppId,
  ensureDateInput,
  ensureDateOnly,
  ensureEnum,
  ensureMoneyAmount,
  ensureOptionalEmail,
  ensureOptionalString,
  ensureOrderNo,
  ensurePassword,
  ensurePlanCode,
  ensurePositiveInteger,
  ensurePhone,
  ensureRequiredString,
  ensureRedeemCode,
  ensureSlug,
  escapeCsvValue,
  parsePagination,
} = require("../utils/validation");
const { createHttpError } = require("../utils/http");

const router = express.Router();
const userStatuses = ["free", "paid", "expired"];
const membershipStatuses = ["active", "blocked", "invited"];
const applicationTypes = ["android", "ios", "web", "desktop", "saas", "miniapp", "service", "backend"];
const applicationStatuses = ["active", "disabled"];
const planStatuses = ["active", "disabled"];
const redeemBatchComputedStatuses = ["scheduled", "active", "disabled", "expired"];
const redeemCodeComputedStatuses = ["scheduled", "unused", "redeemed", "disabled", "expired"];
const redeemBatchSortOptions = {
  created_at_desc: "created_at DESC, id DESC",
  created_at_asc: "created_at ASC, id ASC",
  redeemed_count_desc: "redeemed_count DESC, id DESC",
  redeemed_count_asc: "redeemed_count ASC, id ASC",
  redeem_rate_desc: "redeem_rate DESC, id DESC",
  redeem_rate_asc: "redeem_rate ASC, id ASC",
  valid_until_asc: "COALESCE(valid_until, TIMESTAMP '9999-12-31 00:00:00') ASC, id DESC",
  valid_until_desc: "COALESCE(valid_until, TIMESTAMP '1970-01-01 00:00:00') DESC, id DESC",
};

function serializeRedeemBatchRow(row) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    quantity: Number(row.quantity || 0),
    total_codes: Number(row.total_codes || 0),
    redeemed_count: Number(row.redeemed_count || 0),
    disabled_count: Number(row.disabled_count || 0),
    expired_count: Number(row.expired_count || 0),
    scheduled_count: Number(row.scheduled_count || 0),
    unused_count: Number(row.unused_count || 0),
    redeem_rate: Number(row.redeem_rate || 0),
  };
}

function serializeRedeemCodeRow(row) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    amount: row.amount == null ? null : Number(row.amount),
  };
}

function serializeRedeemOverviewRow(row) {
  if (!row) {
    return null;
  }
  return {
    total_batches: Number(row.total_batches || 0),
    total_codes: Number(row.total_codes || 0),
    redeemed_count: Number(row.redeemed_count || 0),
    disabled_count: Number(row.disabled_count || 0),
    expired_count: Number(row.expired_count || 0),
    scheduled_count: Number(row.scheduled_count || 0),
    unused_count: Number(row.unused_count || 0),
    redeem_rate: Number(row.redeem_rate || 0),
  };
}

function serializeRedeemChannelRow(row) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    batch_count: Number(row.batch_count || 0),
    total_codes: Number(row.total_codes || 0),
    redeemed_count: Number(row.redeemed_count || 0),
    disabled_count: Number(row.disabled_count || 0),
    expired_count: Number(row.expired_count || 0),
    scheduled_count: Number(row.scheduled_count || 0),
    unused_count: Number(row.unused_count || 0),
    redeem_rate: Number(row.redeem_rate || 0),
  };
}

function serializeRedeemEventRow(row) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    payload: row.payload && typeof row.payload === "object" ? row.payload : row.payload || null,
  };
}

function serializeVerificationCodeRow(row) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    attempt_count: Number(row.attempt_count || 0),
  };
}

function getAdminOperatorId(req) {
  return req.admin?.user?.sub || req.currentUser?.sub || req.admin?.user?.username || req.currentUser?.username || "admin";
}

function buildNormalizedChannelSql(alias = "batch") {
  return `COALESCE(NULLIF(BTRIM(${alias}.channel), ''), '未填写渠道')`;
}

function buildRedeemBatchComputedStatusSql(batchAlias = "batch") {
  return `
    CASE
      WHEN ${batchAlias}.status = 'disabled' THEN 'disabled'
      WHEN ${batchAlias}.valid_from IS NOT NULL AND ${batchAlias}.valid_from > NOW() THEN 'scheduled'
      WHEN ${batchAlias}.valid_until IS NOT NULL AND ${batchAlias}.valid_until < NOW() THEN 'expired'
      ELSE 'active'
    END
  `;
}

function buildRedeemCodeComputedStatusSql(codeAlias = "rc", batchAlias = "batch") {
  return `
    CASE
      WHEN ${codeAlias}.status = 'redeemed' THEN 'redeemed'
      WHEN ${codeAlias}.status = 'disabled' OR ${batchAlias}.status = 'disabled' THEN 'disabled'
      WHEN ${batchAlias}.valid_from IS NOT NULL AND ${batchAlias}.valid_from > NOW() THEN 'scheduled'
      WHEN ${batchAlias}.valid_until IS NOT NULL AND ${batchAlias}.valid_until < NOW() THEN 'expired'
      ELSE 'unused'
    END
  `;
}

function deriveRedeemBatchComputedStatus(row) {
  if (!row) {
    return "active";
  }
  if (row.status === "disabled") {
    return "disabled";
  }
  const now = Date.now();
  if (row.valid_from && new Date(row.valid_from).getTime() > now) {
    return "scheduled";
  }
  if (row.valid_until && new Date(row.valid_until).getTime() < now) {
    return "expired";
  }
  return "active";
}

function deriveRedeemCodeComputedStatus(row) {
  if (!row) {
    return "unused";
  }
  if (row.status === "redeemed") {
    return "redeemed";
  }
  if (row.status === "disabled" || row.batch_status === "disabled") {
    return "disabled";
  }
  const now = Date.now();
  if (row.valid_from && new Date(row.valid_from).getTime() > now) {
    return "scheduled";
  }
  if (row.valid_until && new Date(row.valid_until).getTime() < now) {
    return "expired";
  }
  return "unused";
}

function appendDateOnlyRangeConditions(conditions, params, fieldSql, fromValue, toValue) {
  if (fromValue) {
    params.push(fromValue);
    conditions.push(`${fieldSql} >= $${params.length}::date`);
  }
  if (toValue) {
    params.push(toValue);
    conditions.push(`${fieldSql} < ($${params.length}::date + INTERVAL '1 day')`);
  }
}

function parseRedeemBatchFilters(queryParams, { includeSort = false } = {}) {
  const computedStatusRaw = queryParams.computed_status || queryParams.status || "";
  const sort = includeSort
    ? queryParams.sort
      ? ensureEnum(queryParams.sort, "sort", Object.keys(redeemBatchSortOptions))
      : "created_at_desc"
    : "created_at_desc";

  return {
    appId: queryParams.app_id ? ensureAppId(queryParams.app_id) : "",
    planCode: queryParams.plan_code ? ensurePlanCode(queryParams.plan_code, "plan_code") : "",
    channel: ensureOptionalString(queryParams.channel, { maxLength: 100, defaultValue: "" }),
    search: ensureOptionalString(queryParams.search, { maxLength: 100, defaultValue: "" }),
    createdFrom: queryParams.created_from ? ensureDateOnly(queryParams.created_from, "created_from") : "",
    createdTo: queryParams.created_to ? ensureDateOnly(queryParams.created_to, "created_to") : "",
    validFrom: queryParams.valid_from ? ensureDateOnly(queryParams.valid_from, "valid_from") : "",
    validTo: queryParams.valid_to ? ensureDateOnly(queryParams.valid_to, "valid_to") : "",
    computedStatus: computedStatusRaw
      ? ensureEnum(computedStatusRaw, "computed_status", redeemBatchComputedStatuses)
      : "",
    sort,
  };
}

function buildRedeemBatchDatasetCte(filters, { includeSearch = true } = {}) {
  const params = [];
  const conditions = [];

  if (filters.appId) {
    params.push(filters.appId);
    conditions.push(`batch.app_id = $${params.length}`);
  }
  if (filters.planCode) {
    params.push(filters.planCode);
    conditions.push(`batch.plan_code = $${params.length}`);
  }
  if (filters.channel) {
    params.push(filters.channel);
    conditions.push(`${buildNormalizedChannelSql("batch")} = $${params.length}`);
  }

  appendDateOnlyRangeConditions(conditions, params, "batch.created_at", filters.createdFrom, filters.createdTo);
  appendDateOnlyRangeConditions(conditions, params, "batch.valid_from", filters.validFrom, filters.validTo);

  if (includeSearch && filters.search) {
    params.push(`%${filters.search}%`);
    conditions.push(
      `(batch.batch_no ILIKE $${params.length} OR ${buildNormalizedChannelSql("batch")} ILIKE $${params.length} OR app.name ILIKE $${params.length} OR COALESCE(plan.name, '') ILIKE $${params.length} OR batch.plan_code ILIKE $${params.length})`
    );
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return {
    params,
    cteSql: `
      WITH redeem_batch_rows AS (
        SELECT
          batch.*,
          app.name AS app_name,
          plan.name AS plan_name,
          plan.duration_days,
          plan.is_trial,
          plan.is_renewable,
          ${buildNormalizedChannelSql("batch")} AS channel_label,
          COALESCE(code_summary.total_codes, 0) AS total_codes,
          COALESCE(code_summary.redeemed_count, 0) AS redeemed_count,
          COALESCE(code_summary.disabled_count, 0) AS disabled_count,
          COALESCE(code_summary.expired_count, 0) AS expired_count,
          COALESCE(code_summary.scheduled_count, 0) AS scheduled_count,
          COALESCE(code_summary.unused_count, 0) AS unused_count,
          code_summary.last_redeemed_at,
          ${buildRedeemBatchComputedStatusSql("batch")} AS computed_status,
          CASE
            WHEN COALESCE(code_summary.total_codes, 0) > 0
              THEN ROUND(COALESCE(code_summary.redeemed_count, 0) * 100.0 / code_summary.total_codes, 2)
            ELSE 0
          END AS redeem_rate
        FROM redeem_code_batches batch
        JOIN applications app ON app.id = batch.app_id
        LEFT JOIN app_plans plan
          ON plan.app_id = batch.app_id
         AND plan.code = batch.plan_code
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) AS total_codes,
            COUNT(*) FILTER (WHERE ${buildRedeemCodeComputedStatusSql("rc", "batch")} = 'redeemed') AS redeemed_count,
            COUNT(*) FILTER (WHERE ${buildRedeemCodeComputedStatusSql("rc", "batch")} = 'disabled') AS disabled_count,
            COUNT(*) FILTER (WHERE ${buildRedeemCodeComputedStatusSql("rc", "batch")} = 'expired') AS expired_count,
            COUNT(*) FILTER (WHERE ${buildRedeemCodeComputedStatusSql("rc", "batch")} = 'scheduled') AS scheduled_count,
            COUNT(*) FILTER (WHERE ${buildRedeemCodeComputedStatusSql("rc", "batch")} = 'unused') AS unused_count,
            MAX(rc.redeemed_at) AS last_redeemed_at
          FROM redeem_codes rc
          WHERE rc.batch_id = batch.id
        ) code_summary ON true
        ${whereClause}
      )
    `,
  };
}

function appendRedeemBatchComputedStatusFilter(filters, params, conditions) {
  if (filters.computedStatus) {
    params.push(filters.computedStatus);
    conditions.push(`computed_status = $${params.length}`);
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
    throw createHttpError(404, "Application not found");
  }

  return application;
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

function serializeApplicationRow(row) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    paid_users: Number(row.paid_users || 0),
    registered_users: Number(row.registered_users || 0),
    revenue: Number(row.revenue || 0),
    release_count: Number(row.release_count || 0),
    landing_published: Boolean(row.landing_published),
    release_types: Array.isArray(row.release_types) ? row.release_types.filter(Boolean) : [],
  };
}

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
    purchase_count: Number(row.purchase_count || 0),
  };
}

function ensureOptionalInteger(value, fieldName, { min = 0, defaultValue = null } = {}) {
  if (value == null || value === "") {
    return defaultValue;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < min) {
    throw createHttpError(400, `${fieldName} must be an integer greater than or equal to ${min}`);
  }
  return number;
}

function ensurePlanFeatures(value) {
  if (value == null || value === "") {
    return [];
  }
  if (!Array.isArray(value)) {
    throw createHttpError(400, "features must be an array");
  }
  return value
    .map((item) => ensureOptionalString(item, { maxLength: 120, defaultValue: "" }))
    .filter(Boolean)
    .slice(0, 20);
}

async function getApplicationDetail(appId) {
  const result = await query(
    `
      SELECT
        a.*,
        COALESCE(membership_summary.registered_users, 0) AS registered_users,
        COALESCE(purchase_summary.paid_users, 0) AS paid_users,
        COALESCE(purchase_summary.revenue, 0) AS revenue,
        COALESCE(release_summary.release_count, 0) AS release_count,
        release_summary.release_updated_at,
        COALESCE(release_summary.release_types, ARRAY[]::varchar[]) AS release_types,
        landing_summary.landing_slug,
        landing_summary.landing_updated_at,
        landing_summary.draft_updated_at,
        landing_summary.published_at,
        COALESCE(landing_summary.landing_published, false) AS landing_published
      FROM applications a
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS registered_users
        FROM user_app_memberships
        WHERE app_id = a.id AND status = 'active'
      ) membership_summary ON true
      LEFT JOIN LATERAL (
        SELECT
          COUNT(DISTINCT user_id) FILTER (WHERE status = 'paid') AS paid_users,
          COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) AS revenue
        FROM purchases
        WHERE app_id = a.id
      ) purchase_summary ON true
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) AS release_count,
          MAX(updated_at) AS release_updated_at,
          ARRAY_AGG(type ORDER BY type) AS release_types
        FROM app_releases
        WHERE app_id = a.id
      ) release_summary ON true
      LEFT JOIN LATERAL (
        SELECT
          slug AS landing_slug,
          updated_at AS landing_updated_at,
          draft_updated_at,
          published_at,
          is_published AS landing_published
        FROM landing_pages
        WHERE app_id = a.id
        LIMIT 1
      ) landing_summary ON true
      WHERE a.id = $1
      LIMIT 1
    `,
    [appId]
  );

  const row = result.rows[0];
  if (!row) {
    throw createHttpError(404, "Application not found");
  }
  return serializeApplicationRow(row);
}

function formatPagination(page, limit, total) {
  return {
    page,
    limit,
    total,
    total_pages: Math.max(1, Math.ceil(total / limit)),
  };
}

const dashboardRanges = ["today", "7d", "30d", "90d", "custom"];

function startOfLocalDay(value = new Date()) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(value, days) {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}

function formatLocalDateInput(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseDashboardWindow(queryParams) {
  let range = queryParams.range ? ensureEnum(queryParams.range, "range", dashboardRanges) : "7d";
  const dateFrom = queryParams.date_from ? ensureDateOnly(queryParams.date_from, "date_from") : "";
  const dateTo = queryParams.date_to ? ensureDateOnly(queryParams.date_to, "date_to") : "";

  const todayStart = startOfLocalDay(new Date());
  let start = null;
  let endExclusive = null;

  if (range === "custom" && dateFrom && dateTo) {
    start = new Date(`${dateFrom}T00:00:00`);
    endExclusive = addDays(new Date(`${dateTo}T00:00:00`), 1);
    if (start.getTime() >= endExclusive.getTime()) {
      throw createHttpError(400, "date_to must be greater than or equal to date_from");
    }
  } else if (range === "custom") {
    range = "7d";
  }

  if (!start || !endExclusive) {
    if (range === "today") {
      start = todayStart;
      endExclusive = addDays(todayStart, 1);
    } else if (range === "30d") {
      start = addDays(todayStart, -29);
      endExclusive = addDays(todayStart, 1);
    } else if (range === "90d") {
      start = addDays(todayStart, -89);
      endExclusive = addDays(todayStart, 1);
    } else {
      start = addDays(todayStart, -6);
      endExclusive = addDays(todayStart, 1);
      range = "7d";
    }
  }

  const durationDays = Math.max(1, Math.round((endExclusive.getTime() - start.getTime()) / 86400000));
  const previousStart = addDays(start, -durationDays);
  const previousEndExclusive = start;

  return {
    range,
    dateFrom: range === "custom" ? formatLocalDateInput(start) : dateFrom,
    dateTo: range === "custom" ? formatLocalDateInput(addDays(endExclusive, -1)) : dateTo,
    start,
    endExclusive,
    previousStart,
    previousEndExclusive,
    durationDays,
  };
}

function buildDeltaPayload(currentValue, previousValue) {
  const current = Number(currentValue || 0);
  const previous = Number(previousValue || 0);

  if (previous === 0) {
    return {
      current,
      previous,
      delta_percent: current === 0 ? 0 : 100,
      direction: current === 0 ? "flat" : "up",
    };
  }

  const deltaPercent = Number((((current - previous) / Math.abs(previous)) * 100).toFixed(1));
  return {
    current,
    previous,
    delta_percent: deltaPercent,
    direction: deltaPercent > 0 ? "up" : deltaPercent < 0 ? "down" : "flat",
  };
}

router.get("/dashboard", async (req, res, next) => {
  try {
    const window = parseDashboardWindow(req.query);
    const dashboardRevenueTarget = process.env.DASHBOARD_REVENUE_TARGET
      ? Number(process.env.DASHBOARD_REVENUE_TARGET)
      : null;
    const currentRangeParams = [window.start.toISOString(), window.endExclusive.toISOString()];
    const previousRangeParams = [window.previousStart.toISOString(), window.previousEndExclusive.toISOString()];

    const [
      currentSummaryResult,
      previousSummaryResult,
      totalUsersResult,
      previousTotalUsersResult,
      growthResult,
      growthByAppResult,
      distributionResult,
      revenueByAppResult,
      pendingOrdersResult,
      failedOrdersResult,
      unpublishedLandingsResult,
      expiringBatchesResult,
      recentUserActivityResult,
      recentPurchaseActivityResult,
      recentLogActivityResult,
      recentRedeemActivityResult,
      smsFailureResult,
      paid24hResult,
      newUsers24hResult,
      expiredRedeemAlertResult,
    ] = await Promise.all([
      query(
        `
          SELECT
            (SELECT COUNT(*) FROM users WHERE created_at >= $1::timestamp AND created_at < $2::timestamp) AS new_users,
            (
              SELECT COALESCE(SUM(amount), 0)
              FROM purchases
              WHERE status = 'paid'
                AND created_at >= $1::timestamp
                AND created_at < $2::timestamp
            ) AS total_revenue,
            (
              SELECT COUNT(*)
              FROM devices
              WHERE COALESCE(is_active, true) = true
                AND last_login >= $1::timestamp
                AND last_login < $2::timestamp
            ) AS active_devices
        `
        ,
        currentRangeParams
      ),
      query(
        `
          SELECT
            (SELECT COUNT(*) FROM users WHERE created_at >= $1::timestamp AND created_at < $2::timestamp) AS new_users,
            (
              SELECT COALESCE(SUM(amount), 0)
              FROM purchases
              WHERE status = 'paid'
                AND created_at >= $1::timestamp
                AND created_at < $2::timestamp
            ) AS total_revenue,
            (
              SELECT COUNT(*)
              FROM devices
              WHERE COALESCE(is_active, true) = true
                AND last_login >= $1::timestamp
                AND last_login < $2::timestamp
            ) AS active_devices
        `
        ,
        previousRangeParams
      ),
      query(
        `SELECT COUNT(*) AS total_users FROM users`
      ),
      query(
        `
          SELECT COUNT(*) AS total_users
          FROM users
          WHERE created_at < $1::timestamp
        `,
        [window.start.toISOString()]
      ),
      query(
        `
          WITH date_series AS (
            SELECT generate_series($1::date, ($2::timestamp - INTERVAL '1 day')::date, INTERVAL '1 day')::date AS day
          )
          SELECT
            ds.day::text AS date,
            COALESCE(COUNT(u.id), 0) AS count
          FROM date_series ds
          LEFT JOIN users u
            ON u.created_at::date = ds.day
          GROUP BY ds.day
          ORDER BY ds.day ASC
        `,
        currentRangeParams
      ),
      query(
        `
          WITH date_series AS (
            SELECT generate_series($1::date, ($2::timestamp - INTERVAL '1 day')::date, INTERVAL '1 day')::date AS day
          )
          SELECT
            ds.day::text AS date,
            a.id AS app_id,
            a.name AS app_name,
            COALESCE(COUNT(m.id), 0) AS count
          FROM date_series ds
          CROSS JOIN applications a
          LEFT JOIN user_app_memberships m
            ON m.app_id = a.id
           AND m.status = 'active'
           AND m.created_at::date = ds.day
          GROUP BY ds.day, a.id, a.name
          ORDER BY ds.day ASC, a.created_at ASC
        `,
        currentRangeParams
      ),
      query(
        `
          SELECT
            a.id AS app_id,
            a.name,
            COALESCE(registration_summary.registered_users, 0) AS registered_users,
            COALESCE(purchase_summary.paid_users, 0) AS paid_users
          FROM applications a
          LEFT JOIN LATERAL (
            SELECT COUNT(DISTINCT user_id) AS registered_users
            FROM user_app_memberships
            WHERE app_id = a.id
              AND status = 'active'
              AND created_at >= $1::timestamp
              AND created_at < $2::timestamp
          ) registration_summary ON true
          LEFT JOIN LATERAL (
            SELECT COUNT(DISTINCT user_id) AS paid_users
            FROM purchases
            WHERE app_id = a.id
              AND status = 'paid'
              AND created_at >= $1::timestamp
              AND created_at < $2::timestamp
          ) purchase_summary ON true
          ORDER BY registered_users DESC, a.created_at ASC
        `,
        currentRangeParams
      ),
      query(
        `
          SELECT
            a.id AS app_id,
            a.name,
            COALESCE(SUM(p.amount) FILTER (
              WHERE p.status = 'paid'
                AND p.created_at >= $1::timestamp
                AND p.created_at < $2::timestamp
            ), 0) AS revenue,
            COUNT(*) FILTER (
              WHERE p.status = 'paid'
                AND p.created_at >= $1::timestamp
                AND p.created_at < $2::timestamp
            ) AS paid_orders,
            COUNT(DISTINCT p.user_id) FILTER (
              WHERE p.status = 'paid'
                AND p.created_at >= $1::timestamp
                AND p.created_at < $2::timestamp
            ) AS paid_users
          FROM applications a
          LEFT JOIN purchases p ON p.app_id = a.id
          GROUP BY a.id, a.name, a.created_at
          ORDER BY revenue DESC, a.created_at ASC
        `,
        currentRangeParams
      ),
      query(
        `
          SELECT COUNT(*) AS count, MAX(created_at) AS latest_at
          FROM purchases
          WHERE status = 'pending'
        `
      ),
      query(
        `
          SELECT COUNT(*) AS count, MAX(created_at) AS latest_at
          FROM purchases
          WHERE status = 'failed'
        `
      ),
      query(
        `
          SELECT COUNT(*) AS count, MAX(COALESCE(draft_updated_at, updated_at)) AS latest_at
          FROM landing_pages
          WHERE COALESCE(is_published, false) = false
            AND (draft_html_path IS NOT NULL OR html_path IS NOT NULL)
        `
      ),
      query(
        `
          WITH expiring_batches AS (
            ${buildRedeemBatchDatasetCte({}).cteSql}
            SELECT *
            FROM redeem_batch_rows
            WHERE computed_status = 'active'
              AND valid_until IS NOT NULL
              AND valid_until >= NOW()
              AND valid_until < NOW() + INTERVAL '3 days'
              AND COALESCE(unused_count, 0) > 0
          )
          SELECT COUNT(*) AS count, MAX(valid_until) AS latest_at
          FROM expiring_batches
        `
      ),
      query(
        `
          SELECT ue.*, u.username
          FROM user_events ue
          LEFT JOIN users u ON u.id = ue.user_id
          ORDER BY ue.created_at DESC, ue.id DESC
          LIMIT 8
        `
      ),
      query(
        `
          SELECT pe.*, p.amount, p.plan, p.order_no, u.username
          FROM purchase_events pe
          LEFT JOIN purchases p ON p.order_no = pe.order_no
          LEFT JOIN users u ON u.id = COALESCE(pe.user_id, p.user_id)
          ORDER BY pe.created_at DESC, pe.id DESC
          LIMIT 8
        `
      ),
      query(
        `
          SELECT *
          FROM operation_logs
          ORDER BY created_at DESC, id DESC
          LIMIT 8
        `
      ),
      query(
        `
          SELECT
            re.*,
            batch.batch_no,
            batch.app_id,
            batch.plan_code,
            rc.code_preview
          FROM redeem_events re
          LEFT JOIN redeem_code_batches batch ON batch.id = re.batch_id
          LEFT JOIN redeem_codes rc ON rc.id = re.code_id
          ORDER BY re.created_at DESC, re.id DESC
          LIMIT 8
        `
      ),
      query(
        `
          SELECT COUNT(*) AS failed_count, MAX(created_at) AS latest_at
          FROM verification_codes
          WHERE send_status = 'failed'
            AND created_at >= NOW() - INTERVAL '24 hours'
        `
      ),
      query(
        `
          SELECT COUNT(*) AS paid_count, MAX(created_at) AS latest_at
          FROM purchases
          WHERE status = 'paid'
            AND created_at >= NOW() - INTERVAL '24 hours'
        `
      ),
      query(
        `
          SELECT COUNT(*) AS new_user_count, MAX(created_at) AS latest_at
          FROM users
          WHERE created_at >= NOW() - INTERVAL '24 hours'
        `
      ),
      query(
        `
          WITH expired_batches AS (
            ${buildRedeemBatchDatasetCte({}).cteSql}
            SELECT *
            FROM redeem_batch_rows
            WHERE computed_status = 'expired'
              AND status <> 'disabled'
              AND COALESCE(unused_count, 0) > 0
          )
          SELECT COUNT(*) AS count, MAX(valid_until) AS latest_at
          FROM expired_batches
        `
      ),
    ]);

    const currentSummary = currentSummaryResult.rows[0] || {};
    const previousSummary = previousSummaryResult.rows[0] || {};
    const totalUsers = Number(totalUsersResult.rows[0]?.total_users || 0);
    const previousTotalUsers = Number(previousTotalUsersResult.rows[0]?.total_users || 0);
    const growthPoints = growthResult.rows.map((row) => ({
      date: row.date,
      count: Number(row.count || 0),
    }));
    const growthByAppMap = new Map();
    for (const row of growthByAppResult.rows) {
      if (!growthByAppMap.has(row.app_id)) {
        growthByAppMap.set(row.app_id, {
          app_id: row.app_id,
          name: row.app_name,
          points: [],
        });
      }
      growthByAppMap.get(row.app_id).points.push({
        date: row.date,
        count: Number(row.count || 0),
      });
    }

    const distributionApps = distributionResult.rows.map((row) => ({
      app_id: row.app_id,
      name: row.name,
      registered_users: Number(row.registered_users || 0),
      paid_users: Number(row.paid_users || 0),
    }));
    const totalRegisteredUsers = distributionApps.reduce((sum, item) => sum + item.registered_users, 0);
    const totalPaidUsers = distributionApps.reduce((sum, item) => sum + item.paid_users, 0);

    const revenueByApp = revenueByAppResult.rows.map((row) => ({
      app_id: row.app_id,
      name: row.name,
      revenue: Number(row.revenue || 0),
      paid_orders: Number(row.paid_orders || 0),
      paid_users: Number(row.paid_users || 0),
    }));
    const revenueTotal = revenueByApp.reduce((sum, item) => sum + item.revenue, 0);

    const todos = {
      pending_orders: {
        count: Number(pendingOrdersResult.rows[0]?.count || 0),
        latest_at: pendingOrdersResult.rows[0]?.latest_at || null,
        action_link: {
          route: "orders",
          filters: {
            status: "pending",
          },
        },
      },
      failed_orders: {
        count: Number(failedOrdersResult.rows[0]?.count || 0),
        latest_at: failedOrdersResult.rows[0]?.latest_at || null,
        action_link: {
          route: "orders",
          filters: {
            status: "failed",
          },
        },
      },
      unpublished_landings: {
        count: Number(unpublishedLandingsResult.rows[0]?.count || 0),
        latest_at: unpublishedLandingsResult.rows[0]?.latest_at || null,
        action_link: {
          route: "landing",
        },
      },
      expiring_redeem_batches: {
        count: Number(expiringBatchesResult.rows[0]?.count || 0),
        latest_at: expiringBatchesResult.rows[0]?.latest_at || null,
        action_link: {
          route: "redeem",
          filters: {
            status: "active",
          },
        },
      },
    };

    const alerts = [];
    if (Number(newUsers24hResult.rows[0]?.new_user_count || 0) === 0) {
      alerts.push({
        level: "warning",
        code: "no_new_users_24h",
        title: "近 24 小时没有新增用户",
        subtitle: "请检查注册链路、落地页转化和短信发送状态",
        created_at: new Date().toISOString(),
        action_link: {
          route: "users",
          filters: {
            registeredRange: "today",
          },
        },
      });
    }
    if (Number(paid24hResult.rows[0]?.paid_count || 0) === 0) {
      alerts.push({
        level: "warning",
        code: "no_paid_orders_24h",
        title: "近 24 小时没有支付成功订单",
        subtitle: "请检查支付链路、订单创建和支付确认流程",
        created_at: new Date().toISOString(),
        action_link: {
          route: "orders",
          filters: {
            status: "paid",
            dateFrom: formatLocalDateInput(addDays(new Date(), -1)),
            dateTo: formatLocalDateInput(new Date()),
          },
        },
      });
    }
    if (Number(smsFailureResult.rows[0]?.failed_count || 0) > 0) {
      alerts.push({
        level: "danger",
        code: "sms_failures_24h",
        title: `最近 24 小时短信发送失败 ${Number(smsFailureResult.rows[0]?.failed_count || 0)} 次`,
        subtitle: "请检查短信模板、供应商凭证和验证码发送链路",
        created_at: smsFailureResult.rows[0]?.latest_at || new Date().toISOString(),
        action_link: {
          route: "sms",
          filters: {
            sendStatus: "failed",
            createdFrom: formatLocalDateInput(addDays(new Date(), -1)),
            createdTo: formatLocalDateInput(new Date()),
          },
        },
      });
    }
    if (Number(expiredRedeemAlertResult.rows[0]?.count || 0) > 0) {
      alerts.push({
        level: "warning",
        code: "expired_redeem_batches",
        title: `存在 ${Number(expiredRedeemAlertResult.rows[0]?.count || 0)} 个已过期兑换码批次`,
        subtitle: "这些批次仍有未使用兑换码，建议尽快核查并停用",
        created_at: expiredRedeemAlertResult.rows[0]?.latest_at || new Date().toISOString(),
        action_link: {
          route: "redeem",
          filters: {
            status: "expired",
          },
        },
      });
    }

    const activityItems = [];
    for (const event of recentUserActivityResult.rows) {
      activityItems.push({
        type: "user_event",
        title:
          event.event_type === "account_created"
            ? `${event.username || event.user_id || "用户"} 创建了统一账号`
            : event.event_type === "membership_registered"
            ? `${event.username || event.user_id || "用户"} 注册了 ${event.app_id || "应用"}`
            : event.event_type === "login_password"
            ? `${event.username || event.user_id || "用户"} 完成密码登录`
            : `${event.username || event.user_id || "用户"} 发生了用户事件`,
        subtitle: event.app_id ? `应用 ${event.app_id} · ${event.event_type}` : event.event_type,
        created_at: event.created_at,
        target_type: "user",
        target_id: event.user_id,
        action_link: {
          route: "users",
          filters: {
            search: event.user_id || event.username || "",
          },
        },
      });
    }
    for (const event of recentPurchaseActivityResult.rows) {
      activityItems.push({
        type: "purchase_event",
        title:
          event.event_type === "payment_confirmed"
            ? `订单 ${event.order_no} 支付成功`
            : event.event_type === "order_created"
            ? `订单 ${event.order_no} 已创建`
            : `订单 ${event.order_no} 更新为 ${event.to_status || event.event_type}`,
        subtitle: `${event.username || "未知用户"} · ${event.app_id || "未知应用"}${event.amount != null ? ` · ¥${Number(event.amount).toFixed(2)}` : ""}`,
        created_at: event.created_at,
        target_type: "purchase",
        target_id: event.order_no,
        action_link: {
          route: "orders",
          order_no: event.order_no,
        },
      });
    }
    for (const event of recentLogActivityResult.rows) {
      const details = event.details && typeof event.details === "object" ? event.details : {};
      let route = "logs";
      if (event.target_type === "landing_page") route = "landing";
      if (event.target_type === "release") route = "builds";
      if (event.target_type === "purchase") route = "orders";
      if (event.target_type === "redeem_batch" || event.target_type === "redeem_code") route = "redeem";
      activityItems.push({
        type: "operation_log",
        title: `${event.actor_id || event.actor_name || "管理员"} ${event.action}`,
        subtitle: event.target_type
          ? `${event.target_type} · ${details.app_id || details.batch_no || details.slug || event.target_id || ""}`
          : "后台操作",
        created_at: event.created_at,
        target_type: event.target_type,
        target_id: event.target_id,
        action_link: {
          route,
          order_no: event.target_type === "purchase" ? event.target_id : null,
          batch_id: event.target_type === "redeem_batch" ? event.target_id : null,
          filters: route === "logs" ? { targetType: event.target_type || "" } : null,
        },
      });
    }
    for (const event of recentRedeemActivityResult.rows) {
      activityItems.push({
        type: "redeem_event",
        title:
          event.event_type === "redeemed"
            ? `兑换码批次 ${event.batch_no || event.batch_id} 已核销`
            : event.event_type === "exported"
            ? `兑换码批次 ${event.batch_no || event.batch_id} 已导出`
            : `兑换码批次 ${event.batch_no || event.batch_id} ${event.event_type}`,
        subtitle: `${event.app_id || "未知应用"} · ${event.plan_code || "未知套餐"}${event.code_preview ? ` · ${event.code_preview}` : ""}`,
        created_at: event.created_at,
        target_type: "redeem_batch",
        target_id: event.batch_id,
        action_link: {
          route: "redeem",
          batch_id: event.batch_id,
        },
      });
    }

    activityItems.sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime());

    return res.json({
      summary: {
        total_users: totalUsers,
        new_users: Number(currentSummary.new_users || 0),
        total_revenue: Number(currentSummary.total_revenue || 0),
        active_devices: Number(currentSummary.active_devices || 0),
        deltas: {
          total_users: buildDeltaPayload(totalUsers, previousTotalUsers),
          new_users: buildDeltaPayload(currentSummary.new_users, previousSummary.new_users),
          total_revenue: buildDeltaPayload(currentSummary.total_revenue, previousSummary.total_revenue),
          active_devices: buildDeltaPayload(currentSummary.active_devices, previousSummary.active_devices),
        },
      },
      user_growth: {
        range: window.range,
        date_from: formatLocalDateInput(window.start),
        date_to: formatLocalDateInput(addDays(window.endExclusive, -1)),
        points: growthPoints,
        by_app: Array.from(growthByAppMap.values()),
      },
      distribution: {
        basis: "registered_users",
        total_registered_users: totalRegisteredUsers,
        total_paid_users: totalPaidUsers,
        apps: distributionApps,
      },
      revenue: {
        total: revenueTotal,
        target: Number.isFinite(dashboardRevenueTarget) ? dashboardRevenueTarget : null,
        progress:
          Number.isFinite(dashboardRevenueTarget) && dashboardRevenueTarget > 0
            ? Number(((revenueTotal / dashboardRevenueTarget) * 100).toFixed(1))
            : null,
        by_app: revenueByApp,
      },
      todos,
      alerts: {
        items: alerts,
      },
      activities: {
        items: activityItems.slice(0, 20),
      },
      filters: {
        range: window.range,
        date_from: formatLocalDateInput(window.start),
        date_to: formatLocalDateInput(addDays(window.endExclusive, -1)),
        previous_date_from: formatLocalDateInput(window.previousStart),
        previous_date_to: formatLocalDateInput(addDays(window.previousEndExclusive, -1)),
      },
      total_users: totalUsers,
      new_users_today: Number(currentSummary.new_users || 0),
      total_revenue: revenueTotal,
      active_devices: Number(currentSummary.active_devices || 0),
      revenue_by_app: revenueByApp.map((item) => ({
        app_id: item.app_id,
        name: item.name,
        revenue: item.revenue,
        paid_users: item.paid_users,
      })),
      user_growth_30d: growthPoints,
      recent_orders: [],
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/users", async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 10, maxLimit: 100 });
    const search = ensureOptionalString(req.query.search, { maxLength: 100, defaultValue: "" });
    const appId = req.query.app_id ? ensureAppId(req.query.app_id) : "";
    const status = req.query.status ? ensureEnum(req.query.status, "status", userStatuses) : "";
    const registeredRange = ensureOptionalString(req.query.registered_range, { maxLength: 20, defaultValue: "" });
    const activeRange = req.query.active_range
      ? ensureEnum(req.query.active_range, "active_range", ["24h", "7d", "30d"])
      : "";
    const createdFrom = ensureDateInput(req.query.created_from, "created_from");
    const createdTo = ensureDateInput(req.query.created_to, "created_to");

    const params = [];
    const conditions = [];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(
        `(u.id ILIKE $${params.length} OR u.username ILIKE $${params.length} OR COALESCE(u.phone, '') ILIKE $${params.length} OR COALESCE(u.email, '') ILIKE $${params.length})`
      );
    }

    if (appId) {
      params.push(appId);
      conditions.push(
        `(
          EXISTS (
            SELECT 1
            FROM user_app_memberships um
            WHERE um.user_id = u.id
              AND um.app_id = $${params.length}
              AND um.status = 'active'
          )
          OR EXISTS (
            SELECT 1
            FROM purchases px
            WHERE px.user_id = u.id
              AND px.app_id = $${params.length}
          )
        )`
      );
    }

    if (status === "paid") {
      conditions.push(
        `EXISTS (
          SELECT 1 FROM purchases ps
          WHERE ps.user_id = u.id
            AND ps.status = 'paid'
            AND (ps.expired_at IS NULL OR ps.expired_at > NOW())
        )`
      );
    } else if (status === "expired") {
      conditions.push(
        `EXISTS (
          SELECT 1 FROM purchases ps
          WHERE ps.user_id = u.id
            AND ps.status = 'paid'
            AND ps.expired_at <= NOW()
        )`
      );
    } else if (status === "free") {
      conditions.push(
        `NOT EXISTS (
          SELECT 1 FROM purchases ps
          WHERE ps.user_id = u.id
            AND ps.status = 'paid'
        )`
      );
    }

    if (registeredRange === "today") {
      conditions.push(`u.created_at::date = CURRENT_DATE`);
    } else if (registeredRange === "7d") {
      conditions.push(`u.created_at >= NOW() - INTERVAL '7 days'`);
    } else if (registeredRange === "30d") {
      conditions.push(`u.created_at >= NOW() - INTERVAL '30 days'`);
    }

    if (activeRange === "24h") {
      conditions.push(`u.last_login >= NOW() - INTERVAL '24 hours'`);
    } else if (activeRange === "7d") {
      conditions.push(`u.last_login >= NOW() - INTERVAL '7 days'`);
    } else if (activeRange === "30d") {
      conditions.push(`u.last_login >= NOW() - INTERVAL '30 days'`);
    }

    if (createdFrom) {
      params.push(createdFrom);
      conditions.push(`u.created_at >= $${params.length}::timestamp`);
    }

    if (createdTo) {
      params.push(createdTo);
      conditions.push(`u.created_at <= $${params.length}::timestamp`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const totalParams = [...params];
    const listParams = [...params, limit, offset];

    const [countResult, listResult] = await Promise.all([
      query(
        `
          SELECT COUNT(*) AS total
          FROM users u
          ${whereClause}
        `,
        totalParams
      ),
      query(
        `
          SELECT
            u.id,
            u.username,
            u.phone,
            u.email,
            COALESCE(u.account_status, 'active') AS account_status,
            u.created_at,
            u.last_login,
            COALESCE(purchase_summary.total_spend, 0) AS total_spend,
            COALESCE(device_summary.devices_count, 0) AS devices_count,
            COALESCE(purchase_summary.products, ARRAY[]::VARCHAR[]) AS products,
            COALESCE(membership_summary.registered_apps, ARRAY[]::VARCHAR[]) AS registered_apps,
            purchase_summary.derived_status,
            purchase_summary.latest_plan
          FROM users u
          LEFT JOIN LATERAL (
            SELECT
              COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) AS total_spend,
              ARRAY_REMOVE(ARRAY_AGG(DISTINCT app_id), NULL) AS products,
              MAX(
                CASE
                  WHEN status = 'paid' AND (expired_at IS NULL OR expired_at > NOW()) THEN 'paid'
                  WHEN status = 'paid' AND expired_at <= NOW() THEN 'expired'
                  ELSE NULL
                END
              ) AS derived_status,
              MAX(plan) FILTER (WHERE status = 'paid') AS latest_plan
            FROM purchases
            WHERE user_id = u.id
          ) purchase_summary ON true
          LEFT JOIN LATERAL (
            SELECT COUNT(*) AS devices_count
            FROM devices
            WHERE user_id = u.id
          ) device_summary ON true
          LEFT JOIN LATERAL (
            SELECT ARRAY_REMOVE(ARRAY_AGG(DISTINCT app_id), NULL) AS registered_apps
            FROM user_app_memberships
            WHERE user_id = u.id
              AND status = 'active'
          ) membership_summary ON true
          ${whereClause}
          ORDER BY u.created_at DESC
          LIMIT $${params.length + 1}
          OFFSET $${params.length + 2}
        `,
        listParams
      ),
    ]);

    const items = listResult.rows.map((row) => ({
      id: row.id,
      username: row.username,
      phone: row.phone,
      email: row.email,
      account_status: row.account_status || "active",
      created_at: row.created_at,
      last_login: row.last_login,
      total_spend: Number(row.total_spend),
      devices_count: Number(row.devices_count),
      products: row.products || [],
      registered_apps: row.registered_apps || [],
      status: row.derived_status || "free",
      plan: row.latest_plan || null,
    }));

    return res.json({
      items,
      pagination: formatPagination(page, limit, Number(countResult.rows[0].total)),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/users/export", async (req, res, next) => {
  try {
    const search = ensureOptionalString(req.query.search, { maxLength: 100, defaultValue: "" });
    const appId = req.query.app_id ? ensureAppId(req.query.app_id) : "";
    const status = req.query.status ? ensureEnum(req.query.status, "status", userStatuses) : "";
    const registeredRange = ensureOptionalString(req.query.registered_range, { maxLength: 20, defaultValue: "" });
    const activeRange = req.query.active_range
      ? ensureEnum(req.query.active_range, "active_range", ["24h", "7d", "30d"])
      : "";
    const createdFrom = ensureDateInput(req.query.created_from, "created_from");
    const createdTo = ensureDateInput(req.query.created_to, "created_to");

    const params = [];
    const conditions = [];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(
        `(u.id ILIKE $${params.length} OR u.username ILIKE $${params.length} OR COALESCE(u.phone, '') ILIKE $${params.length} OR COALESCE(u.email, '') ILIKE $${params.length})`
      );
    }

    if (appId) {
      params.push(appId);
      conditions.push(
        `(
          EXISTS (
            SELECT 1
            FROM user_app_memberships um
            WHERE um.user_id = u.id
              AND um.app_id = $${params.length}
              AND um.status = 'active'
          )
          OR EXISTS (
            SELECT 1
            FROM purchases px
            WHERE px.user_id = u.id
              AND px.app_id = $${params.length}
          )
        )`
      );
    }

    if (status === "paid") {
      conditions.push(
        `EXISTS (
          SELECT 1 FROM purchases ps
          WHERE ps.user_id = u.id
            AND ps.status = 'paid'
            AND (ps.expired_at IS NULL OR ps.expired_at > NOW())
        )`
      );
    } else if (status === "expired") {
      conditions.push(
        `EXISTS (
          SELECT 1 FROM purchases ps
          WHERE ps.user_id = u.id
            AND ps.status = 'paid'
            AND ps.expired_at <= NOW()
        )`
      );
    } else if (status === "free") {
      conditions.push(
        `NOT EXISTS (
          SELECT 1 FROM purchases ps
          WHERE ps.user_id = u.id
            AND ps.status = 'paid'
        )`
      );
    }

    if (registeredRange === "today") {
      conditions.push(`u.created_at::date = CURRENT_DATE`);
    } else if (registeredRange === "7d") {
      conditions.push(`u.created_at >= NOW() - INTERVAL '7 days'`);
    } else if (registeredRange === "30d") {
      conditions.push(`u.created_at >= NOW() - INTERVAL '30 days'`);
    }

    if (activeRange === "24h") {
      conditions.push(`u.last_login >= NOW() - INTERVAL '24 hours'`);
    } else if (activeRange === "7d") {
      conditions.push(`u.last_login >= NOW() - INTERVAL '7 days'`);
    } else if (activeRange === "30d") {
      conditions.push(`u.last_login >= NOW() - INTERVAL '30 days'`);
    }

    if (createdFrom) {
      params.push(createdFrom);
      conditions.push(`u.created_at >= $${params.length}::timestamp`);
    }

    if (createdTo) {
      params.push(createdTo);
      conditions.push(`u.created_at <= $${params.length}::timestamp`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await query(
      `
        SELECT
          u.id,
          u.username,
          u.phone,
          u.email,
          COALESCE(u.account_status, 'active') AS account_status,
          u.created_at,
          u.last_login,
          COALESCE(purchase_summary.total_spend, 0) AS total_spend,
          COALESCE(device_summary.devices_count, 0) AS devices_count,
          COALESCE(purchase_summary.products, ARRAY[]::VARCHAR[]) AS products,
          COALESCE(membership_summary.registered_apps, ARRAY[]::VARCHAR[]) AS registered_apps,
          COALESCE(purchase_summary.derived_status, 'free') AS user_status,
          purchase_summary.latest_plan
        FROM users u
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) AS total_spend,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT app_id), NULL) AS products,
            MAX(
              CASE
                WHEN status = 'paid' AND (expired_at IS NULL OR expired_at > NOW()) THEN 'paid'
                WHEN status = 'paid' AND expired_at <= NOW() THEN 'expired'
                ELSE NULL
              END
            ) AS derived_status,
            MAX(plan) FILTER (WHERE status = 'paid') AS latest_plan
          FROM purchases
          WHERE user_id = u.id
        ) purchase_summary ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS devices_count
          FROM devices
          WHERE user_id = u.id
        ) device_summary ON true
        LEFT JOIN LATERAL (
          SELECT ARRAY_REMOVE(ARRAY_AGG(DISTINCT app_id), NULL) AS registered_apps
          FROM user_app_memberships
          WHERE user_id = u.id
            AND status = 'active'
        ) membership_summary ON true
        ${whereClause}
        ORDER BY u.created_at DESC
      `,
      params
    );

    const lines = [
      [
        "user_id",
        "username",
        "phone",
        "email",
        "account_status",
        "created_at",
        "last_login",
        "status",
        "registered_apps",
        "products",
        "devices_count",
        "total_spend",
        "latest_plan",
      ].join(","),
      ...result.rows.map((row) =>
        [
          row.id,
          row.username,
          row.phone,
          row.email,
          row.account_status,
          row.created_at?.toISOString?.() || row.created_at,
          row.last_login?.toISOString?.() || row.last_login || "",
          row.user_status,
          (row.registered_apps || []).join("|"),
          (row.products || []).join("|"),
          Number(row.devices_count || 0),
          Number(row.total_spend || 0),
          row.latest_plan || "",
        ]
          .map(escapeCsvValue)
          .join(",")
      ),
    ];

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="users-export.csv"');
    return res.send(lines.join("\n"));
  } catch (error) {
    return next(error);
  }
});

router.post("/users", async (req, res, next) => {
  try {
    const appId = ensureAppId(req.body?.app_id);
    const phone = ensurePhone(req.body?.phone);
    const password = ensurePassword(req.body?.password);
    const displayName = ensureOptionalString(req.body?.display_name, {
      maxLength: 100,
      defaultValue: phone,
    });

    const application = await ensureApplicationExists(appId);
    if (application.status !== "active") {
      throw createHttpError(403, "Application is not active");
    }

    const existingUserResult = await query(
      `
        SELECT *
        FROM users
        WHERE phone = $1
        LIMIT 1
      `,
      [phone]
    );

    let localUser = existingUserResult.rows[0] || null;
    let accountExisted = Boolean(localUser);

    if (!localUser) {
      const casdoorUser = await createCasdoorUser({
        phone,
        password,
        displayName,
      });

      localUser = await syncUser({
        sub: casdoorUser.id,
        username: casdoorUser.name,
        phone: casdoorUser.phone || phone,
        email: casdoorUser.email || null,
        picture: casdoorUser.avatar || null,
        roles: Array.isArray(casdoorUser.roles) ? casdoorUser.roles : [],
        isAdmin: Boolean(casdoorUser.isAdmin),
        isGlobalAdmin: false,
      });

      await logUserEvent({
        userId: localUser.id,
        appId,
        eventType: "account_created",
        eventSource: "admin_panel",
        req,
        details: {
          phone: localUser.phone,
        },
      });
    }

    const membershipResult = await query(
      `
        INSERT INTO user_app_memberships (user_id, app_id, status, register_source, created_at)
        VALUES ($1, $2, 'active', 'admin_panel', NOW())
        ON CONFLICT (user_id, app_id)
        DO UPDATE SET
          status = 'active',
          register_source = 'admin_panel'
        RETURNING *
      `,
      [localUser.id, appId]
    );

    await logAdminAction(req, {
      action: accountExisted ? "user_membership_granted" : "user_created",
      targetType: "user",
      targetId: localUser.id,
      details: {
        username: localUser.username,
        phone: localUser.phone,
        app_id: appId,
        app_name: application.name,
        account_existed: accountExisted,
      },
    });

    await logUserEvent({
      userId: localUser.id,
      appId,
      eventType: accountExisted ? "membership_granted" : "membership_registered",
      eventSource: "admin_panel",
      req,
      details: {
        app_name: application.name,
        account_existed: accountExisted,
      },
    });

    return res.status(accountExisted ? 200 : 201).json({
      success: true,
      account_existed: accountExisted,
      user: {
        id: localUser.id,
        username: localUser.username,
        phone: localUser.phone,
        email: localUser.email,
      },
      membership: membershipResult.rows[0],
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/users/:user_id/profile", async (req, res, next) => {
  try {
    const userId = ensureRequiredString(req.params.user_id, "user_id", { maxLength: 100 });
    const username = ensureOptionalString(req.body?.username, { maxLength: 100, defaultValue: null });
    const email = ensureOptionalEmail(req.body?.email);

    const userResult = await query("SELECT * FROM users WHERE id = $1 LIMIT 1", [userId]);
    const localUser = userResult.rows[0];

    if (!localUser) {
      return res.status(404).json({ error: "User not found" });
    }

    const updatedCasdoorUser = await updateCasdoorUser({
      currentUsername: localUser.username,
      username: username || localUser.username,
      email,
    });

    const updatedLocalResult = await query(
      `
        UPDATE users
        SET username = $2,
            email = $3
        WHERE id = $1
        RETURNING *
      `,
      [userId, updatedCasdoorUser.name || username || localUser.username, updatedCasdoorUser.email || email || null]
    );

    await logAdminAction(req, {
      action: "user_profile_updated",
      targetType: "user",
      targetId: userId,
      details: {
        previous_username: localUser.username,
        current_username: updatedLocalResult.rows[0].username,
        previous_email: localUser.email,
        current_email: updatedLocalResult.rows[0].email,
      },
    });

    await logUserEvent({
      userId,
      eventType: "profile_updated",
      eventSource: "admin_panel",
      req,
      details: {
        username: updatedLocalResult.rows[0].username,
        email: updatedLocalResult.rows[0].email,
      },
    });

    return res.json({
      user: updatedLocalResult.rows[0],
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/users/:user_id/reset-password", async (req, res, next) => {
  try {
    const userId = ensureRequiredString(req.params.user_id, "user_id", { maxLength: 100 });
    const password = ensurePassword(req.body?.password);

    const userResult = await query("SELECT * FROM users WHERE id = $1 LIMIT 1", [userId]);
    const localUser = userResult.rows[0];

    if (!localUser) {
      return res.status(404).json({ error: "User not found" });
    }

    await updateCasdoorUser({
      currentUsername: localUser.username,
      password,
    });

    await logAdminAction(req, {
      action: "user_password_reset",
      targetType: "user",
      targetId: userId,
      details: {
        username: localUser.username,
      },
    });

    await logUserEvent({
      userId,
      eventType: "password_reset",
      eventSource: "admin_panel",
      req,
      details: {
        reset_by: req.admin?.user?.username || null,
      },
    });

    return res.json({
      success: true,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/users/:user_id/account-status", async (req, res, next) => {
  try {
    const userId = ensureRequiredString(req.params.user_id, "user_id", { maxLength: 100 });
    const status = ensureEnum(req.body?.status, "status", ["active", "disabled"]);

    const userResult = await query("SELECT * FROM users WHERE id = $1 LIMIT 1", [userId]);
    const localUser = userResult.rows[0];

    if (!localUser) {
      return res.status(404).json({ error: "User not found" });
    }

    const updatedResult = await query(
      `
        UPDATE users
        SET account_status = $2
        WHERE id = $1
        RETURNING *
      `,
      [userId, status]
    );

    await logAdminAction(req, {
      action: "user_account_status_updated",
      targetType: "user",
      targetId: userId,
      details: {
        username: localUser.username,
        previous_status: localUser.account_status || "active",
        current_status: status,
      },
    });

    await logUserEvent({
      userId,
      eventType: "account_status_updated",
      eventSource: "admin_panel",
      req,
      details: {
        previous_status: localUser.account_status || "active",
        current_status: status,
      },
    });

    return res.json({
      user: updatedResult.rows[0],
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/users/:user_id", async (req, res, next) => {
  try {
    const userId = ensureRequiredString(req.params.user_id, "user_id", { maxLength: 100 });

    const [userResult, purchasesResult, devicesResult, membershipsResult, userEventsResult] = await Promise.all([
      query("SELECT * FROM users WHERE id = $1 LIMIT 1", [userId]),
      query(
        `
          SELECT p.*, plan_config.name AS plan_name
          FROM purchases p
          LEFT JOIN app_plans plan_config
            ON plan_config.app_id = p.app_id
           AND plan_config.code = p.plan
          WHERE p.user_id = $1
          ORDER BY p.created_at DESC
        `,
        [userId]
      ),
      query(
        `
          SELECT *
          FROM devices
          WHERE user_id = $1
          ORDER BY last_login DESC
        `,
        [userId]
      ),
      query(
        `
          SELECT *
          FROM user_app_memberships
          WHERE user_id = $1
          ORDER BY created_at ASC
        `,
        [userId]
      ),
      query(
        `
          SELECT *
          FROM user_events
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 100
        `,
        [userId]
      ),
    ]);

    const user = userResult.rows[0];

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const purchaseEvents = purchasesResult.rows.map((purchase) => ({
      type: "purchase",
      app_id: purchase.app_id,
      source: "purchase",
      created_at: purchase.created_at,
      details: {
        plan_name: purchase.plan_name || null,
        plan: purchase.plan,
        amount: Number(purchase.amount || 0),
        order_no: purchase.order_no,
        status: purchase.status,
      },
    }));

    const userEvents = userEventsResult.rows.map((event) => ({
      type: event.event_type,
      app_id: event.app_id,
      source: event.event_source,
      actor_mode: event.actor_mode,
      actor_name: event.actor_name,
      created_at: event.created_at,
      details: event.details || {},
    }));

    const events = [...userEvents, ...purchaseEvents].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    return res.json({
      user,
      purchases: purchasesResult.rows,
      devices: devicesResult.rows,
      memberships: membershipsResult.rows,
      events,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/users/:user_id/memberships", async (req, res, next) => {
  try {
    const userId = ensureRequiredString(req.params.user_id, "user_id", { maxLength: 100 });
    const appId = ensureAppId(req.body?.app_id);
    const status = req.body?.status
      ? ensureEnum(req.body.status, "status", membershipStatuses)
      : "active";

    const [userResult, appResult, existingResult] = await Promise.all([
      query("SELECT id, username FROM users WHERE id = $1 LIMIT 1", [userId]),
      query("SELECT id, name FROM applications WHERE id = $1 LIMIT 1", [appId]),
      query(
        `
          SELECT *
          FROM user_app_memberships
          WHERE user_id = $1 AND app_id = $2
          LIMIT 1
        `,
        [userId, appId]
      ),
    ]);

    if (!userResult.rows[0]) {
      return res.status(404).json({ error: "User not found" });
    }

    if (!appResult.rows[0]) {
      return res.status(404).json({ error: "Application not found" });
    }

    const previousMembership = existingResult.rows[0] || null;
    const membershipResult = await query(
      `
        INSERT INTO user_app_memberships (
          user_id,
          app_id,
          status,
          register_source
        )
        VALUES ($1, $2, $3, 'admin_panel')
        ON CONFLICT (user_id, app_id)
        DO UPDATE SET status = EXCLUDED.status
        RETURNING *
      `,
      [userId, appId, status]
    );

    await logAdminAction(req, {
      action: previousMembership ? "membership_updated" : "membership_granted",
      targetType: "user_membership",
      targetId: `${userId}:${appId}`,
      details: {
        user_id: userId,
        username: userResult.rows[0].username,
        app_id: appId,
        app_name: appResult.rows[0].name,
        previous_status: previousMembership?.status || null,
        current_status: status,
      },
    });

    await logUserEvent({
      userId,
      appId,
      eventType: previousMembership ? "membership_updated" : "membership_granted",
      eventSource: "admin_panel",
      req,
      details: {
        previous_status: previousMembership?.status || null,
        current_status: status,
      },
    });

    return res.status(previousMembership ? 200 : 201).json({
      item: membershipResult.rows[0],
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/users/:user_id/memberships/:app_id/status", async (req, res, next) => {
  try {
    const userId = ensureRequiredString(req.params.user_id, "user_id", { maxLength: 100 });
    const appId = ensureAppId(req.params.app_id);
    const status = ensureEnum(req.body?.status, "status", membershipStatuses);

    const [userResult, appResult, membershipResult] = await Promise.all([
      query("SELECT id, username FROM users WHERE id = $1 LIMIT 1", [userId]),
      query("SELECT id, name FROM applications WHERE id = $1 LIMIT 1", [appId]),
      query(
        `
          SELECT *
          FROM user_app_memberships
          WHERE user_id = $1 AND app_id = $2
          LIMIT 1
        `,
        [userId, appId]
      ),
    ]);

    if (!userResult.rows[0]) {
      return res.status(404).json({ error: "User not found" });
    }

    if (!appResult.rows[0]) {
      return res.status(404).json({ error: "Application not found" });
    }

    const previousMembership = membershipResult.rows[0];
    if (!previousMembership) {
      return res.status(404).json({ error: "Membership not found" });
    }

    const updatedResult = await query(
      `
        UPDATE user_app_memberships
        SET status = $3
        WHERE user_id = $1
          AND app_id = $2
        RETURNING *
      `,
      [userId, appId, status]
    );

    await logAdminAction(req, {
      action: "membership_status_updated",
      targetType: "user_membership",
      targetId: `${userId}:${appId}`,
      details: {
        user_id: userId,
        username: userResult.rows[0].username,
        app_id: appId,
        app_name: appResult.rows[0].name,
        previous_status: previousMembership.status,
        current_status: status,
      },
    });

    await logUserEvent({
      userId,
      appId,
      eventType: "membership_status_updated",
      eventSource: "admin_panel",
      req,
      details: {
        previous_status: previousMembership.status,
        current_status: status,
      },
    });

    return res.json({
      item: updatedResult.rows[0],
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/purchases", async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 12, maxLimit: 100 });
    const appId = req.query.app_id ? ensureAppId(req.query.app_id) : "";
    const dateFrom = ensureDateOnly(req.query.date_from, "date_from");
    const dateTo = ensureDateOnly(req.query.date_to, "date_to");
    const search = ensureOptionalString(req.query.search, { maxLength: 100, defaultValue: "" });
    const status = req.query.status ? ensureEnum(req.query.status, "status", purchaseStatuses) : "";

    const params = [];
    const conditions = [];

    if (appId) {
      params.push(appId);
      conditions.push(`p.app_id = $${params.length}`);
    }

    if (dateFrom) {
      params.push(dateFrom);
      conditions.push(`p.created_at::date >= $${params.length}::date`);
    }

    if (dateTo) {
      params.push(dateTo);
      conditions.push(`p.created_at::date <= $${params.length}::date`);
    }

    if (search) {
      params.push(`%${search}%`);
      conditions.push(
        `(p.order_no ILIKE $${params.length} OR COALESCE(u.phone, '') ILIKE $${params.length} OR u.username ILIKE $${params.length})`
      );
    }

    if (status) {
      params.push(status);
      conditions.push(`p.status = $${params.length}`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const totalParams = [...params];
    const listParams = [...params, limit, offset];

    const [countResult, summaryResult, listResult] = await Promise.all([
      query(
        `
          SELECT COUNT(*) AS total
          FROM purchases p
          JOIN users u ON u.id = p.user_id
          ${whereClause}
        `,
        totalParams
      ),
      query(
        `
          SELECT
            COUNT(*) AS total_orders,
            COUNT(*) FILTER (WHERE p.status = 'paid') AS paid_orders,
            COUNT(*) FILTER (WHERE p.status = 'pending') AS pending_orders,
            COUNT(*) FILTER (WHERE p.status = 'failed') AS failed_orders,
            COUNT(*) FILTER (WHERE p.status = 'refunded') AS refunded_orders,
            COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'paid'), 0) AS paid_revenue,
            COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'refunded'), 0) AS refunded_amount,
            COALESCE(AVG(p.amount) FILTER (WHERE p.status = 'paid'), 0) AS paid_average_value,
            MAX(p.created_at) FILTER (WHERE p.status = 'paid') AS latest_paid_at
          FROM purchases p
          JOIN users u ON u.id = p.user_id
          ${whereClause}
        `,
        totalParams
      ),
      query(
        `
          SELECT
            p.*,
            u.username,
            u.phone,
            a.name AS app_name,
            plan_config.name AS plan_name,
            plan_config.is_trial,
            plan_config.is_renewable
          FROM purchases p
          JOIN users u ON u.id = p.user_id
          JOIN applications a ON a.id = p.app_id
          LEFT JOIN app_plans plan_config
            ON plan_config.app_id = p.app_id
           AND plan_config.code = p.plan
          ${whereClause}
          ORDER BY p.created_at DESC
          LIMIT $${params.length + 1}
          OFFSET $${params.length + 2}
        `,
        listParams
      ),
    ]);

    return res.json({
      items: listResult.rows.map((row) => ({
        ...row,
        amount: Number(row.amount),
      })),
      summary: {
        total_orders: Number(summaryResult.rows[0]?.total_orders || 0),
        paid_orders: Number(summaryResult.rows[0]?.paid_orders || 0),
        pending_orders: Number(summaryResult.rows[0]?.pending_orders || 0),
        failed_orders: Number(summaryResult.rows[0]?.failed_orders || 0),
        refunded_orders: Number(summaryResult.rows[0]?.refunded_orders || 0),
        paid_revenue: Number(summaryResult.rows[0]?.paid_revenue || 0),
        refunded_amount: Number(summaryResult.rows[0]?.refunded_amount || 0),
        paid_average_value: Number(summaryResult.rows[0]?.paid_average_value || 0),
        latest_paid_at: summaryResult.rows[0]?.latest_paid_at || null,
      },
      pagination: formatPagination(page, limit, Number(countResult.rows[0].total)),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/purchases/export", async (req, res, next) => {
  try {
    const appId = req.query.app_id ? ensureAppId(req.query.app_id) : "";
    const dateFrom = ensureDateOnly(req.query.date_from, "date_from");
    const dateTo = ensureDateOnly(req.query.date_to, "date_to");
    const search = ensureOptionalString(req.query.search, { maxLength: 100, defaultValue: "" });
    const status = req.query.status ? ensureEnum(req.query.status, "status", purchaseStatuses) : "";

    const params = [];
    const conditions = [];

    if (appId) {
      params.push(appId);
      conditions.push(`p.app_id = $${params.length}`);
    }

    if (dateFrom) {
      params.push(dateFrom);
      conditions.push(`p.created_at::date >= $${params.length}::date`);
    }

    if (dateTo) {
      params.push(dateTo);
      conditions.push(`p.created_at::date <= $${params.length}::date`);
    }

    if (search) {
      params.push(`%${search}%`);
      conditions.push(
        `(p.order_no ILIKE $${params.length} OR COALESCE(u.phone, '') ILIKE $${params.length} OR u.username ILIKE $${params.length})`
      );
    }

    if (status) {
      params.push(status);
      conditions.push(`p.status = $${params.length}`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await query(
      `
        SELECT
          p.order_no,
          p.app_id,
          a.name AS app_name,
          u.id AS user_id,
          u.username,
          u.phone,
          p.plan,
          plan_config.name AS plan_name,
          plan_config.is_trial,
          p.amount,
          p.payment_method,
          p.status,
          p.created_at,
          p.expired_at
        FROM purchases p
        JOIN users u ON u.id = p.user_id
        JOIN applications a ON a.id = p.app_id
        LEFT JOIN app_plans plan_config
          ON plan_config.app_id = p.app_id
         AND plan_config.code = p.plan
        ${whereClause}
        ORDER BY p.created_at DESC
      `,
      params
    );

    const lines = [
      [
        "order_no",
        "app_id",
        "app_name",
        "user_id",
        "username",
        "phone",
        "plan",
        "plan_name",
        "amount",
        "payment_method",
        "status",
        "created_at",
        "expired_at",
      ].join(","),
      ...result.rows.map((row) =>
        [
          row.order_no,
          row.app_id,
          row.app_name,
          row.user_id,
          row.username,
          row.phone,
          row.plan,
          row.plan_name || "",
          Number(row.amount),
          row.payment_method,
          row.status,
          row.created_at?.toISOString?.() || row.created_at,
          row.expired_at?.toISOString?.() || row.expired_at || "",
        ]
          .map(escapeCsvValue)
          .join(",")
      ),
    ];

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="purchases-export.csv"');
    return res.send(lines.join("\n"));
  } catch (error) {
    return next(error);
  }
});

router.get("/purchases/:order_no", async (req, res, next) => {
  try {
    const orderNo = ensureOrderNo(req.params.order_no);
    const [purchaseResult, eventsResult] = await Promise.all([
      query(
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
      ),
      query(
        `
          SELECT *
          FROM purchase_events
          WHERE order_no = $1
          ORDER BY created_at DESC, id DESC
        `,
        [orderNo]
      ),
    ]);

    const purchase = purchaseResult.rows[0];
    if (!purchase) {
      return res.status(404).json({ error: "Order not found" });
    }

    return res.json({
      purchase: {
        ...purchase,
        amount: Number(purchase.amount || 0),
        duration_days: purchase.duration_days == null ? null : Number(purchase.duration_days),
        payment_payload:
          purchase.payment_payload && typeof purchase.payment_payload === "object"
            ? purchase.payment_payload
            : purchase.payment_payload || null,
      },
      events: eventsResult.rows,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/purchases/:order_no/status", async (req, res, next) => {
  try {
    const orderNo = ensureOrderNo(req.params.order_no);
    const status = ensureEnum(req.body?.status, "status", purchaseStatuses);
    const note = ensureOptionalString(req.body?.note, { maxLength: 300, defaultValue: "" });

    const purchaseResult = await query(
      `
        SELECT *
        FROM purchases
        WHERE order_no = $1
        LIMIT 1
      `,
      [orderNo]
    );
    const purchase = purchaseResult.rows[0];

    if (!purchase) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (!canTransitionPurchaseStatus(purchase.status, status)) {
      return res.status(409).json({
        error: `Cannot transition purchase status from ${purchase.status} to ${status}`,
      });
    }

    const updatedResult = await query(
      `
        UPDATE purchases
        SET status = $2,
            confirmed_at = CASE
              WHEN $2 = 'paid' AND confirmed_at IS NULL THEN NOW()
              ELSE confirmed_at
            END,
            updated_at = NOW()
        WHERE order_no = $1
        RETURNING *
      `,
      [orderNo, status]
    );
    const updatedPurchase = updatedResult.rows[0];

    await logAdminAction(req, {
      action: "purchase_status_updated",
      targetType: "purchase",
      targetId: orderNo,
      details: {
        order_no: orderNo,
        user_id: purchase.user_id,
        app_id: purchase.app_id,
        previous_status: purchase.status,
        current_status: status,
        note: note || null,
      },
    });

    await logPurchaseEvent({
      orderNo,
      userId: purchase.user_id,
      appId: purchase.app_id,
      eventType: "status_updated",
      eventSource: "admin_panel",
      fromStatus: purchase.status,
      toStatus: status,
      details: {
        note: note || null,
      },
      req,
    });

    return res.json({
      success: true,
      purchase: {
        ...updatedPurchase,
        amount: Number(updatedPurchase.amount || 0),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/plans", async (req, res, next) => {
  try {
    const appId = req.query.app_id ? ensureAppId(req.query.app_id) : "";
    const params = [];
    const conditions = [];

    if (appId) {
      params.push(appId);
      conditions.push(`p.app_id = $${params.length}`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await query(
      `
        SELECT
          p.*,
          a.name AS app_name,
          COALESCE(purchase_summary.purchase_count, 0) AS purchase_count
        FROM app_plans p
        JOIN applications a ON a.id = p.app_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS purchase_count
          FROM purchases purchase_log
          WHERE purchase_log.app_id = p.app_id
            AND purchase_log.plan = p.code
        ) purchase_summary ON true
        ${whereClause}
        ORDER BY a.created_at ASC, p.sort_order ASC, p.created_at ASC
      `,
      params
    );

    return res.json({
      items: result.rows.map(serializePlanRow),
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/plans", async (req, res, next) => {
  try {
    const appId = ensureAppId(req.body?.app_id);
    const code = ensurePlanCode(req.body?.code);
    const name = ensureRequiredString(req.body?.name, "name", { maxLength: 100 });
    const description = ensureOptionalString(req.body?.description, { maxLength: 500, defaultValue: null });
    const durationDays = ensureOptionalInteger(req.body?.duration_days, "duration_days", { min: 1, defaultValue: null });
    const price = ensureMoneyAmount(req.body?.price, "price");
    const originalPrice =
      req.body?.original_price == null || req.body?.original_price === ""
        ? null
        : ensureMoneyAmount(req.body?.original_price, "original_price");
    const currency = ensureRequiredString(req.body?.currency || "CNY", "currency", { maxLength: 10 }).toUpperCase();
    const status = ensureEnum(req.body?.status || "active", "status", planStatuses);
    const sortOrder = ensureOptionalInteger(req.body?.sort_order, "sort_order", { min: 0, defaultValue: 0 });
    const isTrial = Boolean(req.body?.is_trial);
    const isRenewable = Boolean(req.body?.is_renewable);
    const features = ensurePlanFeatures(req.body?.features);

    await ensureApplicationExists(appId);

    const result = await query(
      `
        INSERT INTO app_plans (
          app_id,
          code,
          name,
          description,
          duration_days,
          price,
          original_price,
          currency,
          status,
          sort_order,
          is_trial,
          is_renewable,
          features,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
        RETURNING *
      `,
      [appId, code, name, description, durationDays, price, originalPrice, currency, status, sortOrder, isTrial, isRenewable, JSON.stringify(features)]
    );

    await logAdminAction(req, {
      action: "plan_created",
      targetType: "plan",
      targetId: String(result.rows[0].id),
      details: {
        app_id: appId,
        code,
        name,
        price,
        duration_days: durationDays,
        status,
      },
    });

    return res.status(201).json({
      item: serializePlanRow(result.rows[0]),
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/plans/:plan_id", async (req, res, next) => {
  try {
    const planId = Number(req.params.plan_id);
    if (!Number.isInteger(planId) || planId <= 0) {
      throw createHttpError(400, "plan_id must be a positive integer");
    }

    const existingResult = await query(
      `
        SELECT *
        FROM app_plans
        WHERE id = $1
        LIMIT 1
      `,
      [planId]
    );
    const existing = existingResult.rows[0];
    if (!existing) {
      throw createHttpError(404, "Plan not found");
    }

    const name = ensureRequiredString(req.body?.name, "name", { maxLength: 100 });
    const description = ensureOptionalString(req.body?.description, { maxLength: 500, defaultValue: null });
    const durationDays = ensureOptionalInteger(req.body?.duration_days, "duration_days", { min: 1, defaultValue: null });
    const price = ensureMoneyAmount(req.body?.price, "price");
    const originalPrice =
      req.body?.original_price == null || req.body?.original_price === ""
        ? null
        : ensureMoneyAmount(req.body?.original_price, "original_price");
    const currency = ensureRequiredString(req.body?.currency || "CNY", "currency", { maxLength: 10 }).toUpperCase();
    const status = ensureEnum(req.body?.status || existing.status, "status", planStatuses);
    const sortOrder = ensureOptionalInteger(req.body?.sort_order, "sort_order", { min: 0, defaultValue: 0 });
    const isTrial = Boolean(req.body?.is_trial);
    const isRenewable = Boolean(req.body?.is_renewable);
    const features = ensurePlanFeatures(req.body?.features);

    const result = await query(
      `
        UPDATE app_plans
        SET name = $2,
            description = $3,
            duration_days = $4,
            price = $5,
            original_price = $6,
            currency = $7,
            status = $8,
            sort_order = $9,
            is_trial = $10,
            is_renewable = $11,
            features = $12,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [planId, name, description, durationDays, price, originalPrice, currency, status, sortOrder, isTrial, isRenewable, JSON.stringify(features)]
    );

    await logAdminAction(req, {
      action: "plan_updated",
      targetType: "plan",
      targetId: String(planId),
      details: {
        app_id: existing.app_id,
        code: existing.code,
        name,
        price,
        duration_days: durationDays,
        status,
      },
    });

    return res.json({
      item: serializePlanRow(result.rows[0]),
    });
  } catch (error) {
    return next(error);
  }
});

router.delete("/plans/:plan_id", async (req, res, next) => {
  try {
    const planId = Number(req.params.plan_id);
    if (!Number.isInteger(planId) || planId <= 0) {
      throw createHttpError(400, "plan_id must be a positive integer");
    }

    const existingResult = await query(
      `
        SELECT p.*, EXISTS(
          SELECT 1
          FROM purchases purchase_log
          WHERE purchase_log.app_id = p.app_id
            AND purchase_log.plan = p.code
        ) AS has_purchases
        FROM app_plans p
        WHERE id = $1
        LIMIT 1
      `,
      [planId]
    );
    const existing = existingResult.rows[0];
    if (!existing) {
      throw createHttpError(404, "Plan not found");
    }
    if (existing.has_purchases) {
      throw createHttpError(409, "This plan already has purchase records and cannot be deleted");
    }

    await query("DELETE FROM app_plans WHERE id = $1", [planId]);

    await logAdminAction(req, {
      action: "plan_deleted",
      targetType: "plan",
      targetId: String(planId),
      details: {
        app_id: existing.app_id,
        code: existing.code,
        name: existing.name,
      },
    });

    return res.json({ success: true });
  } catch (error) {
    return next(error);
  }
});

router.get("/redeem/overview", async (req, res, next) => {
  try {
    const filters = parseRedeemBatchFilters(req.query);
    const { params, cteSql } = buildRedeemBatchDatasetCte(filters, { includeSearch: true });
    const outerConditions = [];
    appendRedeemBatchComputedStatusFilter(filters, params, outerConditions);
    const outerWhereClause = outerConditions.length ? `WHERE ${outerConditions.join(" AND ")}` : "";

    const result = await query(
      `
        ${cteSql}
        SELECT
          COUNT(*) AS total_batches,
          COALESCE(SUM(total_codes), 0) AS total_codes,
          COALESCE(SUM(redeemed_count), 0) AS redeemed_count,
          COALESCE(SUM(disabled_count), 0) AS disabled_count,
          COALESCE(SUM(expired_count), 0) AS expired_count,
          COALESCE(SUM(scheduled_count), 0) AS scheduled_count,
          COALESCE(SUM(unused_count), 0) AS unused_count,
          CASE
            WHEN COALESCE(SUM(total_codes), 0) > 0
              THEN ROUND(COALESCE(SUM(redeemed_count), 0) * 100.0 / SUM(total_codes), 2)
            ELSE 0
          END AS redeem_rate
        FROM redeem_batch_rows
        ${outerWhereClause}
      `,
      params
    );

    return res.json({
      summary: serializeRedeemOverviewRow(result.rows[0] || null),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/redeem/channels", async (req, res, next) => {
  try {
    const filters = parseRedeemBatchFilters(req.query);
    const { params, cteSql } = buildRedeemBatchDatasetCte(filters, { includeSearch: false });
    const outerConditions = [];
    appendRedeemBatchComputedStatusFilter(filters, params, outerConditions);
    const outerWhereClause = outerConditions.length ? `WHERE ${outerConditions.join(" AND ")}` : "";

    const result = await query(
      `
        ${cteSql}
        SELECT
          channel_label AS channel,
          COUNT(*) AS batch_count,
          COALESCE(SUM(total_codes), 0) AS total_codes,
          COALESCE(SUM(redeemed_count), 0) AS redeemed_count,
          COALESCE(SUM(disabled_count), 0) AS disabled_count,
          COALESCE(SUM(expired_count), 0) AS expired_count,
          COALESCE(SUM(scheduled_count), 0) AS scheduled_count,
          COALESCE(SUM(unused_count), 0) AS unused_count,
          MAX(last_redeemed_at) AS last_redeemed_at,
          CASE
            WHEN COALESCE(SUM(total_codes), 0) > 0
              THEN ROUND(COALESCE(SUM(redeemed_count), 0) * 100.0 / SUM(total_codes), 2)
            ELSE 0
          END AS redeem_rate
        FROM redeem_batch_rows
        ${outerWhereClause}
        GROUP BY channel_label
        ORDER BY redeemed_count DESC, total_codes DESC, channel_label ASC
      `,
      params
    );

    return res.json({
      items: result.rows.map(serializeRedeemChannelRow),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/redeem/batches", async (req, res, next) => {
  try {
    const filters = parseRedeemBatchFilters(req.query, { includeSort: true });
    const { params, cteSql } = buildRedeemBatchDatasetCte(filters, { includeSearch: true });
    const outerConditions = [];
    appendRedeemBatchComputedStatusFilter(filters, params, outerConditions);
    const outerWhereClause = outerConditions.length ? `WHERE ${outerConditions.join(" AND ")}` : "";
    const orderByClause = redeemBatchSortOptions[filters.sort] || redeemBatchSortOptions.created_at_desc;

    const result = await query(
      `
        ${cteSql}
        SELECT *
        FROM redeem_batch_rows
        ${outerWhereClause}
        ORDER BY ${orderByClause}
      `,
      params
    );

    return res.json({ items: result.rows.map(serializeRedeemBatchRow) });
  } catch (error) {
    return next(error);
  }
});

router.post("/redeem/batches", async (req, res, next) => {
  try {
    const appId = ensureAppId(req.body?.app_id);
    const planCode = ensurePlanCode(req.body?.plan_code, "plan_code");
    const quantity = ensurePositiveInteger(req.body?.quantity, "quantity");
    const channel = ensureOptionalString(req.body?.channel, { maxLength: 100, defaultValue: null });
    const validFrom = ensureDateInput(req.body?.valid_from, "valid_from");
    const validUntil = ensureDateInput(req.body?.valid_until, "valid_until");
    const notes = ensureOptionalString(req.body?.notes, { maxLength: 500, defaultValue: null });

    if (quantity > 5000) {
      throw createHttpError(400, "quantity must be less than or equal to 5000");
    }
    if (validFrom && validUntil && new Date(validFrom).getTime() >= new Date(validUntil).getTime()) {
      throw createHttpError(400, "valid_until must be later than valid_from");
    }

    await ensureApplicationExists(appId);
    const planResult = await query(
      `
        SELECT *
        FROM app_plans
        WHERE app_id = $1
          AND code = $2
        LIMIT 1
      `,
      [appId, planCode]
    );
    const plan = planResult.rows[0];
    if (!plan) {
      throw createHttpError(404, "Plan not found for the selected application");
    }

    const batchNo = generateBatchNo();
    const generatedCodes = [];
    const generatedHashes = new Set();
    while (generatedCodes.length < quantity) {
      const codePlain = generateRedeemCode();
      const codeHash = hashRedeemCode(codePlain);
      if (generatedHashes.has(codeHash)) {
        continue;
      }
      generatedHashes.add(codeHash);
      generatedCodes.push({
        code_plain: codePlain,
        code_hash: codeHash,
        code_preview: buildCodePreview(codePlain),
      });
    }

    const batch = await withTransaction(async (client) => {
      const insertedBatchResult = await client.query(
        `
          INSERT INTO redeem_code_batches (
            batch_no,
            app_id,
            plan_code,
            quantity,
            channel,
            valid_from,
            valid_until,
            status,
            notes,
            created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9)
          RETURNING *
        `,
        [batchNo, appId, planCode, quantity, channel, validFrom, validUntil, notes, req.user?.username || req.user?.user_id || "admin"]
      );
      const insertedBatch = insertedBatchResult.rows[0];

      const chunkSize = 500;
      for (let index = 0; index < generatedCodes.length; index += chunkSize) {
        const chunk = generatedCodes.slice(index, index + chunkSize);
        const placeholders = chunk
          .map((_, chunkIndex) => {
            const base = chunkIndex * 6;
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
          })
          .join(", ");
        const values = chunk.flatMap((item) => [
          insertedBatch.id,
          item.code_plain,
          item.code_hash,
          item.code_preview,
          appId,
          planCode,
        ]);

        await client.query(
          `
            INSERT INTO redeem_codes (
              batch_id,
              code_plain,
              code_hash,
              code_preview,
              app_id,
              plan_code
            )
            VALUES ${placeholders}
          `,
          values
        );
      }

      await client.query(
        `
          INSERT INTO redeem_events (
            batch_id,
            event_type,
            operator_id,
            payload
          )
          VALUES ($1, 'generated', $2, $3::jsonb)
        `,
        [
          insertedBatch.id,
          req.user?.user_id || req.user?.username || "admin",
          JSON.stringify({
            app_id: appId,
            plan_code: planCode,
            quantity,
            channel,
            valid_from: validFrom,
            valid_until: validUntil,
          }),
        ]
      );

      return insertedBatch;
    });

    await logAdminAction(req, {
      action: "redeem_batch_created",
      targetType: "redeem_batch",
      targetId: String(batch.id),
      details: {
        batch_no: batchNo,
        app_id: appId,
        plan_code: planCode,
        quantity,
        channel: channel || null,
        valid_until: validUntil,
      },
    });

    return res.status(201).json({
      item: serializeRedeemBatchRow({
        ...batch,
        app_name: (await ensureApplicationExists(appId)).name,
        plan_name: plan.name,
        duration_days: plan.duration_days,
        is_trial: plan.is_trial,
        is_renewable: plan.is_renewable,
        total_codes: quantity,
        redeemed_count: 0,
        disabled_count: 0,
        expired_count: 0,
        scheduled_count: validFrom && new Date(validFrom).getTime() > Date.now() ? quantity : 0,
        unused_count: validFrom && new Date(validFrom).getTime() > Date.now() ? 0 : quantity,
        redeem_rate: 0,
        computed_status: deriveRedeemBatchComputedStatus(batch),
      }),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/redeem/codes", async (req, res, next) => {
  try {
    const filters = {
      appId: req.query.app_id ? ensureAppId(req.query.app_id) : "",
      planCode: req.query.plan_code ? ensurePlanCode(req.query.plan_code, "plan_code") : "",
      channel: ensureOptionalString(req.query.channel, { maxLength: 100, defaultValue: "" }),
      search: ensureOptionalString(req.query.search, { maxLength: 100, defaultValue: "" }),
      computedStatus: req.query.computed_status
        ? ensureEnum(req.query.computed_status, "computed_status", redeemCodeComputedStatuses)
        : "",
    };
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 12, maxLimit: 100 });
    const params = [];
    const conditions = [];

    if (filters.appId) {
      params.push(filters.appId);
      conditions.push(`rc.app_id = $${params.length}`);
    }
    if (filters.planCode) {
      params.push(filters.planCode);
      conditions.push(`rc.plan_code = $${params.length}`);
    }
    if (filters.channel) {
      params.push(filters.channel);
      conditions.push(`${buildNormalizedChannelSql("batch")} = $${params.length}`);
    }
    if (filters.search) {
      params.push(`%${filters.search}%`);
      conditions.push(
        `(rc.code_preview ILIKE $${params.length} OR COALESCE(rc.external_order_no, '') ILIKE $${params.length} OR COALESCE(p.order_no, '') ILIKE $${params.length} OR COALESCE(u.phone, '') ILIKE $${params.length} OR COALESCE(u.username, '') ILIKE $${params.length} OR batch.batch_no ILIKE $${params.length} OR ${buildNormalizedChannelSql("batch")} ILIKE $${params.length})`
      );
    }
    if (filters.computedStatus) {
      params.push(filters.computedStatus);
      conditions.push(`${buildRedeemCodeComputedStatusSql("rc", "batch")} = $${params.length}`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const countResult = await query(
      `
        SELECT COUNT(*) AS total
        FROM redeem_codes rc
        JOIN redeem_code_batches batch ON batch.id = rc.batch_id
        LEFT JOIN users u ON u.id = rc.redeemed_by_user_id
        LEFT JOIN purchases p ON p.id = rc.purchase_id
        ${whereClause}
      `,
      params
    );

    const listParams = [...params, limit, offset];
    const result = await query(
      `
        SELECT
          rc.id,
          rc.batch_id,
          rc.code_preview,
          rc.app_id,
          rc.plan_code,
          rc.status,
          rc.redeemed_at,
          rc.external_order_no,
          rc.created_at,
          batch.batch_no,
          batch.valid_from,
          batch.valid_until,
          batch.status AS batch_status,
          ${buildNormalizedChannelSql("batch")} AS channel,
          u.id AS user_id,
          u.username,
          u.phone,
          p.order_no,
          p.amount,
          ${buildRedeemCodeComputedStatusSql("rc", "batch")} AS computed_status
        FROM redeem_codes rc
        JOIN redeem_code_batches batch ON batch.id = rc.batch_id
        LEFT JOIN users u ON u.id = rc.redeemed_by_user_id
        LEFT JOIN purchases p ON p.id = rc.purchase_id
        ${whereClause}
        ORDER BY COALESCE(rc.redeemed_at, rc.created_at) DESC, rc.id DESC
        LIMIT $${listParams.length - 1}
        OFFSET $${listParams.length}
      `,
      listParams
    );

    return res.json({
      items: result.rows.map(serializeRedeemCodeRow),
      pagination: formatPagination(page, limit, Number(countResult.rows[0]?.total || 0)),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/redeem/batches/:batch_id/codes", async (req, res, next) => {
  try {
    const batchId = ensurePositiveInteger(req.params.batch_id, "batch_id");
    const search = ensureOptionalString(req.query.search, { maxLength: 100, defaultValue: "" });
    const computedStatus = req.query.computed_status
      ? ensureEnum(req.query.computed_status, "computed_status", redeemCodeComputedStatuses)
      : "";
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    const params = [batchId];
    const conditions = ["rc.batch_id = $1"];
    if (search) {
      params.push(`%${search}%`);
      conditions.push(
        `(rc.code_preview ILIKE $${params.length} OR COALESCE(rc.external_order_no, '') ILIKE $${params.length} OR COALESCE(p.order_no, '') ILIKE $${params.length} OR COALESCE(u.phone, '') ILIKE $${params.length} OR COALESCE(u.username, '') ILIKE $${params.length})`
      );
    }
    if (computedStatus) {
      params.push(computedStatus);
      conditions.push(`${buildRedeemCodeComputedStatusSql("rc", "batch")} = $${params.length}`);
    }
    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const batchResult = await query(
      `
        SELECT
          batch.*,
          app.name AS app_name,
          plan.name AS plan_name,
          plan.duration_days,
          plan.is_trial,
          plan.is_renewable,
          ${buildNormalizedChannelSql("batch")} AS channel_label,
          COALESCE(code_summary.total_codes, 0) AS total_codes,
          COALESCE(code_summary.redeemed_count, 0) AS redeemed_count,
          COALESCE(code_summary.disabled_count, 0) AS disabled_count,
          COALESCE(code_summary.expired_count, 0) AS expired_count,
          COALESCE(code_summary.scheduled_count, 0) AS scheduled_count,
          COALESCE(code_summary.unused_count, 0) AS unused_count,
          code_summary.last_redeemed_at,
          ${buildRedeemBatchComputedStatusSql("batch")} AS computed_status,
          CASE
            WHEN COALESCE(code_summary.total_codes, 0) > 0
              THEN ROUND(COALESCE(code_summary.redeemed_count, 0) * 100.0 / code_summary.total_codes, 2)
            ELSE 0
          END AS redeem_rate
        FROM redeem_code_batches batch
        JOIN applications app ON app.id = batch.app_id
        LEFT JOIN app_plans plan ON plan.app_id = batch.app_id AND plan.code = batch.plan_code
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) AS total_codes,
            COUNT(*) FILTER (WHERE ${buildRedeemCodeComputedStatusSql("rc", "batch")} = 'redeemed') AS redeemed_count,
            COUNT(*) FILTER (WHERE ${buildRedeemCodeComputedStatusSql("rc", "batch")} = 'disabled') AS disabled_count,
            COUNT(*) FILTER (WHERE ${buildRedeemCodeComputedStatusSql("rc", "batch")} = 'expired') AS expired_count,
            COUNT(*) FILTER (WHERE ${buildRedeemCodeComputedStatusSql("rc", "batch")} = 'scheduled') AS scheduled_count,
            COUNT(*) FILTER (WHERE ${buildRedeemCodeComputedStatusSql("rc", "batch")} = 'unused') AS unused_count,
            MAX(rc.redeemed_at) AS last_redeemed_at
          FROM redeem_codes rc
          WHERE rc.batch_id = batch.id
        ) code_summary ON true
        WHERE batch.id = $1
        LIMIT 1
      `,
      [batchId]
    );
    const batch = batchResult.rows[0];
    if (!batch) {
      throw createHttpError(404, "Redeem batch not found");
    }

    const countResult = await query(
      `
        SELECT COUNT(*) AS total
        FROM redeem_codes rc
        JOIN redeem_code_batches batch ON batch.id = rc.batch_id
        LEFT JOIN users u ON u.id = rc.redeemed_by_user_id
        LEFT JOIN purchases p ON p.id = rc.purchase_id
        ${whereClause}
      `,
      params
    );

    const listParams = [...params, limit, offset];
    const result = await query(
      `
        SELECT
          rc.id,
          rc.code_preview,
          rc.app_id,
          rc.plan_code,
          rc.status,
          rc.redeemed_at,
          rc.external_order_no,
          rc.created_at,
          batch.valid_from,
          batch.valid_until,
          batch.status AS batch_status,
          u.id AS user_id,
          u.username,
          u.phone,
          p.order_no,
          p.amount,
          p.id AS purchase_id,
          ${buildRedeemCodeComputedStatusSql("rc", "batch")} AS computed_status
        FROM redeem_codes rc
        JOIN redeem_code_batches batch ON batch.id = rc.batch_id
        LEFT JOIN users u ON u.id = rc.redeemed_by_user_id
        LEFT JOIN purchases p ON p.id = rc.purchase_id
        ${whereClause}
        ORDER BY rc.created_at ASC, rc.id ASC
        LIMIT $${listParams.length - 1}
        OFFSET $${listParams.length}
      `,
      listParams
    );

    return res.json({
      batch: serializeRedeemBatchRow(batch),
      items: result.rows.map(serializeRedeemCodeRow),
      pagination: formatPagination(page, limit, Number(countResult.rows[0].total)),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/redeem/batches/:batch_id/events", async (req, res, next) => {
  try {
    const batchId = ensurePositiveInteger(req.params.batch_id, "batch_id");
    const batchExists = await query(
      `
        SELECT id
        FROM redeem_code_batches
        WHERE id = $1
        LIMIT 1
      `,
      [batchId]
    );
    if (!batchExists.rows[0]) {
      throw createHttpError(404, "Redeem batch not found");
    }

    const result = await query(
      `
        SELECT
          re.id,
          re.code_id,
          re.batch_id,
          re.event_type,
          re.operator_id,
          re.user_id,
          re.payload,
          re.created_at,
          u.username,
          u.phone
        FROM redeem_events re
        LEFT JOIN users u ON u.id = re.user_id
        WHERE re.batch_id = $1
        ORDER BY re.created_at DESC, re.id DESC
        LIMIT 100
      `,
      [batchId]
    );

    return res.json({
      items: result.rows.map(serializeRedeemEventRow),
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/redeem/codes/:code_id/plaintext", async (req, res, next) => {
  try {
    const codeId = ensurePositiveInteger(req.params.code_id, "code_id");
    const action = ensureEnum(req.body?.action, "action", ["view", "copy"]);

    const result = await query(
      `
        SELECT
          rc.id,
          rc.code_plain,
          rc.code_preview,
          rc.app_id,
          rc.plan_code,
          rc.batch_id,
          batch.batch_no,
          ${buildNormalizedChannelSql("batch")} AS channel_label
        FROM redeem_codes rc
        JOIN redeem_code_batches batch ON batch.id = rc.batch_id
        WHERE rc.id = $1
        LIMIT 1
      `,
      [codeId]
    );
    const redeemCode = result.rows[0];
    if (!redeemCode) {
      throw createHttpError(404, "Redeem code not found");
    }

    const eventType = action === "copy" ? "plaintext_copied" : "plaintext_viewed";
    const adminAction = action === "copy" ? "redeem_code_plaintext_copied" : "redeem_code_plaintext_viewed";
    const operatorId = getAdminOperatorId(req);

    await query(
      `
        INSERT INTO redeem_events (
          code_id,
          batch_id,
          event_type,
          operator_id,
          payload
        )
        VALUES ($1, $2, $3, $4, $5::jsonb)
      `,
      [
        redeemCode.id,
        redeemCode.batch_id,
        eventType,
        operatorId,
        JSON.stringify({
          code_preview: redeemCode.code_preview,
          action,
        }),
      ]
    );

    await logAdminAction(req, {
      action: adminAction,
      targetType: "redeem_code",
      targetId: String(redeemCode.id),
      details: {
        batch_no: redeemCode.batch_no,
        app_id: redeemCode.app_id,
        plan_code: redeemCode.plan_code,
        code_preview: redeemCode.code_preview,
        channel: redeemCode.channel_label,
      },
    });

    return res.json({
      item: {
        id: redeemCode.id,
        code_preview: redeemCode.code_preview,
        code_plain: redeemCode.code_plain,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/redeem/batches/:batch_id/export", async (req, res, next) => {
  try {
    const batchId = ensurePositiveInteger(req.params.batch_id, "batch_id");
    const search = ensureOptionalString(req.query.search, { maxLength: 100, defaultValue: "" });
    const computedStatus = req.query.status
      ? ensureEnum(req.query.status, "status", redeemCodeComputedStatuses)
      : req.query.computed_status
      ? ensureEnum(req.query.computed_status, "computed_status", redeemCodeComputedStatuses)
      : "";
    const batchResult = await query(
      `
        SELECT
          batch.*,
          app.name AS app_name,
          plan.name AS plan_name,
          ${buildNormalizedChannelSql("batch")} AS channel_label
        FROM redeem_code_batches batch
        JOIN applications app ON app.id = batch.app_id
        LEFT JOIN app_plans plan ON plan.app_id = batch.app_id AND plan.code = batch.plan_code
        WHERE batch.id = $1
        LIMIT 1
      `,
      [batchId]
    );
    const batch = batchResult.rows[0];
    if (!batch) {
      throw createHttpError(404, "Redeem batch not found");
    }

    const params = [batchId];
    const conditions = ["rc.batch_id = $1"];
    if (search) {
      params.push(`%${search}%`);
      conditions.push(
        `(rc.code_preview ILIKE $${params.length} OR COALESCE(rc.external_order_no, '') ILIKE $${params.length} OR COALESCE(p.order_no, '') ILIKE $${params.length} OR COALESCE(u.phone, '') ILIKE $${params.length} OR COALESCE(u.username, '') ILIKE $${params.length})`
      );
    }
    if (computedStatus) {
      params.push(computedStatus);
      conditions.push(`${buildRedeemCodeComputedStatusSql("rc", "batch")} = $${params.length}`);
    }
    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const codesResult = await query(
      `
        SELECT
          rc.code_plain,
          rc.code_preview,
          rc.status,
          rc.redeemed_at,
          rc.external_order_no,
          p.order_no,
          u.username,
          u.phone,
          ${buildRedeemCodeComputedStatusSql("rc", "batch")} AS computed_status
        FROM redeem_codes rc
        JOIN redeem_code_batches batch ON batch.id = rc.batch_id
        LEFT JOIN users u ON u.id = rc.redeemed_by_user_id
        LEFT JOIN purchases p ON p.id = rc.purchase_id
        ${whereClause}
        ORDER BY rc.created_at ASC, rc.id ASC
      `,
      params
    );

    await query(
      `
        INSERT INTO redeem_events (
          batch_id,
          event_type,
          operator_id,
          payload
        )
        VALUES ($1, 'exported', $2, $3::jsonb)
      `,
      [
        batchId,
        req.user?.user_id || req.user?.username || "admin",
        JSON.stringify({
          exported_count: codesResult.rowCount,
          computed_status: computedStatus || null,
          search: search || null,
        }),
      ]
    );

    await logAdminAction(req, {
      action: "redeem_batch_exported",
      targetType: "redeem_batch",
      targetId: String(batchId),
      details: {
        batch_no: batch.batch_no,
        app_id: batch.app_id,
        plan_code: batch.plan_code,
        exported_count: codesResult.rowCount,
        computed_status: computedStatus || null,
      },
    });

    const lines = [
      ["batch_no", "channel", "plan_code", "code_plain", "code_preview", "computed_status", "username", "phone", "order_no", "redeemed_at", "external_order_no"].join(","),
      ...codesResult.rows.map((row) =>
        [
          batch.batch_no,
          batch.channel_label,
          batch.plan_code,
          row.code_plain,
          row.code_preview,
          row.computed_status,
          row.username || "",
          row.phone || "",
          row.order_no || "",
          row.redeemed_at?.toISOString?.() || row.redeemed_at || "",
          row.external_order_no || "",
        ]
          .map(escapeCsvValue)
          .join(",")
      ),
    ];

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${batch.batch_no}.csv"`);
    return res.send(lines.join("\n"));
  } catch (error) {
    return next(error);
  }
});

router.post("/redeem/batches/:batch_id/status", async (req, res, next) => {
  try {
    const batchId = ensurePositiveInteger(req.params.batch_id, "batch_id");
    const status = ensureEnum(req.body?.status, "status", ["active", "disabled"]);
    const existingResult = await query(
      `
        SELECT *
        FROM redeem_code_batches
        WHERE id = $1
        LIMIT 1
      `,
      [batchId]
    );
    const existing = existingResult.rows[0];
    if (!existing) {
      throw createHttpError(404, "Redeem batch not found");
    }

    const updatedResult = await query(
      `
        UPDATE redeem_code_batches
        SET status = $2
        WHERE id = $1
        RETURNING *
      `,
      [batchId, status]
    );

    await query(
      `
        INSERT INTO redeem_events (
          batch_id,
          event_type,
          operator_id,
          payload
        )
        VALUES ($1, $2, $3, $4::jsonb)
      `,
      [
        batchId,
        status === "disabled" ? "disabled" : "reissued",
        req.user?.user_id || req.user?.username || "admin",
        JSON.stringify({
          previous_status: existing.status,
          current_status: status,
        }),
      ]
    );

    await logAdminAction(req, {
      action: "redeem_batch_status_updated",
      targetType: "redeem_batch",
      targetId: String(batchId),
      details: {
        batch_no: existing.batch_no,
        app_id: existing.app_id,
        plan_code: existing.plan_code,
        previous_status: existing.status,
        current_status: status,
      },
    });

    return res.json({
      item: serializeRedeemBatchRow({
        ...updatedResult.rows[0],
        computed_status: deriveRedeemBatchComputedStatus(updatedResult.rows[0]),
      }),
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/redeem/codes/:code_id/status", async (req, res, next) => {
  try {
    const codeId = ensurePositiveInteger(req.params.code_id, "code_id");
    const status = ensureEnum(req.body?.status, "status", ["unused", "disabled"]);
    const existingResult = await query(
      `
        SELECT
          rc.*,
          batch.batch_no,
          batch.status AS batch_status,
          batch.valid_from,
          batch.valid_until
        FROM redeem_codes rc
        JOIN redeem_code_batches batch ON batch.id = rc.batch_id
        WHERE rc.id = $1
        LIMIT 1
      `,
      [codeId]
    );
    const existing = existingResult.rows[0];
    if (!existing) {
      throw createHttpError(404, "Redeem code not found");
    }
    if (existing.status === "redeemed") {
      throw createHttpError(409, "Redeemed codes cannot be modified");
    }

    const updatedResult = await query(
      `
        UPDATE redeem_codes
        SET status = $2
        WHERE id = $1
        RETURNING *
      `,
      [codeId, status]
    );

    await query(
      `
        INSERT INTO redeem_events (
          code_id,
          batch_id,
          event_type,
          operator_id,
          payload
        )
        VALUES ($1, $2, $3, $4, $5::jsonb)
      `,
      [
        codeId,
        existing.batch_id,
        status === "disabled" ? "disabled" : "reissued",
        req.user?.user_id || req.user?.username || "admin",
        JSON.stringify({
          previous_status: existing.status,
          current_status: status,
          code_preview: existing.code_preview,
        }),
      ]
    );

    await logAdminAction(req, {
      action: "redeem_code_status_updated",
      targetType: "redeem_code",
      targetId: String(codeId),
      details: {
        batch_no: existing.batch_no,
        app_id: existing.app_id,
        plan_code: existing.plan_code,
        code_preview: existing.code_preview,
        previous_status: existing.status,
        current_status: status,
      },
    });

    return res.json({
      item: serializeRedeemCodeRow({
        ...updatedResult.rows[0],
        batch_status: existing.batch_status,
        valid_from: existing.valid_from,
        valid_until: existing.valid_until,
        computed_status: deriveRedeemCodeComputedStatus({
          ...updatedResult.rows[0],
          batch_status: existing.batch_status,
          valid_from: existing.valid_from,
          valid_until: existing.valid_until,
        }),
      }),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/applications", async (req, res, next) => {
  try {
    const result = await query(
      `
        SELECT
          a.*,
          COALESCE(membership_summary.registered_users, 0) AS registered_users,
          COALESCE(purchase_summary.paid_users, 0) AS paid_users,
          COALESCE(purchase_summary.revenue, 0) AS revenue,
          COALESCE(release_summary.release_count, 0) AS release_count,
          release_summary.release_updated_at,
          COALESCE(release_summary.release_types, ARRAY[]::varchar[]) AS release_types,
          landing_summary.landing_updated_at,
          COALESCE(landing_summary.landing_published, false) AS landing_published
        FROM applications a
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS registered_users
          FROM user_app_memberships
          WHERE app_id = a.id AND status = 'active'
        ) membership_summary ON true
        LEFT JOIN LATERAL (
          SELECT
            COUNT(DISTINCT user_id) FILTER (WHERE status = 'paid') AS paid_users,
            COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) AS revenue
          FROM purchases
          WHERE app_id = a.id
        ) purchase_summary ON true
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) AS release_count,
            MAX(updated_at) AS release_updated_at,
            ARRAY_AGG(type ORDER BY type) AS release_types
          FROM app_releases
          WHERE app_id = a.id
        ) release_summary ON true
        LEFT JOIN LATERAL (
          SELECT
            MAX(updated_at) AS landing_updated_at,
            BOOL_OR(is_published) AS landing_published
          FROM landing_pages
          WHERE app_id = a.id
        ) landing_summary ON true
        ORDER BY a.created_at ASC
      `
    );

    return res.json({
      items: result.rows.map(serializeApplicationRow),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/applications/:app_id", async (req, res, next) => {
  try {
    const appId = ensureAppId(req.params.app_id);
    const application = await getApplicationDetail(appId);
    return res.json({ application });
  } catch (error) {
    return next(error);
  }
});

router.get("/applications/:app_id/sdk-doc", async (req, res, next) => {
  try {
    const appId = ensureAppId(req.params.app_id);
    const application = await getApplicationDetail(appId);

    if (!application) {
      throw createHttpError(404, "Application not found");
    }

    const markdown = buildSdkMarkdown(application);
    const fileName = buildSdkExportFileName(application);

    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.send(markdown);
  } catch (error) {
    return next(error);
  }
});

router.post("/applications", async (req, res, next) => {
  let draftPath = null;
  try {
    const appId = ensureAppId(req.body?.id, "id");
    const name = ensureRequiredString(req.body?.name, "name", { maxLength: 100 });
    const description = ensureOptionalString(req.body?.description, { maxLength: 500, defaultValue: null });
    const type = ensureEnum(req.body?.type, "type", applicationTypes);
    const status = ensureEnum(req.body?.status || "active", "status", applicationStatuses);
    const createLandingDraft = req.body?.create_landing_draft !== false;
    const slug = createLandingDraft ? ensureSlug(req.body?.slug || appId, "slug") : null;

    const existingApplication = await query("SELECT id FROM applications WHERE id = $1 LIMIT 1", [appId]);
    if (existingApplication.rows[0]) {
      return res.status(409).json({ error: "Application already exists" });
    }

    if (slug) {
      const slugConflict = await query("SELECT id FROM landing_pages WHERE slug = $1 LIMIT 1", [slug]);
      if (slugConflict.rows[0]) {
        return res.status(409).json({ error: "Slug is already in use" });
      }
    }

    draftPath = createLandingDraft
      ? createDefaultLandingDraftFile({
          appId,
          appName: name,
          description,
          slug,
        })
      : null;

    await withTransaction(async (client) => {
      await client.query(
        `
          INSERT INTO applications (id, name, description, type, status)
          VALUES ($1, $2, $3, $4, $5)
        `,
        [appId, name, description, type, status]
      );

      if (createLandingDraft && draftPath) {
        await client.query(
          `
            INSERT INTO landing_pages (
              app_id,
              slug,
              html_path,
              draft_html_path,
              draft_updated_at,
              updated_at
            )
            VALUES ($1, $2, $3, $3, NOW(), NOW())
          `,
          [appId, slug, draftPath]
        );
      }
    });

    await logAdminAction(req, {
      action: "application_created",
      targetType: "application",
      targetId: appId,
      details: {
        app_id: appId,
        name,
        type,
        status,
        slug,
        create_landing_draft: createLandingDraft,
      },
    });

    const application = await getApplicationDetail(appId);
    return res.status(201).json({
      application,
      landing: createLandingDraft
        ? {
            slug,
            preview_url: `/api/admin/landing/preview/${appId}`,
          }
        : null,
    });
  } catch (error) {
    if (draftPath && fs.existsSync(draftPath)) {
      fs.unlinkSync(draftPath);
    }
    return next(error);
  }
});

router.patch("/applications/:app_id", async (req, res, next) => {
  try {
    const appId = ensureAppId(req.params.app_id);
    await ensureApplicationExists(appId);

    const name = ensureRequiredString(req.body?.name, "name", { maxLength: 100 });
    const description = ensureOptionalString(req.body?.description, { maxLength: 500, defaultValue: null });
    const type = ensureEnum(req.body?.type, "type", applicationTypes);
    const status = ensureEnum(req.body?.status || "active", "status", applicationStatuses);

    await query(
      `
        UPDATE applications
        SET name = $2,
            description = $3,
            type = $4,
            status = $5
        WHERE id = $1
      `,
      [appId, name, description, type, status]
    );

    await logAdminAction(req, {
      action: "application_updated",
      targetType: "application",
      targetId: appId,
      details: {
        app_id: appId,
        name,
        type,
        status,
      },
    });

    const application = await getApplicationDetail(appId);
    return res.json({ application });
  } catch (error) {
    return next(error);
  }
});

router.get("/operation-logs", async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    const action = ensureOptionalString(req.query.action, { maxLength: 100, defaultValue: "" });
    const targetType = ensureOptionalString(req.query.target_type, { maxLength: 50, defaultValue: "" });
    const actor = ensureOptionalString(req.query.actor, { maxLength: 120, defaultValue: "" });

    const params = [];
    const conditions = [];

    if (action) {
      params.push(action);
      conditions.push(`action = $${params.length}`);
    }

    if (targetType) {
      params.push(targetType);
      conditions.push(`target_type = $${params.length}`);
    }

    if (actor) {
      params.push(`%${actor}%`);
      conditions.push(`(COALESCE(actor_name, '') ILIKE $${params.length} OR COALESCE(actor_id, '') ILIKE $${params.length})`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const totalParams = [...params];
    const listParams = [...params, limit, offset];

    const [countResult, listResult] = await Promise.all([
      query(`SELECT COUNT(*) AS total FROM operation_logs ${whereClause}`, totalParams),
      query(
        `
          SELECT *
          FROM operation_logs
          ${whereClause}
          ORDER BY created_at DESC
          LIMIT $${params.length + 1}
          OFFSET $${params.length + 2}
        `,
        listParams
      ),
    ]);

    return res.json({
      items: listResult.rows,
      pagination: formatPagination(page, limit, Number(countResult.rows[0].total)),
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/verification-codes", async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 20, maxLimit: 100 });
    const appId = req.query.app_id ? ensureAppId(req.query.app_id) : "";
    const purpose = req.query.purpose ? ensureEnum(req.query.purpose, "purpose", ["register", "reset_password"]) : "";
    const mode = req.query.mode ? ensureEnum(req.query.mode, "mode", ["dev", "sms"]) : "";
    const sendStatus = req.query.send_status
      ? ensureEnum(req.query.send_status, "send_status", ["pending", "sent", "failed"])
      : "";
    const provider = ensureOptionalString(req.query.provider, { maxLength: 50, defaultValue: "" });
    const search = ensureOptionalString(req.query.search, { maxLength: 100, defaultValue: "" });
    const createdFrom = ensureDateOnly(req.query.created_from, "created_from");
    const createdTo = ensureDateOnly(req.query.created_to, "created_to");

    const params = [];
    const conditions = [];

    if (appId) {
      params.push(appId);
      conditions.push(`vc.app_id = $${params.length}`);
    }
    if (purpose) {
      params.push(purpose);
      conditions.push(`vc.purpose = $${params.length}`);
    }
    if (mode) {
      params.push(mode);
      conditions.push(`vc.mode = $${params.length}`);
    }
    if (sendStatus) {
      params.push(sendStatus);
      conditions.push(`vc.send_status = $${params.length}`);
    }
    if (provider) {
      params.push(provider);
      conditions.push(`vc.provider = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(
        `(vc.phone ILIKE $${params.length} OR COALESCE(vc.provider_request_id, '') ILIKE $${params.length} OR COALESCE(vc.provider_serial_no, '') ILIKE $${params.length} OR COALESCE(vc.error_message, '') ILIKE $${params.length})`
      );
    }
    if (createdFrom) {
      params.push(createdFrom);
      conditions.push(`vc.created_at::date >= $${params.length}::date`);
    }
    if (createdTo) {
      params.push(createdTo);
      conditions.push(`vc.created_at::date <= $${params.length}::date`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const totalParams = [...params];
    const listParams = [...params, limit, offset];

    const [countResult, summaryResult, listResult] = await Promise.all([
      query(
        `
          SELECT COUNT(*) AS total
          FROM verification_codes vc
          JOIN applications a ON a.id = vc.app_id
          ${whereClause}
        `,
        totalParams
      ),
      query(
        `
          SELECT
            COUNT(*) AS total_codes,
            COUNT(*) FILTER (WHERE vc.send_status = 'sent') AS sent_count,
            COUNT(*) FILTER (WHERE vc.send_status = 'failed') AS failed_count,
            COUNT(*) FILTER (WHERE vc.send_status = 'pending') AS pending_count,
            COUNT(*) FILTER (WHERE vc.mode = 'sms') AS sms_count,
            COUNT(*) FILTER (WHERE vc.mode = 'dev') AS dev_count,
            MAX(vc.created_at) AS latest_created_at
          FROM verification_codes vc
          JOIN applications a ON a.id = vc.app_id
          ${whereClause}
        `,
        totalParams
      ),
      query(
        `
          SELECT
            vc.*,
            a.name AS app_name
          FROM verification_codes vc
          JOIN applications a ON a.id = vc.app_id
          ${whereClause}
          ORDER BY vc.created_at DESC, vc.id DESC
          LIMIT $${params.length + 1}
          OFFSET $${params.length + 2}
        `,
        listParams
      ),
    ]);

    return res.json({
      items: listResult.rows.map(serializeVerificationCodeRow),
      summary: {
        total_codes: Number(summaryResult.rows[0]?.total_codes || 0),
        sent_count: Number(summaryResult.rows[0]?.sent_count || 0),
        failed_count: Number(summaryResult.rows[0]?.failed_count || 0),
        pending_count: Number(summaryResult.rows[0]?.pending_count || 0),
        sms_count: Number(summaryResult.rows[0]?.sms_count || 0),
        dev_count: Number(summaryResult.rows[0]?.dev_count || 0),
        latest_created_at: summaryResult.rows[0]?.latest_created_at || null,
      },
      pagination: formatPagination(page, limit, Number(countResult.rows[0].total)),
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
