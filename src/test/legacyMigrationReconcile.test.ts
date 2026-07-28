// @ts-nocheck -- exercises the production .mjs deploy helper through SQLite.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  LEGACY_MIGRATIONS,
  MAX_SAFE_MIGRATION_D1_WRITES,
  assertPendingMigrationWriteBudgetSafe,
  buildLegacySchemaInspectionSql,
  isCompleteLegacySchema,
  reconcileLegacyMigration,
} from '../../scripts/reconcile-legacy-migration.mjs'

const POST_V1_6_MIGRATIONS_BEFORE_BOUNDED_FEED = [
  '0005_flimsy_quicksilver.sql',
  '0006_remarkable_johnny_blaze.sql',
  '0007_parched_blizzard.sql',
  '0008_quota_budgets.sql',
  '0009_public_incident_feed_index.sql',
]

function applyMigration(db, file) {
  const sql = readFileSync(resolve(process.cwd(), 'drizzle', file), 'utf8')
  const statements = sql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean)
  db.transaction(() => {
    for (const statement of statements) db.exec(statement)
  })()
}

function sqliteExecutor(db) {
  return (sql) => {
    try {
      const statement = db.prepare(sql)
      if (statement.reader) return [{ results: statement.all() }]
      statement.run()
      return [{ results: [] }]
    } catch (error) {
      if (!String(error).includes('more than one statement')) throw error
      db.exec(sql)
      return [{ results: [] }]
    }
  }
}

