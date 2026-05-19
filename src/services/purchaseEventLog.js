const { query } = require("../config/db");

function resolveActor(req) {
  const admin = req?.admin || {};
  const user = admin.user || req?.currentUser || null;

  return {
    actorMode: admin.mode || "system",
    actorId: user?.sub || null,
    actorName: user?.username || null,
  };
}

async function logPurchaseEvent({
  orderNo,
  userId = null,
  appId = null,
  eventType,
  eventSource = "system",
  fromStatus = null,
  toStatus = null,
  details = null,
  req = null,
  actorMode = null,
  actorId = null,
  actorName = null,
}) {
  const resolvedActor = req ? resolveActor(req) : null;

  await query(
    `
      INSERT INTO purchase_events (
        order_no,
        user_id,
        app_id,
        event_type,
        event_source,
        from_status,
        to_status,
        actor_mode,
        actor_id,
        actor_name,
        details,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, NOW())
    `,
    [
      orderNo,
      userId,
      appId,
      eventType,
      eventSource,
      fromStatus,
      toStatus,
      actorMode || resolvedActor?.actorMode || "system",
      actorId || resolvedActor?.actorId || null,
      actorName || resolvedActor?.actorName || null,
      details ? JSON.stringify(details) : null,
    ]
  );
}

module.exports = {
  logPurchaseEvent,
};
