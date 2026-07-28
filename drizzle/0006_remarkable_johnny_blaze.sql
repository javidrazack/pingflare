CREATE INDEX `idx_incident_monitors_monitor` ON `incident_monitors` (`monitor_id`,`incident_id`);--> statement-breakpoint
CREATE INDEX `idx_incident_report_events_event` ON `incident_report_events` (`event_id`,`incident_id`);--> statement-breakpoint
CREATE INDEX `idx_incident_updates_incident_created` ON `incident_updates` (`incident_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_incidents_monitor_started` ON `incidents` (`monitor_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_incidents_monitor_resolved` ON `incidents` (`monitor_id`,`resolved_at`);--> statement-breakpoint
CREATE INDEX `idx_maintenance_monitor_window` ON `maintenance_windows` (`monitor_id`,`start_at`,`end_at`);