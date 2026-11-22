-- Chat J, joint accounts (owner chose C, 2026-10-17; dated shares, H2 RD8, 2026-10-21; SQL approved
-- with its CHECK, 2026-10-27): each holder's share of a shared account, in basis points, from a date.
-- No rows = equal (1/n); a change writes every holder's row for its date and they sum to 10,000; a
-- holder added after a stated split gets 0 %, a removed holder's share returns to the owner; dates
-- before the first change are equal; a mistaken change is deleted outright (no deleted_at). Read
-- half-open: from effective_from to the next change. Additive: no existing row changes.
CREATE TABLE `account_shares` (
	`account_id` text NOT NULL,
	`user_id` text NOT NULL,
	`effective_from` text NOT NULL,
	`share_bp` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`account_id`, `effective_from`, `user_id`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `chk_account_shares_bp` CHECK(`share_bp` BETWEEN 0 AND 10000)
);
