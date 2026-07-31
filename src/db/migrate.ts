let migrated = false
let migrationPromise: Promise<void> | null = null

/** For use in tests only, resets the migration flag so a fresh in-memory DB can be initialized. */
export function resetMigratedFlag(): void {
  migrated = false
  migrationPromise = null
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS monitors (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  type text NOT NULL,
  tags text DEFAULT '[]' NOT NULL,
  interval integer DEFAULT 60 NOT NULL,
  active integer DEFAULT true NOT NULL,
  last_checked_at integer,
  next_check_at integer DEFAULT 0 NOT NULL,
  observation_revision text DEFAULT '' NOT NULL,
  last_status text DEFAULT 'pending' NOT NULL,
  reminder_interval_hours integer,
  tolerance_failures integer DEFAULT 1 NOT NULL,
  url text,
  method text DEFAULT 'GET' NOT NULL,
  body text,
  headers text DEFAULT '{}' NOT NULL,
  expected_status integer DEFAULT 200 NOT NULL,
  follow_redirects integer DEFAULT true NOT NULL,
  timeout integer DEFAULT 30 NOT NULL,
  ip_version text DEFAULT 'auto' NOT NULL,
  auth_type text DEFAULT 'none' NOT NULL,
  auth_username text,
  auth_password text,
  auth_token text,
  heartbeat_interval integer,
  heartbeat_grace integer DEFAULT 30 NOT NULL,
  tolerance_missed integer DEFAULT 1 NOT NULL,
  surge_protection_limit integer,
  ssl_check_enabled integer DEFAULT false NOT NULL,
  ssl_status text DEFAULT 'unknown' NOT NULL,
  cache_booster integer DEFAULT false NOT NULL,
  json_path text,
  expected_value text,
  cpu_threshold integer,
  ram_threshold integer,
  disk_threshold integer,
  last_metrics text,
  dns_hostname text,
  dns_record_type text DEFAULT 'A',
  dns_resolver_url text,
  dns_expected_ip text,
  history_revision integer DEFAULT 1 NOT NULL,
  stats_day integer,
  day_checks integer DEFAULT 0 NOT NULL,
  day_up_count integer DEFAULT 0 NOT NULL,
  day_down_count integer DEFAULT 0 NOT NULL,
  day_response_count integer DEFAULT 0 NOT NULL,
  day_response_sum_ms integer DEFAULT 0 NOT NULL,
  day_response_min_ms integer,
  day_response_max_ms integer,
  created_at integer DEFAULT (unixepoch()) NOT NULL,
  updated_at integer DEFAULT (unixepoch()) NOT NULL
);

CREATE TABLE IF NOT EXISTS status_logs (
  id text PRIMARY KEY NOT NULL,
  monitor_id text NOT NULL,
  status text NOT NULL,
  message text,
  response_time_ms integer,
  checked_at integer NOT NULL,
  colo text,
  country_code text,
  origin_ip text,
  source text,
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS monitor_daily_rollups (
  monitor_id text NOT NULL,
  day integer NOT NULL,
  checks integer DEFAULT 0 NOT NULL,
  up_count integer DEFAULT 0 NOT NULL,
  down_count integer DEFAULT 0 NOT NULL,
  response_count integer DEFAULT 0 NOT NULL,
  response_sum_ms integer DEFAULT 0 NOT NULL,
  response_min_ms integer,
  response_max_ms integer,
  PRIMARY KEY(monitor_id, day),
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS idx_monitor_daily_day ON monitor_daily_rollups (day);

CREATE TABLE IF NOT EXISTS agent_metric_samples (
  monitor_id text NOT NULL,
  sampled_at integer NOT NULL,
  cpu_basis_points integer NOT NULL,
  ram_basis_points integer NOT NULL,
  disk_basis_points integer NOT NULL,
  PRIMARY KEY(monitor_id, sampled_at),
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS scheduler_leases (
  name text PRIMARY KEY NOT NULL,
  holder text NOT NULL,
  lease_until integer NOT NULL,
  updated_at integer NOT NULL
);

CREATE TABLE IF NOT EXISTS quota_budgets (
  key text PRIMARY KEY NOT NULL,
  day integer NOT NULL,
  used integer DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS incidents (
  id text PRIMARY KEY NOT NULL,
  monitor_id text NOT NULL,
  started_at integer NOT NULL,
  resolved_at integer,
  duration_seconds integer,
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS notification_channels (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  type text NOT NULL,
  config text DEFAULT '{}' NOT NULL,
  active integer DEFAULT true NOT NULL,
  is_default integer DEFAULT false NOT NULL,
  created_at integer DEFAULT (unixepoch()) NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id text PRIMARY KEY NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  monitor_id text NOT NULL,
  event_type text NOT NULL,
  payload text NOT NULL,
  remaining_channel_ids text NOT NULL,
  attempts integer DEFAULT 0 NOT NULL,
  delivered_count integer DEFAULT 0 NOT NULL,
  state_applied integer DEFAULT false NOT NULL,
  next_attempt_at integer NOT NULL,
  claim_token text,
  claim_until integer,
  last_error text,
  created_at integer DEFAULT (unixepoch()) NOT NULL,
  updated_at integer DEFAULT (unixepoch()) NOT NULL,
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_due
  ON notification_deliveries (next_attempt_at, claim_until);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_monitor
  ON notification_deliveries (monitor_id, created_at);

CREATE TABLE IF NOT EXISTS monitor_notifications (
  monitor_id text NOT NULL,
  channel_id text NOT NULL,
  PRIMARY KEY(monitor_id, channel_id),
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (channel_id) REFERENCES notification_channels(id) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS heartbeat_tokens (
  monitor_id text PRIMARY KEY NOT NULL,
  token text NOT NULL,
  last_ping_at integer,
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON UPDATE no action ON DELETE cascade
);

CREATE UNIQUE INDEX IF NOT EXISTS heartbeat_tokens_token_unique ON heartbeat_tokens (token);

CREATE INDEX IF NOT EXISTS idx_sl_monitor_checked ON status_logs (monitor_id, checked_at);
CREATE INDEX IF NOT EXISTS idx_sl_checked_at ON status_logs (checked_at);
CREATE INDEX IF NOT EXISTS idx_monitors_active ON monitors (active);
CREATE INDEX IF NOT EXISTS idx_monitors_status ON monitors (last_status);
CREATE INDEX IF NOT EXISTS idx_monitors_type ON monitors (type);
CREATE INDEX IF NOT EXISTS idx_monitors_updated ON monitors (updated_at);

CREATE TABLE IF NOT EXISTS alert_state (
  monitor_id text PRIMARY KEY NOT NULL,
  consecutive_failures integer DEFAULT 0 NOT NULL,
  consecutive_missed integer DEFAULT 0 NOT NULL,
  alert_sent_at integer,
  consecutive_alerts integer DEFAULT 0 NOT NULL,
  last_reminder_at integer,
  surge_paused_until integer,
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY NOT NULL,
  value text NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('retention_days', '90');

CREATE TABLE IF NOT EXISTS status_pages (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  slug text NOT NULL,
  description text,
  password_hash text,
  show_all_monitors integer DEFAULT false NOT NULL,
  logo_url text,
  brand_color text DEFAULT '#B45309' NOT NULL,
  theme text DEFAULT 'system' NOT NULL,
  show_response_time integer DEFAULT true NOT NULL,
  show_uptime integer DEFAULT true NOT NULL,
  history_days integer DEFAULT 90 NOT NULL,
  seo_title text,
  seo_description text,
  created_at integer DEFAULT (unixepoch()) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS status_pages_slug_unique ON status_pages (slug);

CREATE TABLE IF NOT EXISTS status_page_monitors (
  page_id text NOT NULL,
  monitor_id text NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  PRIMARY KEY(page_id, monitor_id),
  FOREIGN KEY (page_id) REFERENCES status_pages(id) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS incident_reports (
  id text PRIMARY KEY NOT NULL,
  title text NOT NULL,
  status text NOT NULL,
  visibility text DEFAULT 'published' NOT NULL,
  impact text DEFAULT 'minor' NOT NULL,
  published_at integer,
  started_at integer DEFAULT (unixepoch()) NOT NULL,
  resolved_at integer
);

CREATE TABLE IF NOT EXISTS incident_updates (
  id text PRIMARY KEY NOT NULL,
  incident_id text NOT NULL,
  message text NOT NULL,
  status text NOT NULL,
  created_at integer DEFAULT (unixepoch()) NOT NULL,
  FOREIGN KEY (incident_id) REFERENCES incident_reports(id) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS incident_monitors (
  incident_id text NOT NULL,
  monitor_id text NOT NULL,
  PRIMARY KEY(incident_id, monitor_id),
  FOREIGN KEY (incident_id) REFERENCES incident_reports(id) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS incident_feed_monitor_counts (
  monitor_id text PRIMARY KEY NOT NULL,
  link_count integer DEFAULT 0 NOT NULL,
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON UPDATE no action ON DELETE cascade
);

INSERT OR IGNORE INTO incident_feed_monitor_counts (monitor_id, link_count)
SELECT monitor_id, COUNT(*)
FROM incident_monitors
GROUP BY monitor_id;

CREATE TABLE IF NOT EXISTS incident_report_events (
  incident_id text NOT NULL,
  event_id text NOT NULL,
  PRIMARY KEY(incident_id, event_id),
  FOREIGN KEY (incident_id) REFERENCES incident_reports(id) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (event_id) REFERENCES incidents(id) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE IF NOT EXISTS notification_test_runs (
  id text PRIMARY KEY NOT NULL,
  channel_id text NOT NULL,
  status text NOT NULL,
  latency_ms integer NOT NULL,
  error text,
  created_at integer DEFAULT (unixepoch()) NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES notification_channels(id) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS idx_notification_tests_channel_created
  ON notification_test_runs (channel_id, created_at);

CREATE TABLE IF NOT EXISTS maintenance_windows (
  id text PRIMARY KEY NOT NULL,
  monitor_id text NOT NULL,
  start_at integer NOT NULL,
  end_at integer NOT NULL,
  reason text,
  FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS idx_incident_monitors_monitor
  ON incident_monitors (monitor_id, incident_id);
CREATE INDEX IF NOT EXISTS idx_incident_report_events_event
  ON incident_report_events (event_id, incident_id);
CREATE INDEX IF NOT EXISTS idx_incident_updates_incident_created_id
  ON incident_updates (incident_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_maintenance_monitor_window
  ON maintenance_windows (monitor_id, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_incidents_monitor_started_id
  ON incidents (monitor_id, started_at, id);
`

const INCIDENT_FEED_TRIGGER_SQL = [
  `CREATE TRIGGER IF NOT EXISTS trg_incident_feed_count_insert
    AFTER INSERT ON incident_monitors
    BEGIN
      INSERT INTO incident_feed_monitor_counts (monitor_id, link_count)
      VALUES (NEW.monitor_id, 1)
      ON CONFLICT(monitor_id) DO UPDATE
      SET link_count = link_count + 1;
    END`,
  `CREATE TRIGGER IF NOT EXISTS trg_incident_feed_count_delete
    AFTER DELETE ON incident_monitors
    BEGIN
      UPDATE incident_feed_monitor_counts
      SET link_count = MAX(0, link_count - 1)
      WHERE monitor_id = OLD.monitor_id;
      DELETE FROM incident_feed_monitor_counts
      WHERE monitor_id = OLD.monitor_id AND link_count = 0;
    END`,
]

const AGENT_METRIC_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS trg_agent_metric_samples_retention
  AFTER INSERT ON agent_metric_samples
  BEGIN
    DELETE FROM agent_metric_samples
    WHERE monitor_id = NEW.monitor_id
      AND sampled_at = (
        SELECT MIN(sampled_at)
        FROM agent_metric_samples
        WHERE monitor_id = NEW.monitor_id
          AND sampled_at < NEW.sampled_at - 2592000
      );
  END
`

export async function ensureSchema(d1: D1Database): Promise<void> {
  if (migrated) return
  if (!migrationPromise) {
    migrationPromise = (async () => {
      const statements = SCHEMA_SQL
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0)
      await d1.batch(statements.map(s => d1.prepare(s)))
      for (const triggerSql of INCIDENT_FEED_TRIGGER_SQL) {
        await d1.prepare(triggerSql).run()
      }
      await d1.prepare(AGENT_METRIC_TRIGGER_SQL).run()

      const alterStatements = [
        `ALTER TABLE status_pages ADD COLUMN show_all_monitors integer DEFAULT false NOT NULL`,
        `ALTER TABLE notification_channels ADD COLUMN is_default integer DEFAULT false NOT NULL`,
        `ALTER TABLE monitors ADD COLUMN ssl_check_enabled integer DEFAULT false NOT NULL`,
        `ALTER TABLE monitors ADD COLUMN ssl_status text DEFAULT 'unknown' NOT NULL`,
        `ALTER TABLE monitors ADD COLUMN cache_booster integer DEFAULT false NOT NULL`,
        `ALTER TABLE status_logs ADD COLUMN colo text`,
        `ALTER TABLE status_logs ADD COLUMN country_code text`,
        `ALTER TABLE status_logs ADD COLUMN origin_ip text`,
        `ALTER TABLE monitors ADD COLUMN dns_hostname text`,
        `ALTER TABLE monitors ADD COLUMN dns_record_type text DEFAULT 'A'`,
        `ALTER TABLE monitors ADD COLUMN dns_resolver_url text`,
        `ALTER TABLE monitors ADD COLUMN dns_expected_ip text`,
        `ALTER TABLE monitors ADD COLUMN json_path text`,
        `ALTER TABLE monitors ADD COLUMN expected_value text`,
        `ALTER TABLE monitors ADD COLUMN cpu_threshold integer`,
        `ALTER TABLE monitors ADD COLUMN ram_threshold integer`,
        `ALTER TABLE monitors ADD COLUMN disk_threshold integer`,
        `ALTER TABLE monitors ADD COLUMN last_metrics text`,
        `ALTER TABLE monitors ADD COLUMN next_check_at integer DEFAULT 0 NOT NULL`,
        `ALTER TABLE monitors ADD COLUMN observation_revision text DEFAULT '' NOT NULL`,
        `ALTER TABLE monitors ADD COLUMN history_revision integer DEFAULT 1 NOT NULL`,
        `ALTER TABLE monitors ADD COLUMN stats_day integer`,
        `ALTER TABLE monitors ADD COLUMN day_checks integer DEFAULT 0 NOT NULL`,
        `ALTER TABLE monitors ADD COLUMN day_up_count integer DEFAULT 0 NOT NULL`,
        `ALTER TABLE monitors ADD COLUMN day_down_count integer DEFAULT 0 NOT NULL`,
        `ALTER TABLE monitors ADD COLUMN day_response_count integer DEFAULT 0 NOT NULL`,
        `ALTER TABLE monitors ADD COLUMN day_response_sum_ms integer DEFAULT 0 NOT NULL`,
        `ALTER TABLE monitors ADD COLUMN day_response_min_ms integer`,
        `ALTER TABLE monitors ADD COLUMN day_response_max_ms integer`,
        `ALTER TABLE status_logs ADD COLUMN source text`,
        `ALTER TABLE status_pages ADD COLUMN logo_url text`,
        `ALTER TABLE status_pages ADD COLUMN brand_color text DEFAULT '#B45309' NOT NULL`,
        `ALTER TABLE status_pages ADD COLUMN theme text DEFAULT 'system' NOT NULL`,
        `ALTER TABLE status_pages ADD COLUMN show_response_time integer DEFAULT true NOT NULL`,
        `ALTER TABLE status_pages ADD COLUMN show_uptime integer DEFAULT true NOT NULL`,
        `ALTER TABLE status_pages ADD COLUMN history_days integer DEFAULT 90 NOT NULL`,
        `ALTER TABLE status_pages ADD COLUMN seo_title text`,
        `ALTER TABLE status_pages ADD COLUMN seo_description text`,
        `ALTER TABLE incident_reports ADD COLUMN visibility text DEFAULT 'published' NOT NULL`,
        `ALTER TABLE incident_reports ADD COLUMN impact text DEFAULT 'minor' NOT NULL`,
        `ALTER TABLE incident_reports ADD COLUMN published_at integer`,
      ]
      for (const sql of alterStatements) {
        try {
          await d1.prepare(sql).run()
        } catch (error) {
          if (!String(error).toLowerCase().includes('duplicate column')) throw error
        }
      }
      await d1.prepare(`
        UPDATE monitors
        SET next_check_at = last_checked_at + interval
        WHERE next_check_at = 0
          AND last_checked_at IS NOT NULL
      `).run()
      await d1.prepare(`
        CREATE INDEX IF NOT EXISTS idx_monitors_active_next_check
        ON monitors (active, next_check_at)
      `).run()
      await d1.prepare(`
        UPDATE incidents
        SET resolved_at = started_at, duration_seconds = 0
        WHERE id IN (
          SELECT id
          FROM (
            SELECT
              id,
              ROW_NUMBER() OVER (
                PARTITION BY monitor_id
                ORDER BY started_at, id
              ) AS open_rank
            FROM incidents
            WHERE resolved_at IS NULL
          )
          WHERE open_rank > 1
        )
      `).run()
      await d1.prepare(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_one_open
        ON incidents (monitor_id)
        WHERE resolved_at IS NULL
      `).run()
      const pendingLegacyLog = await d1.prepare(
        `SELECT 1 AS pending FROM status_logs WHERE source IS NULL LIMIT 1`,
      ).first<{ pending: number }>()
      if (!pendingLegacyLog) {
        await d1.prepare(`
          INSERT INTO settings (key, value)
          VALUES ('_schema_legacy_gap_catchup_v1', '1')
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run()
      }
      migrated = true
    })()
  }
  try {
    await migrationPromise
  } finally {
    migrationPromise = null
  }
}
