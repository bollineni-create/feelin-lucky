ALTER TABLE `applications` ADD `needs_answers` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `applications` ADD `answers_flagged_at` text;--> statement-breakpoint
ALTER TABLE `profile` ADD `standard_answers` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `profile` ADD `standard_answers_updated_at` text;--> statement-breakpoint
-- Until now the agent flagged a form question it couldn't answer as needs_signin. Move the approved ones whose note
-- names no sign-in wall over to needs_answers, so the Queue asks for answers instead of a sign-in.
UPDATE `applications` SET `needs_answers` = 1, `answers_flagged_at` = coalesce(`signin_checked_at`, `stage_changed_at`), `needs_signin` = 0, `signin_checked_at` = NULL
WHERE `stage` IN ('approved', 'found') AND `needs_signin` = 1 AND `portal_note` IS NOT NULL
  AND lower(`portal_note`) NOT LIKE '%account%' AND lower(`portal_note`) NOT LIKE '%sign in%' AND lower(`portal_note`) NOT LIKE '%sign-in%'
  AND lower(`portal_note`) NOT LIKE '%signin%' AND lower(`portal_note`) NOT LIKE '%sign up%' AND lower(`portal_note`) NOT LIKE '%log in%'
  AND lower(`portal_note`) NOT LIKE '%login%' AND lower(`portal_note`) NOT LIKE '%password%' AND lower(`portal_note`) NOT LIKE '%captcha%'
  AND lower(`portal_note`) NOT LIKE '%verification%' AND lower(`portal_note`) NOT LIKE '%one-time code%';
