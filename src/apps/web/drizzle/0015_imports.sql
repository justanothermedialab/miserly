-- The import log (2026-11-10, an approved change to the frozen schema) for Actual
-- Budget's export (story F4). One row per import: who ran it, when, the file, Actual's budget id
-- and the counts it added; `undone_at` once Undo import removed what it added. `import_items` lists
-- what each import made or added (an account, a row, a category group, a category, a payee) with
-- Actual's own id, so a later import of a newer export adds only what isn't here yet, and Undo
-- removes exactly what the import added. Additive: two new tables; no existing row changes.
CREATE TABLE `imports` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source` text NOT NULL,
	`file_name` text NOT NULL,
	`budget_id` text,
	`budget_name` text,
	`accounts` integer DEFAULT 0 NOT NULL,
	`transactions` integer DEFAULT 0 NOT NULL,
	`categories` integer DEFAULT 0 NOT NULL,
	`payees` integer DEFAULT 0 NOT NULL,
	`undone_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_imports_user` ON `imports` (`user_id`);
--> statement-breakpoint
CREATE TABLE `import_items` (
	`import_id` text NOT NULL,
	`kind` text NOT NULL,
	`our_id` text NOT NULL,
	`actual_id` text NOT NULL,
	`created` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`import_id`, `kind`, `our_id`),
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT `chk_import_items_kind` CHECK(`kind` IN ('account', 'transaction', 'group', 'category', 'payee'))
);
--> statement-breakpoint
CREATE INDEX `idx_import_items_actual` ON `import_items` (`kind`, `actual_id`);
