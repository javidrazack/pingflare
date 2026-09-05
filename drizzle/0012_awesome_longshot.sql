CREATE TABLE `delivery_receipts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`monitor_name` text NOT NULL,
	`channel_name` text NOT NULL,
	`event_type` text NOT NULL,
	`delivered_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `revoked_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_revoked_sessions_expiry` ON `revoked_sessions` (`expires_at`);--> statement-breakpoint
ALTER TABLE `scheduler_leases` ADD `last_completed_at` integer;--> statement-breakpoint
ALTER TABLE `scheduler_leases` ADD `last_run_failed` integer DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS record_delivery_receipt
AFTER UPDATE OF delivered_count ON notification_deliveries
WHEN NEW.delivered_count > OLD.delivered_count
BEGIN
  INSERT INTO delivery_receipts (monitor_name, channel_name, event_type, delivered_at)
  VALUES (
    COALESCE((SELECT name FROM monitors WHERE id = NEW.monitor_id), 'Deleted monitor'),
    COALESCE((SELECT c.name FROM json_each(OLD.remaining_channel_ids) j
      JOIN notification_channels c ON c.id = j.value WHERE c.active = 1
      ORDER BY CAST(j.key AS INTEGER) LIMIT 1), 'Deleted channel'),
    NEW.event_type, NEW.updated_at
  );
  DELETE FROM delivery_receipts WHERE id <= last_insert_rowid() - 200;
END;
