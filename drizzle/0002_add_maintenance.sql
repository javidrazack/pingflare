CREATE TABLE `maintenance_windows` (
	`id` text PRIMARY KEY NOT NULL,
	`monitor_id` text NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`reason` text,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
