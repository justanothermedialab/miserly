-- Sharing (2026-11-09, an approved change to the frozen schema; H2 RD9). The dates each member held a shared account: one row per stretch, from
-- `from_date` (the day they were added) up to but not including `to_date` (the day they were
-- removed; NULL while they hold it). A re-share starts a new row, so an earlier stretch is kept
-- (today's `account_members` row is revived on a re-share and loses it). The owner holds the
-- account for its whole life and has no row.
--
-- A holder sees the account's rows dated inside their stretches (the balance on the day they
-- joined, nothing earlier; read-only after they leave), and their figures count their share on
-- those dates only. Additive: no existing row changes. A live `account_members` grant from
-- before 0013 has no row here and counts as held from the account's start (what that member saw
-- until now), so no backfill.
CREATE TABLE `account_holder_periods` (
	`account_id` text NOT NULL,
	`user_id` text NOT NULL,
	`from_date` text NOT NULL,
	`to_date` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`account_id`, `user_id`, `from_date`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `chk_holder_period_dates` CHECK(`to_date` IS NULL OR `to_date` > `from_date`)
);
--> statement-breakpoint
CREATE INDEX `idx_holder_periods_user` ON `account_holder_periods` (`user_id`);
