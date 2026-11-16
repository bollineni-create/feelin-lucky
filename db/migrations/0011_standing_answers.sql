ALTER TABLE `profile` ADD `standing_answers` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `profile` ADD `agent_creates_accounts` integer DEFAULT false NOT NULL;