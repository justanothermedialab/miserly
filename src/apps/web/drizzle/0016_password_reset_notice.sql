-- H3 RD9 (2026-11-18): the admin's Reset password stays,
-- and the member is always told. The reset stamps the day it was done; the first page after the
-- member's forced change shows "Your password was reset by the admin on <day>" until they dismiss
-- it, which clears the column. Additive: one nullable column; no existing row changes.
ALTER TABLE `users` ADD `password_reset_at` text;
