ALTER TABLE `sessions` ADD `last_used_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `username` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `role` text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `must_change_password` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_users_username` ON `users` (`username`);