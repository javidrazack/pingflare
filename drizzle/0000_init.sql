CREATE TABLE `monitors` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`interval` integer DEFAULT 60 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`last_checked_at` integer,
	`last_status` text DEFAULT 'pending' NOT NULL,
	`reminder_interval_hours` integer,
	`tolerance_failures` integer DEFAULT 1 NOT NULL,
	`url` text,
	`method` text DEFAULT 'GET' NOT NULL,
	`body` text,
	`headers` text DEFAULT '{}' NOT NULL,
	`expected_status` integer DEFAULT 200 NOT NULL,
	`follow_redirects` integer DEFAULT true NOT NULL,
	`timeout` integer DEFAULT 30 NOT NULL,
	`ip_version` text DEFAULT 'auto' NOT NULL,
	`auth_type` text DEFAULT 'none' NOT NULL,
	`auth_username` text,
	`auth_password` text,
	`auth_token` text,
	`heartbeat_interval` integer,
	`heartbeat_grace` integer DEFAULT 30 NOT NULL,
	`tolerance_missed` integer DEFAULT 1 NOT NULL,
	`surge_protection_limit` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `status_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`monitor_id` text NOT NULL,
	`status` text NOT NULL,
	`message` text,
	`response_time_ms` integer,
	`checked_at` integer NOT NULL,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`monitor_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`resolved_at` integer,
	`duration_seconds` integer,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `notification_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `monitor_notifications` (
	`monitor_id` text NOT NULL,
	`channel_id` text NOT NULL,
	PRIMARY KEY(`monitor_id`, `channel_id`),
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `notification_channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `heartbeat_tokens` (
	`monitor_id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`last_ping_at` integer,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `heartbeat_tokens_token_unique` ON `heartbeat_tokens` (`token`);
--> statement-breakpoint
CREATE TABLE `alert_state` (
	`monitor_id` text PRIMARY KEY NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`consecutive_missed` integer DEFAULT 0 NOT NULL,
	`alert_sent_at` integer,
	`consecutive_alerts` integer DEFAULT 0 NOT NULL,
	`last_reminder_at` integer,
	`surge_paused_until` integer,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
