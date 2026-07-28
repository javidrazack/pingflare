import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const WRANGLER = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const DATABASE = 'DB'
export const LEGACY_MIGRATIONS = [
  '0000_init.sql',
  '0001_flat_anthem.sql',
  '0002_cultured_kate_bishop.sql',
  '0003_dusty_eternity.sql',
  '0004_wandering_mulholland_black.sql',
]
const LEGACY_MIGRATION = LEGACY_MIGRATIONS.at(-1)
const PREREQUISITE_MIGRATIONS = LEGACY_MIGRATIONS.slice(0, -1)

export const LEGACY_TABLES = [
  'monitors',
  'status_logs',
  'incidents',
  'notification_channels',
  'monitor_notifications',
  'heartbeat_tokens',
  'alert_state',
  'incident_monitors',
  'incident_reports',
  'incident_updates',
  'settings',
  'status_page_monitors',
  'status_pages',
  'maintenance_windows',
  'incident_report_events',
  'notification_test_runs',
]

export const LEGACY_INDEXES = [
  'heartbeat_tokens_token_unique',
  'status_pages_slug_unique',
  'idx_monitors_active',
  'idx_sl_monitor_checked',
  'idx_sl_checked_at',
  'idx_notification_tests_channel_created',
  'idx_monitors_status',
  'idx_monitors_type',
  'idx_monitors_updated',
]

// These are every column added after the base CREATE TABLE statements in the
// v1.6 migration chain (plus show_all_monitors, which old ensureSchema also
// repaired). Requiring them prevents a partial compatibility schema from being
// stamped as fully migrated.
export const LEGACY_ADDED_COLUMNS = {
  monitors: [
    'ssl_check_enabled',
    'ssl_status',
    'cache_booster',
    'dns_hostname',
    'dns_record_type',
    'dns_resolver_url',
    'dns_expected_ip',
    'json_path',
    'expected_value',
    'cpu_threshold',
    'ram_threshold',
    'disk_threshold',
    'last_metrics',
  ],
  notification_channels: ['is_default'],
  status_logs: ['colo', 'country_code', 'origin_ip'],
  status_pages: [
    'show_all_monitors',
    'logo_url',
    'brand_color',
    'theme',
    'show_response_time',
    'show_uptime',
    'history_days',
    'seo_title',
    'seo_description',
  ],
  incident_reports: ['visibility', 'impact', 'published_at'],
}

const FINAL_LEGACY_TABLES = [
  'incident_report_events',
  'notification_test_runs',
]
const FINAL_LEGACY_INDEXES = [
  'idx_notification_tests_channel_created',
  'idx_monitors_status',
  'idx_monitors_type',
  'idx_monitors_updated',
]
const FINAL_LEGACY_COLUMNS = {
  status_pages: LEGACY_ADDED_COLUMNS.status_pages.filter(
    (column) => column !== 'show_all_monitors',
  ),
  incident_reports: LEGACY_ADDED_COLUMNS.incident_reports,
}

