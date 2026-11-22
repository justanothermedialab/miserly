-- A catch-all "Other"
-- category at the end of every live group that has none, in a file that already has its starter
-- categories. The system Adjustments group (the one holding the fixed Balance adjustment category)
-- is left as it is. A fresh file has no groups yet, so this adds nothing; the starter set (seed.ts)
-- brings "Other" itself. Data only, no schema change; no existing row changes.
INSERT INTO `categories` (`id`, `group_id`, `name`, `sort_order`, `hidden`)
SELECT
	lower(hex(randomblob(16))),
	g.`id`,
	'Other',
	COALESCE((SELECT MAX(c.`sort_order`) FROM `categories` c WHERE c.`group_id` = g.`id` AND c.`deleted_at` IS NULL), -1) + 1,
	0
FROM `category_groups` g
WHERE g.`deleted_at` IS NULL
	AND NOT EXISTS (
		SELECT 1 FROM `categories` c
		WHERE c.`group_id` = g.`id` AND c.`deleted_at` IS NULL AND lower(c.`name`) = 'other'
	)
	AND NOT EXISTS (
		SELECT 1 FROM `categories` c
		WHERE c.`group_id` = g.`id` AND c.`id` = 'sys-balance-adjustment'
	);
