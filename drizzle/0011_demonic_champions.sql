CREATE TABLE `agent_metric_samples` (
	`monitor_id` text NOT NULL,
	`sampled_at` integer NOT NULL,
	`cpu_basis_points` integer NOT NULL,
	`ram_basis_points` integer NOT NULL,
	`disk_basis_points` integer NOT NULL,
	PRIMARY KEY(`monitor_id`, `sampled_at`),
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TRIGGER `trg_agent_metric_samples_retention`
AFTER INSERT ON `agent_metric_samples`
BEGIN
	DELETE FROM `agent_metric_samples`
	WHERE `monitor_id` = NEW.monitor_id
		AND `sampled_at` = (
			SELECT MIN(`sampled_at`)
			FROM `agent_metric_samples`
			WHERE `monitor_id` = NEW.monitor_id
				AND `sampled_at` < NEW.sampled_at - 2592000
		);
END;
