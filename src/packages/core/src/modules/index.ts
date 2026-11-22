/**
 * modules/index.ts — the ONLY place concrete modules meet the registry.
 *
 * Importing this file (or the package barrel, which imports it for its
 * side effect) registers every concrete instrument module. Nothing outside
 * this file should call `registerModule` directly, and — per the ESLint
 * import-boundary rule — nothing under `aggregation/` may import a concrete
 * module: aggregation reads the registry populated here, never a module
 * directly.
 */
import { registerModule } from '../aggregation/registry.js';
import { bankModule } from './bank.js';
import { creditCardModule } from './creditCard.js';
import { mutualFundsModule } from './mutualFunds.js';
import { stocksModule } from './stocks.js';
import { fdModule } from './fd.js';
import { rdModule } from './rd.js';
import { propertyModule } from './property.js';
import { goldModule } from './gold.js';
import { loanModule } from './loan.js';
import { otherAssetModule } from './otherAsset.js';
import { otherLiabilityModule } from './otherLiability.js';
import { ppfModule } from './ppf.js';
import { sgbModule } from './sgb.js';
import { epfModule } from './epf.js';
import { epsModule } from './eps.js';
import { npsModule } from './nps.js';
import { npsTier2Module } from './npsTier2.js';

// The v1 set (S5): the 11 modules, then PPF and SGB (launch list, S5 RD13).
// Registration order is the nav/add-picker order the app then regroups per the S1 fixed group
// order. Spending modules first, then the holding set; then EPF and its EPS (RD16);
// then NPS Tier I and Tier II (undeferred for the first release; S5 RD6).
registerModule(bankModule);
registerModule(creditCardModule);
registerModule(mutualFundsModule);
registerModule(stocksModule);
registerModule(fdModule);
registerModule(rdModule);
registerModule(propertyModule);
registerModule(goldModule);
registerModule(loanModule);
registerModule(otherAssetModule);
registerModule(otherLiabilityModule);
registerModule(ppfModule);
registerModule(sgbModule);
registerModule(epfModule);
registerModule(epsModule);
registerModule(npsModule);
registerModule(npsTier2Module);
