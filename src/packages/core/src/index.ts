// CORE_READY is the web<->core liveness marker (checked by apps/web's smoke
// test and page). Keep exporting it even as real engine surface is added.
export const CORE_READY = true;

export { Money } from './money.js';
export type { CurrencyCode } from './money.js';

export {
  systemClock,
  isTimeZone,
  parseDate,
  formatDate,
  compareDates,
  datesEqual,
  today,
} from './date.js';
export type { PlainDate, Clock } from './date.js';

export type { Transaction, TransactionKind } from './transaction.js';

export { compareTransactions, sortTransactions, nextSequence } from './ordering.js';

export {
  orderedBalance,
  runningBalances,
  balanceAsOf,
  projectedBalance,
} from './ledger.js';
export type { RunningBalanceRow } from './ledger.js';

export type {
  Side,
  Liquidity,
  Cardinality,
  AccountStatus,
  AccountClass,
  ModuleMetadata,
  AccountView,
  Period,
  CashFlows,
  InstrumentModule,
  AccountValuation,
} from './aggregation/contract.js';

export { registerModule, getModule, allModules, hasModule } from './aggregation/registry.js';

export { toBase, hasRate, rateTable } from './fx.js';
export type { Rate, RateTable } from './fx.js';

export {
  valuationOf,
  netWorth,
  allocationBySide,
  allocationByClass,
  allocationByLiquidity,
} from './aggregation/networth.js';
export type { Aggregated } from './aggregation/networth.js';

export { holdingReturn } from './aggregation/holdingReturn.js';
export type { HoldingReturn } from './aggregation/holdingReturn.js';

export {
  annualReturn,
  holdingFlows,
  lastValueDate,
  setsValue,
  closedEndDate,
  holdingEarned,
  valueInvestedSeries,
  xirr,
} from './aggregation/annualReturn.js';
export type { DatedFlow, HoldingFlows, ValueInvestedPoint } from './aggregation/annualReturn.js';

export { monthEndPoints, netWorthSeries } from './aggregation/history.js';
export type { NetWorthPoint, ExistsAsOf } from './aggregation/history.js';

export { createLedgerValuedModule } from './modules/ledgerValued.js';
export { createHoldingValuedModule } from './modules/holdingValued.js';
export { bankModule } from './modules/bank.js';
export { creditCardModule } from './modules/creditCard.js';
export { mutualFundsModule } from './modules/mutualFunds.js';
export { stocksModule } from './modules/stocks.js';
export { fdModule } from './modules/fd.js';
export { rdModule } from './modules/rd.js';
export { propertyModule } from './modules/property.js';
export { goldModule } from './modules/gold.js';
export { loanModule } from './modules/loan.js';
export { otherAssetModule } from './modules/otherAsset.js';
export { otherLiabilityModule } from './modules/otherLiability.js';
export { ppfModule } from './modules/ppf.js';
export { sgbModule } from './modules/sgb.js';
export { epfModule } from './modules/epf.js';
export { epsModule } from './modules/eps.js';
export { npsModule } from './modules/nps.js';
export { npsTier2Module } from './modules/npsTier2.js';

// Side-effect import: populates the module registry when the barrel loads.
import './modules/index.js';
