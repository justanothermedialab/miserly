/**
 * Shared universal conformance checks for any `InstrumentModule` — GENERAL
 * on purpose (must also pass for a future non-ledger module), so this does
 * NOT assert anything ledger-specific (e.g. `currentValue === balanceAsOf`);
 * that lives in the per-module test. Not a test file itself (excluded by
 * vitest's `test/**\/*.test.ts` include pattern).
 */
import { expect } from 'vitest';
import type { AccountView, InstrumentModule, Period } from '../src/aggregation/contract.js';
import type { PlainDate } from '../src/date.js';

const VALID_SIDES = ['Asset', 'Liability'];
const VALID_LIQUIDITY = ['Liquid', 'Semi', 'Illiquid'];
const VALID_CARDINALITY = ['collection', 'single-active'];
const VALID_ACCOUNT_CLASS = ['spending', 'holding'];

/**
 * Run universal contract checks against `module`, using `sample` as the
 * account and `asOf`/`period` as the query points.
 */
export function assertModuleConforms(
  module: InstrumentModule,
  sample: AccountView,
  asOf: PlainDate,
  period: Period,
): void {
  // Metadata enums are valid.
  expect(VALID_SIDES).toContain(module.metadata.side);
  expect(VALID_LIQUIDITY).toContain(module.metadata.liquidity);
  expect(VALID_CARDINALITY).toContain(module.metadata.cardinality);
  expect(VALID_ACCOUNT_CLASS).toContain(module.metadata.accountClass);
  expect(typeof module.metadata.markable).toBe('boolean');

  // Registry key is a non-empty string.
  expect(typeof module.type).toBe('string');
  expect(module.type.length).toBeGreaterThan(0);

  // currentValue / costBasis are Money in the account's currency.
  const currentValue = module.currentValue(sample, asOf);
  expect(currentValue.currency).toBe(sample.currency);
  const costBasis = module.costBasis(sample, asOf);
  expect(costBasis.currency).toBe(sample.currency);

  // cashFlows are non-negative magnitudes in the account's currency.
  const flows = module.cashFlows(sample, period);
  expect(flows.inflow.currency).toBe(sample.currency);
  expect(flows.outflow.currency).toBe(sample.currency);
  expect(flows.inflow.paise).toBeGreaterThanOrEqual(0);
  expect(flows.outflow.paise).toBeGreaterThanOrEqual(0);

  // Determinism: calling currentValue twice gives equal results.
  const currentValueAgain = module.currentValue(sample, asOf);
  expect(currentValueAgain.equals(currentValue)).toBe(true);
}
