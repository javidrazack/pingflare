import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

const migrationsDirectory = resolve(process.cwd(), 'drizzle')
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => /^\d{4}_.+\.sql$/.test(file))
  .sort()

function applyMigrationSql(db: Database.Database, sql: string): void {
  const statements = sql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean)

  db.transaction(() => {
    for (const statement of statements) db.exec(statement)
  })()
}

function applyMigration(db: Database.Database, file: string): void {
  applyMigrationSql(db, readFileSync(resolve(migrationsDirectory, file), 'utf8'))
}

describe('D1 migration chain', () => {
  it('upgrades the released 0006 schema without retaining obsolete indexes', () => {
    const db = new Database(':memory:')
    const releasedMigrationPath = resolve(
      process.cwd(),
      'src/test/fixtures/released-0006_remarkable_johnny_blaze.sql',
    )
    const releasedMigration = readFileSync(releasedMigrationPath, 'utf8')
    const migrationName = '0006_remarkable_johnny_blaze.sql'
    const migrationIndex = migrationFiles.indexOf(migrationName)

    try {
      expect(migrationIndex).toBeGreaterThan(0)
      expect(
        readFileSync(resolve(migrationsDirectory, migrationName), 'utf8'),
      ).toBe(releasedMigration)

      for (const file of migrationFiles.slice(0, migrationIndex)) {
        applyMigration(db, file)
      }
      applyMigrationSql(db, releasedMigration)

      expect(
        (db.prepare(`
          SELECT COUNT(*) AS count
          FROM sqlite_master
          WHERE type = 'index'
            AND name IN (
              'idx_incident_updates_incident_created',
              'idx_incidents_monitor_started',
              'idx_incidents_monitor_resolved'
            )
        `).get() as { count: number }).count,
      ).toBe(3)

      for (const file of migrationFiles.slice(migrationIndex + 1)) {
        applyMigration(db, file)
      }

      expect(
        (db.prepare(`
          SELECT name
          FROM sqlite_master
          WHERE type = 'index'
            AND name IN (
              'idx_incident_updates_incident_created',
              'idx_incident_updates_incident_created_id',
              'idx_incidents_monitor_started',
              'idx_incidents_monitor_started_id',
              'idx_incidents_monitor_resolved'
            )
          ORDER BY name
        `).all() as Array<{ name: string }>).map((row) => row.name),
      ).toEqual([
        'idx_incident_updates_incident_created_id',
        'idx_incidents_monitor_started_id',
      ])
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    } finally {
      db.close()
    }
  })

  it('upgrades a populated legacy schema without rewriting retained status history', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')

    try {
      const rollupMigrationIndex = migrationFiles.indexOf('0005_flimsy_quicksilver.sql')
      expect(rollupMigrationIndex).toBeGreaterThan(0)

      for (const file of migrationFiles.slice(0, rollupMigrationIndex)) {
        applyMigration(db, file)
      }

      db.prepare(`
        INSERT INTO monitors (id, name, type)
        VALUES ('migration-monitor', 'Migration monitor', 'http')
      `).run()
      db.prepare(`
        UPDATE monitors
        SET interval = 300, last_checked_at = 1_700_100_000
        WHERE id = 'migration-monitor'
      `).run()
      db.prepare(`
        INSERT INTO incidents (id, monitor_id, started_at)
        VALUES
          ('open-incident-first', 'migration-monitor', 1_700_000_000),
          ('open-incident-duplicate', 'migration-monitor', 1_700_000_100)
      `).run()
      const insertLog = db.prepare(`
        INSERT INTO status_logs (
          id, monitor_id, status, message, response_time_ms, checked_at
        ) VALUES (?, 'migration-monitor', 'up', 'OK', 25, ?)
      `)
      const seedLogs = db.transaction(() => {
        for (let index = 0; index < 2_000; index += 1) {
          insertLog.run(`legacy-${index}`, 1_700_000_000 + index * 60)
        }
      })
      seedLogs()

      const changesBeforeMigration = db.prepare(
        'SELECT total_changes() AS changes',
      ).get() as { changes: number }
      applyMigration(db, migrationFiles[rollupMigrationIndex])
      const changesAfterMigration = db.prepare(
        'SELECT total_changes() AS changes',
      ).get() as { changes: number }

      expect(changesAfterMigration.changes).toBe(changesBeforeMigration.changes)
      expect(
        (db.prepare('SELECT COUNT(*) AS count FROM monitor_daily_rollups').get() as { count: number }).count,
      ).toBe(0)
      expect(
        (db.prepare('SELECT COUNT(*) AS count FROM status_logs WHERE source IS NULL').get() as { count: number }).count,
      ).toBe(2_000)

      for (const file of migrationFiles.slice(rollupMigrationIndex + 1)) {
        applyMigration(db, file)
      }

      expect(
        (db.prepare(`
          SELECT next_check_at AS nextCheckAt
          FROM monitors
          WHERE id = 'migration-monitor'
        `).get() as { nextCheckAt: number }).nextCheckAt,
      ).toBe(1_700_100_300)
      expect(
        (db.prepare(`
          SELECT COUNT(*) AS count
          FROM incidents
          WHERE monitor_id = 'migration-monitor'
            AND resolved_at IS NULL
        `).get() as { count: number }).count,
      ).toBe(1)
      expect(
        db.prepare(`
          SELECT resolved_at AS resolvedAt, duration_seconds AS durationSeconds
          FROM incidents
          WHERE id = 'open-incident-duplicate'
        `).get(),
      ).toEqual({ resolvedAt: 1_700_000_100, durationSeconds: 0 })
      expect(
        (db.prepare(`
          SELECT COUNT(*) AS count
          FROM sqlite_master
          WHERE type = 'table'
            AND name IN (
              'notification_deliveries',
              'quota_budgets',
              'incident_feed_monitor_counts'
            )
        `).get() as { count: number }).count,
      ).toBe(3)
      expect(
        (db.prepare(`
          SELECT COUNT(*) AS count
          FROM sqlite_master
          WHERE type = 'index'
            AND name IN (
              'idx_incidents_one_open',
              'idx_monitors_active_next_check',
              'idx_incident_updates_incident_created_id',
              'idx_incidents_monitor_started_id'
            )
        `).get() as { count: number }).count,
      ).toBe(4)
      expect(
        (db.prepare(`
          SELECT COUNT(*) AS count
          FROM sqlite_master
          WHERE type = 'index'
            AND name IN (
              'idx_sl_source_checked',
              'idx_incidents_monitor_resolved',
              'idx_incident_reports_public_feed',
              'idx_incident_updates_incident_created',
              'idx_incidents_monitor_started'
            )
        `).get() as { count: number }).count,
      ).toBe(0)
      db.prepare(`
        INSERT INTO incident_reports (
          id, title, status, visibility, impact, started_at
        ) VALUES (
          'migration-report', 'Migration report', 'monitoring',
          'published', 'minor', 1_700_100_000
        )
      `).run()
      db.prepare(`
        INSERT INTO incident_monitors (incident_id, monitor_id)
        VALUES ('migration-report', 'migration-monitor')
      `).run()
      expect(
        db.prepare(`
          SELECT monitor_id AS monitorId, link_count AS linkCount
          FROM incident_feed_monitor_counts
        `).get(),
      ).toEqual({ monitorId: 'migration-monitor', linkCount: 1 })
      db.prepare(`
        DELETE FROM incident_monitors
        WHERE incident_id = 'migration-report'
          AND monitor_id = 'migration-monitor'
      `).run()
      expect(
        (db.prepare(`
          SELECT COUNT(*) AS count
          FROM incident_feed_monitor_counts
        `).get() as { count: number }).count,
      ).toBe(0)
      expect(
        (db.prepare(`
          SELECT observation_revision AS observationRevision
          FROM monitors
          WHERE id = 'migration-monitor'
        `).get() as { observationRevision: string }).observationRevision,
      ).toBe('')
      expect(
        (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check,
      ).toBe('ok')
    } finally {
      db.close()
    }
  })
})
