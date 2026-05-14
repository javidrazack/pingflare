ALTER TABLE `monitors` ADD `cpu_threshold` integer;
ALTER TABLE `monitors` ADD `ram_threshold` integer;
ALTER TABLE `monitors` ADD `disk_threshold` integer;
ALTER TABLE `monitors` ADD `last_metrics` text;
