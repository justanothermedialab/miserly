/**
 * Colour icons for navigation and identity (item 3 direction B): Microsoft's Fluent
 * UI System Icons, colour set (MIT, LICENSE.txt here), recoloured off red and green so an icon never
 * reads as money in or out. Keys are the app's own: nav destinations and module types.
 */
import home from './home.svg?raw';
import transactions from './text_bullet_list_square.svg?raw';
import reports from './data_pie.svg?raw';
import inbox from './clipboard_task.svg?raw';
import accounts from './building_multiple.svg?raw';
import bank from './building_government.svg?raw';
import creditCard from './contact_card.svg?raw';
import fd from './vault.svg?raw';
import rd from './savings.svg?raw';
import loan from './receipt.svg?raw';
import mutualFunds from './data_trending.svg?raw';
import stocks from './arrow_trending_lines.svg?raw';
import gold from './coin_multiple.svg?raw';
import property from './building_home.svg?raw';
import otherAsset from './briefcase.svg?raw';
import otherLiability from './lock_closed.svg?raw';
import ppf from './shield.svg?raw';
import sgb from './certificate.svg?raw';
import epf from './building_people.svg?raw';
// NPS (a pension paid from a date): Fluent's calendar clock, its one teal stop moved to blue.
import nps from './calendar_clock.svg?raw';
import categories from './bookmark.svg?raw';
import payees from './people.svg?raw';
import settings from './settings.svg?raw';
import edit from './edit.svg?raw';
import share from './people_add.svg?raw';

export const COLOUR_ICONS: Record<string, string> = {
	home, transactions, reports, inbox, accounts, bank, creditCard, fd, rd, loan, mutualFunds, stocks,
	gold, property, otherAsset, otherLiability, ppf, sgb, epf, eps: epf, nps, npsTier2: nps, categories, payees, settings, edit, share
};
