CREATE TABLE `notification_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`dedupe_key` text NOT NULL,
	`monitor_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`remaining_channel_ids` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`delivered_count` integer DEFAULT 0 NOT NULL,
	`state_applied` integer DEFAULT false NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`claim_token` text,
	`claim_until` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_deliveries_dedupe_key_unique` ON `notification_deliveries` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_notification_deliveries_due` ON `notification_deliveries` (`next_attempt_at`,`claim_until`);--> statement-breakpoint
CREATE INDEX `idx_notification_deliveries_monitor` ON `notification_deliveries` (`monitor_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `monitors` ADD `next_check_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `monitors` ADD `observation_revision` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `monitors`
SET `next_check_at` = `last_checked_at` + `interval`
WHERE `next_check_at` = 0
	AND `last_checked_at` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_monitors_active_next_check` ON `monitors` (`active`,`next_check_at`);--> statement-breakpoint
UPDATE `incidents`
SET `resolved_at` = `started_at`,
	`duration_seconds` = 0
WHERE `id` IN (
	SELECT `id`
	FROM (
		SELECT
			`id`,
			ROW_NUMBER() OVER (
				PARTITION BY `monitor_id`
				ORDER BY `started_at`, `id`
			) AS `open_rank`
		FROM `incidents`
		WHERE `resolved_at` IS NULL
	)
	WHERE `open_rank` > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_incidents_one_open` ON `incidents` (`monitor_id`) WHERE "incidents"."resolved_at" IS NULL;
