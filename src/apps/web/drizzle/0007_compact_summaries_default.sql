-- SET1 RD5: summaries are compact by default. A stored `compact = 0`
-- predates the decision (the row is written whenever any preference, such as the theme, is
-- saved), so reset it once; the Settings switch still turns it off. Data only, no schema change.
UPDATE `user_preferences` SET `compact` = 1;
