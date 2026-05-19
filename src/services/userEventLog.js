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

async function logUserEvent({
  userId,
  appId = null,
  eventType,
  eventSource = "system",
  details = null,
  req = null,
  actorMode = null,
  actorId = null,
  actorName = null,
}) {
  const resolvedActor = req ? resolveActor(req) : null;

  await query(
    `
      INSERT INTO user_events (
        user_id,
        app_id,
        event_type,
        event_source,
        actor_mode,
        actor_id,
        actor_name,
        details,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW())
    `,
    [
      userId,
      appId,
      eventType,
      eventSource,
      actorMode || resolvedActor?.actorMode || "system",
      actorId || resolvedActor?.actorId || null,
      actorName || resolvedActor?.actorName || null,
      details ? JSON.stringify(details) : null,
    ]
  );
}

module.exports = {
  logUserEvent,
};
