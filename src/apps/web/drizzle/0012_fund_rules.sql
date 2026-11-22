-- The fund rules (2026-11-09, an approved change to the frozen schema). Additive: one column, then data on seeded rows only.
--
-- C3: `categories.counts_as_return`, the switch "Counts as return (gain or loss)". On a holding,
-- money in under a category with it off is money put in (Invested); money out under one with it
-- on (a dividend sent to the bank) leaves Invested alone. On for the seeded Interest and Dividends
-- (in an Income group) and the system Balance adjustment; off for everything else.
ALTER TABLE `categories` ADD `counts_as_return` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `categories` SET `counts_as_return` = 1 WHERE `id` = 'sys-balance-adjustment';
--> statement-breakpoint
UPDATE `categories` SET `counts_as_return` = 1
WHERE `deleted_at` IS NULL
	AND lower(`name`) IN ('interest', 'dividends')
	AND `group_id` IN (SELECT `id` FROM `category_groups` WHERE `kind` = 'income');
--> statement-breakpoint
-- C2: a fourth group kind, "investments" (Not in reports, and Reports' Invested reads it). The
-- seeded Investments group moves to it; the person's own Not-in-reports groups stay as they are.
UPDATE `category_groups` SET `kind` = 'investments'
WHERE `deleted_at` IS NULL AND `kind` = 'neutral' AND lower(`name`) = 'investments';
