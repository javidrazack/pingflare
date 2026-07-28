import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WRANGLER = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const DATABASE = 'DB'
const LEGACY_MIGRATION = '0004_wandering_mulholland_black.sql'
const PREREQUISITE_MIGRATIONS = [
  '0000_init.sql',
  '0001_flat_anthem.sql',
  '0002_cultured_kate_bishop.sql',
  '0003_dusty_eternity.sql',
]
const EXPECTED_FEATURE_COUNT = 17

function executeJson(sql) {
  const result = spawnSync(WRANGLER, [
    '--no-install',
    'wrangler',
    'd1',
    'execute',
    DATABASE,
    '--remote',
    '--json',
    '--command',
    sql,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: join(tmpdir(), 'pingflare-wrangler-reconcile.log'),
    },
  })

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || 'Unknown Wrangler error').trim()
    throw new Error(`Could not inspect D1 migration state: ${detail}`)
  }
  return JSON.parse(result.stdout)
}

const schemaResult = executeJson(`
  SELECT
    EXISTS(
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'd1_migrations'
    ) AS ledger_exists,
    (
      SELECT COUNT(*) FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('incident_report_events', 'notification_test_runs')
    ) + (
      SELECT COUNT(*) FROM sqlite_master
      WHERE type = 'index'
        AND name IN (
          'idx_notification_tests_channel_created',
          'idx_monitors_status',
          'idx_monitors_type',
          'idx_monitors_updated'
        )
    ) + (
      SELECT COUNT(*) FROM pragma_table_info('incident_reports')
      WHERE name IN ('visibility', 'impact', 'published_at')
    ) + (
      SELECT COUNT(*) FROM pragma_table_info('status_pages')
      WHERE name IN (
        'logo_url',
        'brand_color',
        'theme',
        'show_response_time',
        'show_uptime',
        'history_days',
        'seo_title',
        'seo_description'
      )
    ) AS feature_count
`)
const schema = schemaResult[0]?.results?.[0]

if (!schema?.ledger_exists) {
  console.log('[deploy] Fresh D1 database; no legacy migration reconciliation needed.')
  process.exit(0)
}

const ledgerResult = executeJson(`
  SELECT name
  FROM d1_migrations
  WHERE name IN (
    '0000_init.sql',
    '0001_flat_anthem.sql',
    '0002_cultured_kate_bishop.sql',
    '0003_dusty_eternity.sql',
    '${LEGACY_MIGRATION}'
  )
`)
const applied = new Set(ledgerResult[0]?.results?.map((row) => row.name) ?? [])

if (applied.has(LEGACY_MIGRATION)) {
  console.log('[deploy] Legacy migration ledger is already consistent.')
  process.exit(0)
}

const featureCount = Number(schema.feature_count ?? 0)
if (featureCount === 0) {
  console.log('[deploy] Legacy migration is pending and its schema is not present; Wrangler will apply it normally.')
  process.exit(0)
}

const prerequisitesApplied = PREREQUISITE_MIGRATIONS.every((name) => applied.has(name))
if (!prerequisitesApplied || featureCount !== EXPECTED_FEATURE_COUNT) {
  throw new Error(
    `D1 has a partial legacy schema (${featureCount}/${EXPECTED_FEATURE_COUNT} expected objects). `
    + 'Deployment stopped without changing the migration ledger.',
  )
}

executeJson(`
  INSERT OR IGNORE INTO d1_migrations (name)
  VALUES ('${LEGACY_MIGRATION}')
`)
console.log(
  `[deploy] Recorded ${LEGACY_MIGRATION}: all ${EXPECTED_FEATURE_COUNT} schema objects already existed.`,
)
