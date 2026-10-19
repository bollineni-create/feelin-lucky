ALTER TABLE `applications` ADD `auto_applied` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `search_criteria` ADD `auto_apply` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `search_criteria` ADD `auto_apply_min_score` integer DEFAULT 85 NOT NULL;--> statement-breakpoint
ALTER TABLE `search_criteria` ADD `auto_apply_daily_cap` integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE `search_criteria` ADD `auto_apply_sources` text DEFAULT '["careers","linkedin"]' NOT NULL;