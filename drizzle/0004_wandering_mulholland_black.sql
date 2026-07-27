CREATE TABLE `incident_report_events` (
	`incident_id` text NOT NULL,
	`event_id` text NOT NULL,
	PRIMARY KEY(`incident_id`, `event_id`),
	FOREIGN KEY (`incident_id`) REFERENCES `incident_reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `incidents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `notification_test_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`status` text NOT NULL,
	`latency_ms` integer NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `notification_channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_notification_tests_channel_created` ON `notification_test_runs` (`channel_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `incident_reports` ADD `visibility` text DEFAULT 'published' NOT NULL;--> statement-breakpoint
ALTER TABLE `incident_reports` ADD `impact` text DEFAULT 'minor' NOT NULL;--> statement-breakpoint
ALTER TABLE `incident_reports` ADD `published_at` integer;--> statement-breakpoint
ALTER TABLE `status_pages` ADD `logo_url` text;--> statement-breakpoint
ALTER TABLE `status_pages` ADD `brand_color` text DEFAULT '#B45309' NOT NULL;--> statement-breakpoint
ALTER TABLE `status_pages` ADD `theme` text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE `status_pages` ADD `show_response_time` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `status_pages` ADD `show_uptime` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `status_pages` ADD `history_days` integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE `status_pages` ADD `seo_title` text;--> statement-breakpoint
ALTER TABLE `status_pages` ADD `seo_description` text;--> statement-breakpoint
CREATE INDEX `idx_monitors_status` ON `monitors` (`last_status`);--> statement-breakpoint
CREATE INDEX `idx_monitors_type` ON `monitors` (`type`);--> statement-breakpoint
CREATE INDEX `idx_monitors_updated` ON `monitors` (`updated_at`);