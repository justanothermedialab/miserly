/**
 * registry.ts — the module registry.
 *
 * The single source the nav, add-account picker, sections, and aggregation
 * all read to find "the module for this account type". Aggregation imports
 * the REGISTRY (this file) and the contract — NEVER a concrete module; the
 * ESLint import-boundary rule enforces that (src/eslint.config.js).
 *
 * Registration is a one-time side effect performed by `modules/index.ts` at
 * import; the package barrel imports that module so the registry is populated
 * for consumers. Duplicate registration throws (a wiring bug, caught loudly).
 */
import type { InstrumentModule } from './contract.js';

const registry = new Map<string, InstrumentModule>();

/** Register a module under its `type` key. Throws if that key is already taken. */
export function registerModule(module: InstrumentModule): void {
  if (registry.has(module.type)) {
    throw new Error(`registerModule: a module is already registered for type '${module.type}'`);
  }
  registry.set(module.type, module);
}

/** Look up the module for an account type. Throws if no module is registered for `type`. */
export function getModule(type: string): InstrumentModule {
  const module = registry.get(type);
  if (module === undefined) {
    throw new Error(`getModule: no module registered for type '${type}'`);
  }
  return module;
}

/** Every registered module, in registration order. Used by nav/picker/conformance. */
export function allModules(): readonly InstrumentModule[] {
  return [...registry.values()];
}

/** True if a module is registered for `type`. */
export function hasModule(type: string): boolean {
  return registry.has(type);
}
