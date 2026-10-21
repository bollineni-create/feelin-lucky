CREATE TABLE `lookups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text,
	`company` text,
	`company_id` integer,
	`note` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`done_at` text,
	`run_id` integer,
	`result` text,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `lookups_status_idx` ON `lookups` (`status`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `lookup_id` integer REFERENCES lookups(id);