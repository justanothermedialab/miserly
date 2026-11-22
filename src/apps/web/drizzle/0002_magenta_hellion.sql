ALTER TABLE `account_payee` ADD `last_used_at` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `opening_date` text;--> statement-breakpoint
ALTER TABLE `categories` ADD `hidden` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `categories` ADD `colour` text;--> statement-breakpoint
ALTER TABLE `category_groups` ADD `hidden` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `payees` ADD `hidden` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `user_payee` ADD `last_category_id` text REFERENCES categories(id);--> statement-breakpoint
ALTER TABLE `user_payee` ADD `last_used_at` text;