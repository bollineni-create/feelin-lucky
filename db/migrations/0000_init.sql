CREATE TABLE `applications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`stage` text DEFAULT 'found' NOT NULL,
	`stage_changed_at` text NOT NULL,
	`resume_version` text,
	`resume_md` text,
	`cover_letter_md` text,
	`cover_letter_path` text,
	`resume_path` text,
	`answers` text,
	`materials_updated_at` text,
	`submitted_at` text,
	`confirmation_screenshot` text,
	`confirmation_text` text,
	`needs_signin` integer DEFAULT false NOT NULL,
	`portal_note` text,
	`next_action` text,
	`next_action_due` text,
	`closed_reason` text,
	`skip_reason` text,
	`notes` text,
	`linkedin_status` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `applications_job_idx` ON `applications` (`job_id`);--> statement-breakpoint
CREATE INDEX `applications_stage_idx` ON `applications` (`stage`);--> statement-breakpoint
CREATE TABLE `companies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`categories` text DEFAULT '[]' NOT NULL,
	`highlight` text,
	`careers_url` text,
	`ats_type` text,
	`priority` text DEFAULT 'normal' NOT NULL,
	`last_scanned_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `companies_name_idx` ON `companies` (`name`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`application_id` integer,
	`at` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`detail` text,
	`source` text DEFAULT 'agent' NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_app_idx` ON `events` (`application_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`company_id` integer,
	`company_name` text NOT NULL,
	`source` text NOT NULL,
	`external_id` text,
	`url` text,
	`title` text NOT NULL,
	`location` text,
	`work_mode` text,
	`pay_text` text,
	`posted_at` text,
	`description` text,
	`fit_score` integer,
	`fit_reasons` text,
	`first_seen_at` text NOT NULL,
	`dedupe_key` text NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_dedupe_idx` ON `jobs` (`dedupe_key`);--> statement-breakpoint
CREATE TABLE `profile` (
	`id` integer PRIMARY KEY NOT NULL,
	`full_name` text NOT NULL,
	`email` text,
	`phone` text,
	`location` text,
	`linkedin_url` text,
	`website_url` text,
	`work_authorization` text,
	`needs_sponsorship` integer,
	`work_history` text NOT NULL,
	`education` text NOT NULL,
	`skills` text NOT NULL,
	`resume_file` text,
	`cv_file` text,
	`resume_text` text,
	`cv_text` text,
	`confirmed` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`phase` text DEFAULT 'all' NOT NULL,
	`trigger` text DEFAULT 'schedule' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`counts` text,
	`errors` text,
	`log_path` text
);
--> statement-breakpoint
CREATE TABLE `search_criteria` (
	`id` integer PRIMARY KEY NOT NULL,
	`primary_locations` text NOT NULL,
	`secondary_locations` text NOT NULL,
	`work_modes` text NOT NULL,
	`functions` text NOT NULL,
	`fit_threshold` integer DEFAULT 70 NOT NULL,
	`high_priority_threshold` integer DEFAULT 60 NOT NULL,
	`min_base` integer,
	`lookback_days` integer DEFAULT 7 NOT NULL,
	`broad_searches` text NOT NULL,
	`notes` text,
	`updated_at` text NOT NULL
);
