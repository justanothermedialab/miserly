/**
 * Tests for the module registry, exercised through the concrete Bank/Credit
 * Card modules registered by the package barrel's side-effect import.
 */
import { describe, expect, it } from 'vitest';
import '../src/index.js';
import { allModules, getModule, hasModule, registerModule } from '../src/aggregation/registry.js';
import { bankModule } from '../src/modules/bank.js';
import { creditCardModule } from '../src/modules/creditCard.js';

describe('registry: lookup', () => {
  it('resolves registered modules by type', () => {
    expect(getModule('bank')).toBe(bankModule);
    expect(getModule('creditCard')).toBe(creditCardModule);
  });

  it('hasModule reflects registration state', () => {
    expect(hasModule('bank')).toBe(true);
    expect(hasModule('nope')).toBe(false);
  });

  it('getModule throws for an unregistered type', () => {
    expect(() => getModule('nope')).toThrow();
  });

  it('allModules includes both registered modules', () => {
    const all = allModules();
    expect(all).toContain(bankModule);
    expect(all).toContain(creditCardModule);
  });
});

describe('registry: duplicate registration', () => {
  it('throws when registering a second module under an already-taken type', () => {
    expect(() => registerModule(bankModule)).toThrow();
  });
});
