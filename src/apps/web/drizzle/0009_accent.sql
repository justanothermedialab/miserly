-- SET1 (item 3 C2b): the viewer's accent colour, a display preference like the
-- theme. Ink is the default; the curated set is checked in setUserPrefs. Additive, no data change.
ALTER TABLE `user_preferences` ADD `accent` text DEFAULT 'ink' NOT NULL;
