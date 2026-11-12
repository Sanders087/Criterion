CREATE TABLE `email_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`email` text NOT NULL,
	`purpose` text NOT NULL,
	`credential_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`claim` text
);
--> statement-breakpoint
CREATE INDEX `email_tokens_account` ON `email_tokens` (`account_id`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `email_verified_at` integer;