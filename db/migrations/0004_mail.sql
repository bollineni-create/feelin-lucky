CREATE TABLE `emails` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` text NOT NULL,
	`account` text,
	`mailbox` text,
	`mail_id` integer,
	`from_name` text,
	`from_address` text,
	`subject` text NOT NULL,
	`received_at` text NOT NULL,
	`body` text,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`application_id` integer,
	`matched_by` text,
	`candidate_ids` text,
	`summary` text,
	`filed_to` text,
	`flagged` integer DEFAULT false NOT NULL,
	`file_error` text,
	`created_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `emails_message_idx` ON `emails` (`message_id`);--> statement-breakpoint
CREATE INDEX `emails_app_idx` ON `emails` (`application_id`);--> statement-breakpoint
CREATE INDEX `emails_status_idx` ON `emails` (`status`);--> statement-breakpoint
CREATE TABLE `mail_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`mailbox_name` text DEFAULT 'Lodestar' NOT NULL,
	`file_emails` integer DEFAULT true NOT NULL,
	`flag_needs_reply` integer DEFAULT true NOT NULL,
	`include_junk` integer DEFAULT true NOT NULL,
	`notify` integer DEFAULT true NOT NULL,
	`accounts` text DEFAULT '[]' NOT NULL,
	`lookback_days` integer DEFAULT 30 NOT NULL,
	`known_accounts` text,
	`checked_through` text,
	`last_check_at` text,
	`last_ok_at` text,
	`last_error` text,
	`last_summary` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `applications` ADD `email_confirmed_at` text;--> statement-breakpoint
ALTER TABLE `applications` ADD `last_email_at` text;