const POST_V1_6_TABLES = [
  'monitor_daily_rollups',
  'scheduler_leases',
  'notification_deliveries',
  'quota_budgets',
  'incident_feed_monitor_counts',
]
const POST_V1_6_INDEXES = [
  'idx_monitor_daily_day',
  'idx_incident_monitors_monitor',
  'idx_incident_report_events_event',
  'idx_incident_updates_incident_created',
  'idx_incident_updates_incident_created_id',
  'idx_maintenance_monitor_window',
  'notification_deliveries_dedupe_key_unique',
  'idx_notification_deliveries_due',
  'idx_notification_deliveries_monitor',
  'idx_monitors_active_next_check',
  'idx_incidents_one_open',
  'idx_incidents_monitor_started',
  'idx_incidents_monitor_started_id',
  'idx_incident_reports_public_feed',
]
const POST_V1_6_COLUMNS = {
  monitors: [
    'history_revision',
    'stats_day',
    'day_checks',
    'day_up_count',
    'day_down_count',
    'day_response_count',
    'day_response_sum_ms',
    'day_response_min_ms',
    'day_response_max_ms',
    'next_check_at',
    'observation_revision',
  ],
  status_logs: ['source'],
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function valuesSql(rows) {
  return rows.map((row) =>
    `(${row.map(sqlString).join(', ')})`,
  ).join(',\n      ')
}

function presentColumnsSql(tables) {
  return tables.map((table) => `
    SELECT ${sqlString(table)} AS table_name, name AS column_name
    FROM pragma_table_info(${sqlString(table)})`).join('\n    UNION ALL')
}

export function buildLegacySchemaInspectionSql() {
  const expectedColumns = Object.entries(LEGACY_ADDED_COLUMNS)
    .flatMap(([table, columns]) => columns.map((column) => [table, column]))
  const postColumns = Object.entries(POST_V1_6_COLUMNS)
    .flatMap(([table, columns]) => columns.map((column) => [table, column]))
  const finalColumns = Object.entries(FINAL_LEGACY_COLUMNS)
    .flatMap(([table, columns]) => columns.map((column) => [table, column]))
  const columnTables = [...new Set([
    ...Object.keys(LEGACY_ADDED_COLUMNS),
    ...Object.keys(POST_V1_6_COLUMNS),
  ])]

  return `
    WITH
    expected_tables(name) AS (
      VALUES ${valuesSql(LEGACY_TABLES.map((name) => [name]))}
    ),
    expected_indexes(name) AS (
      VALUES ${valuesSql(LEGACY_INDEXES.map((name) => [name]))}
    ),
    expected_columns(table_name, column_name) AS (
      VALUES ${valuesSql(expectedColumns)}
    ),
    post_tables(name) AS (
      VALUES ${valuesSql(POST_V1_6_TABLES.map((name) => [name]))}
    ),
    post_indexes(name) AS (
      VALUES ${valuesSql(POST_V1_6_INDEXES.map((name) => [name]))}
    ),
    post_columns(table_name, column_name) AS (
      VALUES ${valuesSql(postColumns)}
    ),
    final_tables(name) AS (
      VALUES ${valuesSql(FINAL_LEGACY_TABLES.map((name) => [name]))}
    ),
    final_indexes(name) AS (
      VALUES ${valuesSql(FINAL_LEGACY_INDEXES.map((name) => [name]))}
    ),
    final_columns(table_name, column_name) AS (
      VALUES ${valuesSql(finalColumns)}
    ),
    present_columns(table_name, column_name) AS (
      ${presentColumnsSql(columnTables)}
    )
    SELECT
      (
        SELECT COUNT(*)
        FROM expected_tables AS expected
        JOIN sqlite_master AS present
          ON present.type = 'table' AND present.name = expected.name
      ) AS table_count,
      (
        SELECT COUNT(*)
        FROM expected_indexes AS expected
        JOIN sqlite_master AS present
          ON present.type = 'index' AND present.name = expected.name
      ) AS index_count,
      (
        SELECT COUNT(*)
        FROM expected_columns AS expected
        JOIN present_columns AS present
          ON present.table_name = expected.table_name
          AND present.column_name = expected.column_name
      ) AS column_count,
      (
        SELECT COUNT(*)
        FROM post_tables AS post
        JOIN sqlite_master AS present
          ON present.type = 'table' AND present.name = post.name
      ) + (
        SELECT COUNT(*)
        FROM post_columns AS post
        JOIN present_columns AS present
          ON present.table_name = post.table_name
          AND present.column_name = post.column_name
      ) + (
        SELECT COUNT(*)
        FROM post_indexes AS post
        JOIN sqlite_master AS present
          ON present.type = 'index' AND present.name = post.name
      ) AS post_legacy_count,
      (
        SELECT COUNT(*)
        FROM final_tables AS expected
        JOIN sqlite_master AS present
          ON present.type = 'table' AND present.name = expected.name
      ) + (
        SELECT COUNT(*)
        FROM final_indexes AS expected
        JOIN sqlite_master AS present
          ON present.type = 'index' AND present.name = expected.name
      ) + (
        SELECT COUNT(*)
        FROM final_columns AS expected
        JOIN present_columns AS present
          ON present.table_name = expected.table_name
          AND present.column_name = expected.column_name
      ) AS final_migration_count
  `
}

export const EXPECTED_LEGACY_COLUMN_COUNT = Object.values(
  LEGACY_ADDED_COLUMNS,
).reduce((total, columns) => total + columns.length, 0)

function firstRow(result) {
  return result[0]?.results?.[0]
}

export function isCompleteLegacySchema(metrics) {
  return Number(metrics?.table_count ?? 0) === LEGACY_TABLES.length
    && Number(metrics?.index_count ?? 0) === LEGACY_INDEXES.length
    && Number(metrics?.column_count ?? 0) === EXPECTED_LEGACY_COLUMN_COUNT
}

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

function createLedgerSql(migrations) {
  const rows = migrations.map((name) => `(${sqlString(name)})`).join(', ')
  return `
    CREATE TABLE IF NOT EXISTS d1_migrations(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    INSERT OR IGNORE INTO d1_migrations (name) VALUES ${rows};
  `
}

export const MAX_SAFE_MIGRATION_D1_WRITES = 40_000

const PENDING_INDEX_BUILDS = [
  { name: 'idx_monitor_daily_day', table: 'monitor_daily_rollups' },
  { name: 'idx_incident_monitors_monitor', table: 'incident_monitors' },
  { name: 'idx_incident_report_events_event', table: 'incident_report_events' },
  { name: 'idx_maintenance_monitor_window', table: 'maintenance_windows' },
  {
    name: 'notification_deliveries_dedupe_key_unique',
    table: 'notification_deliveries',
  },
  { name: 'idx_notification_deliveries_due', table: 'notification_deliveries' },
  { name: 'idx_notification_deliveries_monitor', table: 'notification_deliveries' },
  { name: 'idx_monitors_active_next_check', table: 'monitors' },
  {
    name: 'idx_incidents_one_open',
    table: 'incidents',
    where: 'resolved_at IS NULL',
  },
  {
    name: 'idx_incident_updates_incident_created_id',
    table: 'incident_updates',
  },
  { name: 'idx_incidents_monitor_started_id', table: 'incidents' },
]

const RELEASED_INCIDENT_INDEX_MIGRATION = '0006_remarkable_johnny_blaze.sql'
const BOUNDED_INCIDENT_FEED_MIGRATION = '0010_bounded_incident_feed.sql'
const OBSOLETE_INCIDENT_INDEXES = [
  { name: 'idx_incident_updates_incident_created', table: 'incident_updates' },
  { name: 'idx_incidents_monitor_started', table: 'incidents' },
  { name: 'idx_incidents_monitor_resolved', table: 'incidents' },
]

function resultRows(result) {
  return result[0]?.results ?? []
}

/**
 * D1 bills index entries as writes. Inspect every post-v1.6 index that may be
 * built or removed by a pending migration and stop before any DDL when their
 * combined source rows (plus migration backfills) exceed the safety envelope.
 */
export function assertPendingMigrationWriteBudgetSafe(execute) {
  const objectNames = [
    ...new Set([
      ...PENDING_INDEX_BUILDS.flatMap(({ name, table }) => [name, table]),
      ...OBSOLETE_INCIDENT_INDEXES.flatMap(({ name, table }) => [name, table]),
      'incident_feed_monitor_counts',
      'd1_migrations',
    ]),
  ]
  const objects = resultRows(execute(`
    SELECT type, name
    FROM sqlite_master
    WHERE name IN (${objectNames.map(sqlString).join(', ')})
  `))
  const existingTables = new Set(
    objects.filter((row) => row.type === 'table').map((row) => row.name),
  )
  const existingIndexes = new Set(
    objects.filter((row) => row.type === 'index').map((row) => row.name),
  )
  const pendingIndexes = PENDING_INDEX_BUILDS.filter(
    ({ name, table }) => existingTables.has(table) && !existingIndexes.has(name),
  )
  const appliedMigrations = existingTables.has('d1_migrations')
    ? new Set(resultRows(execute(`
        SELECT name
        FROM d1_migrations
        WHERE name IN (
          ${sqlString(RELEASED_INCIDENT_INDEX_MIGRATION)},
          ${sqlString(BOUNDED_INCIDENT_FEED_MIGRATION)}
        )
      `)).map((row) => row.name))
    : new Set()
  const releasedIncidentIndexesPending = !appliedMigrations.has(
    RELEASED_INCIDENT_INDEX_MIGRATION,
  )
  const obsoleteIncidentIndexCleanupPending = !appliedMigrations.has(
    BOUNDED_INCIDENT_FEED_MIGRATION,
  )

  const work = pendingIndexes.map((spec) => ({
    label: `index ${spec.name}`,
    sql: `SELECT COUNT(*) FROM ${spec.table}${spec.where ? ` WHERE ${spec.where}` : ''}`,
    weight: 1,
  }))
  if (obsoleteIncidentIndexCleanupPending) {
    for (const spec of OBSOLETE_INCIDENT_INDEXES) {
      if (!existingTables.has(spec.table)) continue
      const indexExists = existingIndexes.has(spec.name)
      if (!indexExists && !releasedIncidentIndexesPending) continue
      work.push({
        label: indexExists
          ? `obsolete index ${spec.name} cleanup`
          : `transient index ${spec.name} build and cleanup`,
        sql: `SELECT COUNT(*) FROM ${spec.table}`,
        weight: indexExists ? 1 : 2,
      })
    }
  }
  if (
    existingTables.has('incident_monitors')
    && !existingTables.has('incident_feed_monitor_counts')
  ) {
    work.push({
      label: 'incident-feed counter backfill',
      sql: 'SELECT COUNT(DISTINCT monitor_id) FROM incident_monitors',
      weight: 2,
    })
  }
  if (!existingIndexes.has('idx_monitors_active_next_check') && existingTables.has('monitors')) {
    work.push({
      label: 'scheduler cursor backfill',
      sql: 'SELECT COUNT(*) FROM monitors WHERE last_checked_at IS NOT NULL',
      weight: 2,
    })
  }
  if (!existingIndexes.has('idx_incidents_one_open') && existingTables.has('incidents')) {
    work.push({
      label: 'duplicate-open-incident repair',
      sql: 'SELECT COUNT(*) FROM incidents WHERE resolved_at IS NULL',
      weight: 2,
    })
  }
  if (work.length === 0) return 0

  const counts = firstRow(execute(`
    SELECT
      ${work.map((item, index) => `(${item.sql}) AS work_${index}`).join(',\n      ')}
  `))
  const estimates = work.map((item, index) => {
    const count = Number(counts?.[`work_${index}`])
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(
        `Could not verify the D1 migration write budget for ${item.label}; `
        + 'deployment stopped before changing the schema.',
      )
    }
    return {
      label: item.label,
      writes: count * item.weight,
    }
  })
  const total = estimates.reduce((sum, item) => sum + item.writes, 0)
  if (total > MAX_SAFE_MIGRATION_D1_WRITES) {
    const largest = estimates
      .filter((item) => item.writes > 0)
      .sort((left, right) => right.writes - left.writes)
      .slice(0, 3)
      .map((item) => `${item.label}: ${item.writes.toLocaleString('en-US')}`)
      .join('; ')
    throw new Error(
      `Pending migrations would require about ${total.toLocaleString('en-US')} `
      + `indexed D1 row writes (${largest}). This exceeds the `
      + `${MAX_SAFE_MIGRATION_D1_WRITES.toLocaleString('en-US')} deployment `
      + 'safety limit, so deployment stopped before changing the schema. '
      + 'Archive data or temporarily use paid D1 before retrying.',
    )
  }
  return total
}

