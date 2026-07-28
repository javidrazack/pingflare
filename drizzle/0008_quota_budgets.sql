CREATE TABLE `quota_budgets` (
	`key` text PRIMARY KEY NOT NULL,
	`day` integer NOT NULL,
	`used` integer DEFAULT 0 NOT NULL
);
