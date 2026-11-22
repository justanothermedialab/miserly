CREATE TABLE `user_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`number_system` text DEFAULT 'indian' NOT NULL,
	`compact` integer DEFAULT false NOT NULL,
	`foreign_grouping` text DEFAULT 'preference' NOT NULL,
	`theme` text DEFAULT 'system' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `instance_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
