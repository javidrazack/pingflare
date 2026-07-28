CREATE TABLE `monitor_daily_rollups` (
	`monitor_id` text NOT NULL,
	`day` integer NOT NULL,
	`checks` integer DEFAULT 0 NOT NULL,
	`up_count` integer DEFAULT 0 NOT NULL,
	`down_count` integer DEFAULT 0 NOT NULL,
	`response_count` integer DEFAULT 0 NOT NULL,
	`response_sum_ms` integer DEFAULT 0 NOT NULL,
	`response_min_ms` integer,
	`response_max_ms` integer,
	PRIMARY KEY(`monitor_id`, `day`),
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_monitor_daily_day` ON `monitor_daily_rollups` (`day`);--> statement-breakpoint
CREATE TABLE `scheduler_leases` (
	`name` text PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`lease_until` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `monitors` ADD `history_revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `monitors` ADD `stats_day` integer;--> statement-breakpoint
ALTER TABLE `monitors` ADD `day_checks` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `monitors` ADD `day_up_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `monitors` ADD `day_down_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `monitors` ADD `day_response_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `monitors` ADD `day_response_sum_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `monitors` ADD `day_response_min_ms` integer;--> statement-breakpoint
ALTER TABLE `monitors` ADD `day_response_max_ms` integer;--> statement-breakpoint
ALTER TABLE `status_logs` ADD `source` text;