export function reconcileLegacyMigration(execute = executeJson) {
  const state = firstRow(execute(`
    SELECT
      EXISTS(
        SELECT 1 FROM sqlite_master
        WHERE type = 'table' AND name = 'd1_migrations'
      ) AS ledger_exists,
      (
        SELECT COUNT(*) FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
          AND name <> 'd1_migrations'
      ) AS application_table_count
  `))

  if (!state?.ledger_exists) {
    if (Number(state?.application_table_count ?? 0) === 0) {
      console.log('[deploy] Fresh D1 database; no legacy migration reconciliation needed.')
      return 'fresh'
    }

    const metrics = firstRow(execute(buildLegacySchemaInspectionSql()))
    if (
      !isCompleteLegacySchema(metrics)
      || Number(metrics?.post_legacy_count ?? 0) !== 0
    ) {
      throw new Error(
        'D1 has a non-empty ledgerless schema that is not an exact v1.6 compatibility schema '
        + `(${Number(metrics?.table_count ?? 0)}/${LEGACY_TABLES.length} tables, `
        + `${Number(metrics?.index_count ?? 0)}/${LEGACY_INDEXES.length} indexes, `
        + `${Number(metrics?.column_count ?? 0)}/${EXPECTED_LEGACY_COLUMN_COUNT} upgraded columns, `
        + `${Number(metrics?.post_legacy_count ?? 0)} post-v1.6 objects). `
        + 'Deployment stopped without changing the database.',
      )
    }

    assertPendingMigrationWriteBudgetSafe(execute)
    execute(createLedgerSql(LEGACY_MIGRATIONS))
    console.log(
      `[deploy] Created the Wrangler ledger and recorded verified v1.6 migrations 0000-0004.`,
    )
    return 'ledger-created'
  }

  assertPendingMigrationWriteBudgetSafe(execute)
  const ledgerResult = execute(`
    SELECT name
    FROM d1_migrations
    WHERE name IN (${LEGACY_MIGRATIONS.map(sqlString).join(', ')})
  `)
  const applied = new Set(ledgerResult[0]?.results?.map((row) => row.name) ?? [])

  if (applied.has(LEGACY_MIGRATION)) {
    console.log('[deploy] Legacy migration ledger is already consistent.')
    return 'consistent'
  }

  const metrics = firstRow(execute(buildLegacySchemaInspectionSql()))
  const hasNoLegacyUpgradeObjects = Number(metrics?.final_migration_count ?? 0) === 0
  if (hasNoLegacyUpgradeObjects) {
    console.log('[deploy] Legacy migration is pending and Wrangler will apply it normally.')
    return 'pending'
  }

  const prerequisitesApplied = PREREQUISITE_MIGRATIONS.every((name) => applied.has(name))
  if (!prerequisitesApplied || !isCompleteLegacySchema(metrics)) {
    throw new Error(
      'D1 has a partial legacy schema. Deployment stopped without changing the migration ledger.',
    )
  }

  execute(`
    INSERT OR IGNORE INTO d1_migrations (name)
    VALUES (${sqlString(LEGACY_MIGRATION)})
  `)
  console.log(`[deploy] Recorded ${LEGACY_MIGRATION}: the complete v1.6 schema already existed.`)
  return 'legacy-recorded'
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  reconcileLegacyMigration()
}
