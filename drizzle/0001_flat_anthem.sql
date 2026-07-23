CREATE TABLE `incident_monitors` (
	`incident_id` text NOT NULL,
	`monitor_id` text NOT NULL,
	PRIMARY KEY(`incident_id`, `monitor_id`),
	FOREIGN KEY (`incident_id`) REFERENCES `incident_reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `incident_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE TABLE `incident_updates` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`message` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`incident_id`) REFERENCES `incident_reports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `settings` (`key`, `value`) VALUES ('retention_days', '90');
--> statement-breakpoint
CREATE TABLE `status_page_monitors` (
	`page_id` text NOT NULL,
	`monitor_id` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`page_id`, `monitor_id`),
	FOREIGN KEY (`page_id`) REFERENCES `status_pages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `status_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`password_hash` text,
	`show_all_monitors` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `status_pages_slug_unique` ON `status_pages` (`slug`);--> statement-breakpoint
ALTER TABLE `monitors` ADD `ssl_check_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `monitors` ADD `ssl_status` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `monitors` ADD `cache_booster` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_monitors_active` ON `monitors` (`active`);--> statement-breakpoint
ALTER TABLE `notification_channels` ADD `is_default` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `status_logs` ADD `colo` text;--> statement-breakpoint
ALTER TABLE `status_logs` ADD `country_code` text;--> statement-breakpoint
ALTER TABLE `status_logs` ADD `origin_ip` text;--> statement-breakpoint
CREATE INDEX `idx_sl_monitor_checked` ON `status_logs` (`monitor_id`,`checked_at`);--> statement-breakpoint
CREATE INDEX `idx_sl_checked_at` ON `status_logs` (`checked_at`);
