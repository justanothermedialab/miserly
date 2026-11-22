-- F2 RD6 (session 4, DECISIONS-S4 D4): category colours come from a swatch set without red,
-- green or gold. Move every seeded colour that is still at its seed value to its swatch; a
-- colour the user picked is never changed (exact, case-sensitive match on the seed value).
-- Data only, no schema change.
UPDATE `categories` SET `colour` = '#0f8fa8' WHERE `colour` = '#E5484D';
UPDATE `categories` SET `colour` = '#4a3aa7' WHERE `colour` = '#F76B15';
UPDATE `categories` SET `colour` = '#e87ba4' WHERE `colour` = '#46A758';
UPDATE `categories` SET `colour` = '#4aa3df' WHERE `colour` = '#00A2C7';
UPDATE `categories` SET `colour` = '#eb6834' WHERE `colour` = '#FFB224';
UPDATE `categories` SET `colour` = '#c2389a' WHERE `colour` = '#D6409F';
UPDATE `categories` SET `colour` = '#2a78d6' WHERE `colour` = '#3E63DD';
UPDATE `categories` SET `colour` = '#a0612c' WHERE `colour` = '#12A594';
UPDATE `categories` SET `colour` = '#8e4ec6' WHERE `colour` = '#8E4EC6';
UPDATE `categories` SET `colour` = '#5c6bc0' WHERE `colour` = '#8D8D8D';
UPDATE `categories` SET `colour` = '#5c6bc0' WHERE `colour` = '#5B5BD6';
UPDATE `categories` SET `colour` = '#2a78d6' WHERE `colour` = '#0D74CE';
UPDATE `categories` SET `colour` = '#a0612c' WHERE `colour` = '#B08C3D';
