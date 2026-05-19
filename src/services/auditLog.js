const { query } = require("../config/db");

function getActor(req) {
  const admin = req.admin || {};
  const user = admin.user || req.currentUser || null;

  return {
    actorMode: admin.mode || "unknown",
    actorId: user?.sub || null,
    actorName: user?.username || null,
  };
}

async function logAdminAction(req, { action, targetType, targetId = null, details = null }) {
  const actor = getActor(req);
  await query(
    `
      INSERT INTO operation_logs (
        actor_mode,
        actor_id,
        actor_name,
        action,
        target_type,
        target_id,
        details,
        ip_address,
        user_agent
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
    `,
    [
      actor.actorMode,
      actor.actorId,
      actor.actorName,
      action,
      targetType,
      targetId,
      details ? JSON.stringify(details) : null,
      req.ip || null,
      req.get("user-agent") || null,
    ]
  );
}

module.exports = {
  logAdminAction,
};
