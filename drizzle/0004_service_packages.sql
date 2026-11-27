CREATE TABLE `order_service_events` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `order_service_events_order` ON `order_service_events` (`order_id`);--> statement-breakpoint
ALTER TABLE `documents` ADD `selected_package` text;--> statement-breakpoint
ALTER TABLE `payment_orders` ADD `package_snapshot` text DEFAULT '{"id":"contract","name":"Договор","amount":19900,"signature":false,"video":false,"consultationMinutes":0,"contents":["Договор под вашу ситуацию"],"terms":["Договор доступен после подтверждения оплаты банком."]}' NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_orders` ADD `signature_file` blob;--> statement-breakpoint
ALTER TABLE `payment_orders` ADD `video_url` text;--> statement-breakpoint
ALTER TABLE `payment_orders` ADD `consultation_at` text;--> statement-breakpoint
ALTER TABLE `payment_orders` ADD `consultation_timezone` text;--> statement-breakpoint
ALTER TABLE `payment_orders` ADD `meeting_url` text;--> statement-breakpoint
ALTER TABLE `payment_orders` ADD `consultation_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_orders` ADD `fulfillment_revision` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE documents SET selected_package='contract' WHERE EXISTS (SELECT 1 FROM payment_orders WHERE document_id=documents.id);
