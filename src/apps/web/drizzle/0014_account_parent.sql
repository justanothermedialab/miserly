-- EPF and its EPS (2026-11-10, an approved change to the frozen schema): an
-- account may belong to another. An EPF's EPS (the employer's pension contributions, counted at what
-- was paid in, S5 RD16) is its own account, never listed on its own: it shows on its EPF's page as
-- the EPS tab and in its EPF's section, and it is shared, closed, reopened and renamed with it.
-- Additive: one nullable column; no existing row changes.
ALTER TABLE `accounts` ADD `parent_account_id` text REFERENCES accounts(id);
--> statement-breakpoint
CREATE INDEX `idx_accounts_parent` ON `accounts` (`parent_account_id`);
