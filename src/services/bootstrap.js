const { query } = require("../config/db");

async function ensureRuntimeSchema() {
  await query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS account_status VARCHAR(20) DEFAULT 'active'
  `);

  await query(`
    ALTER TABLE purchases
    ADD COLUMN IF NOT EXISTS purchase_mode VARCHAR(20) DEFAULT 'new'
  `);

  await query(`
    ALTER TABLE purchases
    ADD COLUMN IF NOT EXISTS external_order_no VARCHAR(120)
  `);

  await query(`
    ALTER TABLE purchases
    ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMP
  `);

  await query(`
    ALTER TABLE purchases
    ADD COLUMN IF NOT EXISTS payment_payload JSONB
  `);

  await query(`
    ALTER TABLE purchases
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS purchase_events (
      id BIGSERIAL PRIMARY KEY,
      order_no VARCHAR(100) NOT NULL,
      user_id VARCHAR(100),
      app_id VARCHAR(50),
      event_type VARCHAR(50) NOT NULL,
      event_source VARCHAR(50) DEFAULT 'system',
      from_status VARCHAR(20),
      to_status VARCHAR(20),
      actor_mode VARCHAR(30) DEFAULT 'system',
      actor_id VARCHAR(120),
      actor_name VARCHAR(120),
      details JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      FOREIGN KEY (app_id) REFERENCES applications(id) ON DELETE SET NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_purchase_events_order_created_at
    ON purchase_events(order_no, created_at DESC)
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS operation_logs (
      id BIGSERIAL PRIMARY KEY,
      actor_mode VARCHAR(20) NOT NULL,
      actor_id VARCHAR(120),
      actor_name VARCHAR(120),
      action VARCHAR(100) NOT NULL,
      target_type VARCHAR(50) NOT NULL,
      target_id VARCHAR(120),
      details JSONB,
      ip_address VARCHAR(64),
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at
    ON operation_logs(created_at DESC)
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS app_release_versions (
      id BIGSERIAL PRIMARY KEY,
      app_id VARCHAR(50) NOT NULL,
      type VARCHAR(20) NOT NULL,
      version VARCHAR(50),
      file_path VARCHAR(500),
      file_name VARCHAR(200),
      file_size BIGINT,
      sha256 VARCHAR(64),
      download_url VARCHAR(500),
      web_url VARCHAR(500),
      is_current BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW(),
      FOREIGN KEY (app_id) REFERENCES applications(id) ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_app_release_versions_lookup
    ON app_release_versions(app_id, type, created_at DESC)
  `);

  await query(`
    ALTER TABLE app_releases
    ADD COLUMN IF NOT EXISTS sha256 VARCHAR(64)
  `);

  await query(`
    ALTER TABLE app_release_versions
    ADD COLUMN IF NOT EXISTS sha256 VARCHAR(64)
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS release_download_logs (
      id BIGSERIAL PRIMARY KEY,
      app_id VARCHAR(50) NOT NULL,
      type VARCHAR(20) NOT NULL,
      version_id BIGINT,
      version VARCHAR(50),
      download_kind VARCHAR(20) NOT NULL,
      file_name VARCHAR(200),
      target_url VARCHAR(500),
      referer TEXT,
      ip_address VARCHAR(64),
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      FOREIGN KEY (app_id) REFERENCES applications(id) ON DELETE CASCADE,
      FOREIGN KEY (version_id) REFERENCES app_release_versions(id) ON DELETE SET NULL
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_release_download_logs_release
    ON release_download_logs(app_id, type, created_at DESC)
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_release_download_logs_version
    ON release_download_logs(version_id, created_at DESC)
  `);

  await query(`
    ALTER TABLE landing_pages
    ADD COLUMN IF NOT EXISTS draft_html_path VARCHAR(500)
  `);

  await query(`
    ALTER TABLE landing_pages
    ADD COLUMN IF NOT EXISTS published_html_path VARCHAR(500)
  `);

  await query(`
    ALTER TABLE landing_pages
    ADD COLUMN IF NOT EXISTS draft_updated_at TIMESTAMP
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS landing_page_versions (
      id BIGSERIAL PRIMARY KEY,
      app_id VARCHAR(50) NOT NULL,
      slug_snapshot VARCHAR(100),
      html_path VARCHAR(500) NOT NULL,
      is_current BOOLEAN DEFAULT false,
      published_at TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW(),
      FOREIGN KEY (app_id) REFERENCES applications(id) ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_landing_page_versions_lookup
    ON landing_page_versions(app_id, published_at DESC)
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS user_app_memberships (
      id BIGSERIAL PRIMARY KEY,
      user_id VARCHAR(100) NOT NULL,
      app_id VARCHAR(50) NOT NULL,
      status VARCHAR(20) DEFAULT 'active',
      register_source VARCHAR(50) DEFAULT 'self_service_phone',
      created_at TIMESTAMP DEFAULT NOW(),
      last_login_at TIMESTAMP,
      UNIQUE(user_id, app_id),
      FOREIGN KEY (app_id) REFERENCES applications(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_user_app_memberships_user
    ON user_app_memberships(user_id, app_id)
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_user_app_memberships_app
    ON user_app_memberships(app_id, created_at DESC)
  `);

  await query(`
    ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true
  `);

  await query(`
    ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMP
  `);

  await query(`
    ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS revoked_reason VARCHAR(50)
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS user_events (
      id BIGSERIAL PRIMARY KEY,
      user_id VARCHAR(100) NOT NULL,
      app_id VARCHAR(50),
      event_type VARCHAR(50) NOT NULL,
      event_source VARCHAR(50) DEFAULT 'system',
      actor_mode VARCHAR(30) DEFAULT 'system',
      actor_id VARCHAR(120),
      actor_name VARCHAR(120),
      details JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      FOREIGN KEY (app_id) REFERENCES applications(id) ON DELETE SET NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_user_events_user_created_at
    ON user_events(user_id, created_at DESC)
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS app_plans (
      id BIGSERIAL PRIMARY KEY,
      app_id VARCHAR(50) NOT NULL,
      code VARCHAR(50) NOT NULL,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      duration_days INTEGER,
      price DECIMAL(10, 2) NOT NULL DEFAULT 0,
      original_price DECIMAL(10, 2),
      currency VARCHAR(10) NOT NULL DEFAULT 'CNY',
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_trial BOOLEAN NOT NULL DEFAULT false,
      is_renewable BOOLEAN NOT NULL DEFAULT false,
      features JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      FOREIGN KEY (app_id) REFERENCES applications(id) ON DELETE CASCADE,
      UNIQUE(app_id, code)
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_app_plans_lookup
    ON app_plans(app_id, status, sort_order, created_at DESC)
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS verification_codes (
      id BIGSERIAL PRIMARY KEY,
      app_id VARCHAR(50) NOT NULL,
      phone VARCHAR(30) NOT NULL,
      purpose VARCHAR(30) NOT NULL,
      code VARCHAR(20) NOT NULL,
      mode VARCHAR(20) NOT NULL DEFAULT 'dev',
      provider VARCHAR(50) NOT NULL DEFAULT 'dev',
      send_status VARCHAR(20) NOT NULL DEFAULT 'pending',
      provider_request_id VARCHAR(120),
      provider_serial_no VARCHAR(120),
      error_message TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      consumed_reason VARCHAR(30),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      FOREIGN KEY (app_id) REFERENCES applications(id) ON DELETE CASCADE
    )
  `);

  await query(`
    ALTER TABLE verification_codes
    ALTER COLUMN expires_at TYPE TIMESTAMPTZ
    USING expires_at AT TIME ZONE 'UTC'
  `);

  await query(`
    ALTER TABLE verification_codes
    ALTER COLUMN consumed_at TYPE TIMESTAMPTZ
    USING consumed_at AT TIME ZONE 'UTC'
  `);

  await query(`
    ALTER TABLE verification_codes
    ALTER COLUMN created_at TYPE TIMESTAMPTZ
    USING created_at AT TIME ZONE 'UTC'
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_verification_codes_lookup
    ON verification_codes(app_id, phone, purpose, created_at DESC)
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS redeem_code_batches (
      id BIGSERIAL PRIMARY KEY,
      batch_no VARCHAR(40) UNIQUE NOT NULL,
      app_id VARCHAR(50) NOT NULL,
      plan_code VARCHAR(50) NOT NULL,
      quantity INTEGER NOT NULL,
      channel VARCHAR(100),
      valid_from TIMESTAMP,
      valid_until TIMESTAMP,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      notes TEXT,
      created_by VARCHAR(120),
      created_at TIMESTAMP DEFAULT NOW(),
      FOREIGN KEY (app_id) REFERENCES applications(id) ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_redeem_code_batches_app_created_at
    ON redeem_code_batches(app_id, created_at DESC)
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_redeem_code_batches_status_window
    ON redeem_code_batches(status, valid_from, valid_until, created_at DESC)
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_redeem_code_batches_channel_plan
    ON redeem_code_batches(app_id, channel, plan_code, created_at DESC)
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS redeem_codes (
      id BIGSERIAL PRIMARY KEY,
      batch_id BIGINT NOT NULL,
      code_plain VARCHAR(80) NOT NULL,
      code_hash VARCHAR(64) UNIQUE NOT NULL,
      code_preview VARCHAR(20) NOT NULL,
      app_id VARCHAR(50) NOT NULL,
      plan_code VARCHAR(50) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'unused',
      redeemed_by_user_id VARCHAR(100),
      redeemed_at TIMESTAMP,
      purchase_id INTEGER,
      external_order_no VARCHAR(120),
      created_at TIMESTAMP DEFAULT NOW(),
      FOREIGN KEY (batch_id) REFERENCES redeem_code_batches(id) ON DELETE CASCADE,
      FOREIGN KEY (app_id) REFERENCES applications(id) ON DELETE CASCADE,
      FOREIGN KEY (redeemed_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE SET NULL
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_redeem_codes_batch_created_at
    ON redeem_codes(batch_id, created_at DESC)
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_redeem_codes_batch_status_created_at
    ON redeem_codes(batch_id, status, created_at DESC)
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_redeem_codes_app_plan_status_created_at
    ON redeem_codes(app_id, plan_code, status, created_at DESC)
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_redeem_codes_user_created_at
    ON redeem_codes(redeemed_by_user_id, redeemed_at DESC)
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS redeem_events (
      id BIGSERIAL PRIMARY KEY,
      code_id BIGINT,
      batch_id BIGINT,
      event_type VARCHAR(40) NOT NULL,
      operator_id VARCHAR(120),
      user_id VARCHAR(100),
      payload JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      FOREIGN KEY (code_id) REFERENCES redeem_codes(id) ON DELETE SET NULL,
      FOREIGN KEY (batch_id) REFERENCES redeem_code_batches(id) ON DELETE SET NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_redeem_events_batch_created_at
    ON redeem_events(batch_id, created_at DESC)
  `);
}

module.exports = {
  ensureRuntimeSchema,
};
