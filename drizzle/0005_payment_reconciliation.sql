CREATE TABLE `payment_reconciliation_clock` (
	`id` integer PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`available_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `payment_orders` ADD `reconcile_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_orders` ADD `reconcile_next_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_orders` ADD `reconcile_lease_until` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_orders` ADD `notification_failed_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `payment_orders_reconcile_due` ON `payment_orders` (`reconcile_next_at`,`updated_at`);