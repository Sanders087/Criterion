CREATE TABLE `mail_attempts` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`mail_type` text NOT NULL,
	`provider_message_id` text,
	`status` text NOT NULL,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mail_attempts_created_at` ON `mail_attempts` (`created_at`);--> statement-breakpoint
ALTER TABLE `payment_orders` ADD `first_missing_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_orders` ADD `cancel_requested_at` integer DEFAULT 0 NOT NULL;