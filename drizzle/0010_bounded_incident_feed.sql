CREATE TABLE `incident_feed_monitor_counts` (
	`monitor_id` text PRIMARY KEY NOT NULL,
	`link_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `incident_feed_monitor_counts` (`monitor_id`, `link_count`)
SELECT `monitor_id`, COUNT(*)
FROM `incident_monitors`
GROUP BY `monitor_id`;--> statement-breakpoint
CREATE TRIGGER `trg_incident_feed_count_insert`
AFTER INSERT ON `incident_monitors`
BEGIN
	INSERT INTO `incident_feed_monitor_counts` (`monitor_id`, `link_count`)
	VALUES (NEW.monitor_id, 1)
	ON CONFLICT(`monitor_id`) DO UPDATE
	SET `link_count` = `link_count` + 1;
END;--> statement-breakpoint
CREATE TRIGGER `trg_incident_feed_count_delete`
AFTER DELETE ON `incident_monitors`
BEGIN
	UPDATE `incident_feed_monitor_counts`
	SET `link_count` = MAX(0, `link_count` - 1)
	WHERE `monitor_id` = OLD.monitor_id;
	DELETE FROM `incident_feed_monitor_counts`
	WHERE `monitor_id` = OLD.monitor_id AND `link_count` = 0;
END;--> statement-breakpoint
CREATE INDEX `idx_incident_updates_incident_created_id` ON `incident_updates` (`incident_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_incidents_monitor_started_id` ON `incidents` (`monitor_id`,`started_at`,`id`);--> statement-breakpoint
DROP INDEX IF EXISTS `idx_incident_updates_incident_created`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_incidents_monitor_started`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_incidents_monitor_resolved`;
