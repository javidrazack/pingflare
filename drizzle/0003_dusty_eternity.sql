CREATE TABLE `maintenance_windows` (
	`id` text PRIMARY KEY NOT NULL,
	`monitor_id` text NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`reason` text,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `monitors` ADD `json_path` text;--> statement-breakpoint
ALTER TABLE `monitors` ADD `expected_value` text;--> statement-breakpoint
ALTER TABLE `monitors` ADD `cpu_threshold` integer;--> statement-breakpoint
ALTER TABLE `monitors` ADD `ram_threshold` integer;--> statement-breakpoint
ALTER TABLE `monitors` ADD `disk_threshold` integer;--> statement-breakpoint
ALTER TABLE `monitors` ADD `last_metrics` text;