describe('legacy migration reconciliation', () => {
  it('creates a standard Wrangler ledger for a complete ledgerless v1.6 database', () => {
    const db = new Database(':memory:')
    try {
      for (const file of LEGACY_MIGRATIONS) applyMigration(db, file)
      const metrics = db.prepare(buildLegacySchemaInspectionSql()).get()
      expect(isCompleteLegacySchema(metrics)).toBe(true)
      expect(metrics.post_legacy_count).toBe(0)

      expect(reconcileLegacyMigration(sqliteExecutor(db))).toBe('ledger-created')
      const recorded = db.prepare(
        'SELECT name FROM d1_migrations ORDER BY id',
      ).all().map((row) => row.name)
      expect(recorded).toEqual(LEGACY_MIGRATIONS)
    } finally {
      db.close()
    }
  })

  it('rejects a partial non-empty schema without creating a ledger', () => {
    const db = new Database(':memory:')
    try {
      for (const file of LEGACY_MIGRATIONS) applyMigration(db, file)
      db.exec('DROP INDEX idx_monitors_updated')

      expect(() => reconcileLegacyMigration(sqliteExecutor(db)))
        .toThrow(/non-empty ledgerless schema/)
      expect(db.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name = 'd1_migrations'
      `).get().count).toBe(0)
    } finally {
      db.close()
    }
  })

  it('leaves a normally partial Wrangler migration chain pending', () => {
    const db = new Database(':memory:')
    try {
      applyMigration(db, LEGACY_MIGRATIONS[0])
      db.exec(`
        CREATE TABLE d1_migrations(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE,
          applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
        );
        INSERT INTO d1_migrations (name) VALUES ('0000_init.sql');
      `)

      expect(reconcileLegacyMigration(sqliteExecutor(db))).toBe('pending')
      expect(db.prepare(
        'SELECT COUNT(*) AS count FROM d1_migrations',
      ).get().count).toBe(1)
    } finally {
      db.close()
    }
  })

  it('rejects combined pending index work before creating a ledger', () => {
    const db = new Database(':memory:')
    try {
      for (const file of LEGACY_MIGRATIONS) applyMigration(db, file)
      db.exec(`
        INSERT INTO incident_reports (
          id, title, status, visibility, impact, started_at
        ) VALUES (
          'large-report', 'Large report', 'monitoring',
          'published', 'minor', 1
        );
        INSERT INTO monitors (id, name, type)
        VALUES ('migration-monitor', 'Migration monitor', 'http');
        WITH digits(value) AS (
          VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
        ),
        numbers(value) AS (
          SELECT
            a.value
            + b.value * 10
            + c.value * 100
            + d.value * 1000
            + e.value * 10000
          FROM digits AS a
          CROSS JOIN digits AS b
          CROSS JOIN digits AS c
          CROSS JOIN digits AS d
          CROSS JOIN digits AS e
        )
        INSERT INTO incident_updates (
          id, incident_id, message, status, created_at
        )
        SELECT
          'migration-update-' || printf('%05d', value),
          'large-report',
          'Update',
          'monitoring',
          1
        FROM numbers
        WHERE value < 21000;

        WITH digits(value) AS (
          VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
        ),
        numbers(value) AS (
          SELECT
            a.value
            + b.value * 10
            + c.value * 100
            + d.value * 1000
            + e.value * 10000
          FROM digits AS a
          CROSS JOIN digits AS b
          CROSS JOIN digits AS c
          CROSS JOIN digits AS d
          CROSS JOIN digits AS e
        )
        INSERT INTO maintenance_windows (
          id, monitor_id, start_at, end_at
        )
        SELECT
          'migration-window-' || printf('%05d', value),
          'migration-monitor',
          value,
          value + 1
        FROM numbers
        WHERE value < ${MAX_SAFE_MIGRATION_D1_WRITES / 2 + 1};
      `)

      expect(() => assertPendingMigrationWriteBudgetSafe(sqliteExecutor(db)))
        .toThrow(/Pending migrations would require/)
      expect(() => reconcileLegacyMigration(sqliteExecutor(db)))
        .toThrow(/Pending migrations would require/)
      expect(db.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name = 'd1_migrations'
      `).get().count).toBe(0)
    } finally {
      db.close()
    }
  })

  it('preflights replacement builds and obsolete-index cleanup for migration 0010', () => {
    const db = new Database(':memory:')
    try {
      const appliedMigrations = [
        ...LEGACY_MIGRATIONS,
        ...POST_V1_6_MIGRATIONS_BEFORE_BOUNDED_FEED,
      ]
      for (const file of appliedMigrations) applyMigration(db, file)
      db.exec(`
        CREATE TABLE d1_migrations(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE,
          applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
        );
      `)
      const recordMigration = db.prepare(
        'INSERT INTO d1_migrations (name) VALUES (?)',
      )
      db.transaction(() => {
        for (const file of appliedMigrations) recordMigration.run(file)
      })()
      db.exec(`
        INSERT INTO incident_reports (
          id, title, status, visibility, impact, started_at
        ) VALUES (
          'existing-large-report', 'Existing large report', 'monitoring',
          'published', 'minor', 1
        );
        WITH digits(value) AS (
          VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
        ),
        numbers(value) AS (
          SELECT
            a.value
            + b.value * 10
            + c.value * 100
            + d.value * 1000
            + e.value * 10000
          FROM digits AS a
          CROSS JOIN digits AS b
          CROSS JOIN digits AS c
          CROSS JOIN digits AS d
          CROSS JOIN digits AS e
        )
        INSERT INTO incident_updates (
          id, incident_id, message, status, created_at
        )
        SELECT
          'existing-update-' || printf('%05d', value),
          'existing-large-report',
          'Update',
          'monitoring',
          1
        FROM numbers
        WHERE value < ${MAX_SAFE_MIGRATION_D1_WRITES / 2 + 1};
      `)

      expect(() => reconcileLegacyMigration(sqliteExecutor(db)))
        .toThrow(/Pending migrations would require/)
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM d1_migrations').get().count,
      ).toBe(appliedMigrations.length)
      expect(
        db.prepare(`
          SELECT COUNT(*) AS count
          FROM sqlite_master
          WHERE type = 'table'
            AND name = 'incident_feed_monitor_counts'
        `).get().count,
      ).toBe(0)
    } finally {
      db.close()
    }
  })
})
