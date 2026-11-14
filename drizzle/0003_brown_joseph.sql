CREATE TABLE `payment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`status` text NOT NULL,
	`amount` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_events_once` ON `payment_events` (`order_id`,`status`,`amount`);--> statement-breakpoint
CREATE TABLE `payment_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`owner` text NOT NULL,
	`active_document` text,
	`amount` integer NOT NULL,
	`terminal_key` text NOT NULL,
	`payment_id` text,
	`payment_url` text,
	`status` text NOT NULL,
	`status_rank` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`checked_at` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_orders_active_document` ON `payment_orders` (`active_document`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_orders_payment_id` ON `payment_orders` (`payment_id`);--> statement-breakpoint
CREATE INDEX `payment_orders_document` ON `payment_orders` (`document_id`);--> statement-breakpoint
ALTER TABLE `documents` ADD `billing_state` text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `ai_operations_used` integer DEFAULT 0 NOT NULL;