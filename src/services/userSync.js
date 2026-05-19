const { query } = require("../config/db");

async function syncUser(profile) {
  const result = await query(
    `
      INSERT INTO users (id, username, phone, email, created_at, last_login)
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        username = EXCLUDED.username,
        phone = EXCLUDED.phone,
        email = EXCLUDED.email,
        last_login = NOW()
      RETURNING *
    `,
    [profile.sub, profile.username, profile.phone, profile.email]
  );

  return result.rows[0];
}

module.exports = {
  syncUser,
};
