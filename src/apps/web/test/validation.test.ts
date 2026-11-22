/**
 * validation.test.ts — the capture boundary transform (transactionCreateSchema).
 * ============================================================================
 * The register/quick-add form sends two amount COLUMNS (inflow/outflow) as
 * rupee strings; the boundary must (a) accept EXACTLY ONE, (b) convert rupees →
 * integer paise, and (c) encode direction as the SIGN (inflow +, outflow −) —
 * the shape `createTransaction` consumes. This proves that transform in
 * isolation, since a bug here would misprice or misdirect every captured row.
 * ============================================================================
 */
import { describe, expect, it } from 'vitest';
import { parseForm, transactionCreateSchema } from '../src/lib/server/validation';

/** Build a FormData from a plain record (what the route passes to parseForm). */
function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

describe('transactionCreateSchema: direction + rupees→paise', () => {
  it('an outflow-only form yields a NEGATIVE amount in paise', () => {
    const r = parseForm(transactionCreateSchema, fd({ date: '2024-02-01', outflow: '250.50' }));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.amountPaise).toBe(-25050);
      expect(r.data.payeeName).toBeNull();
      expect(r.data.categoryId).toBeNull();
      expect(r.data.notes).toBeNull();
    }
  });

  it('an inflow-only form yields a POSITIVE amount in paise', () => {
    const r = parseForm(transactionCreateSchema, fd({ date: '2024-02-01', inflow: '1000' }));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.amountPaise).toBe(100000);
  });

  it('collapses payee/category/notes to null when blank, keeps them when set', () => {
    const r = parseForm(
      transactionCreateSchema,
      fd({ date: '2024-02-01', inflow: '5', payee: '  Amazon ', category: 'c1', notes: 'lunch' }),
    );
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.payeeName).toBe('Amazon');
      expect(r.data.categoryId).toBe('c1');
      expect(r.data.notes).toBe('lunch');
    }
  });

  it('rejects BOTH columns filled (ambiguous direction)', () => {
    const r = parseForm(transactionCreateSchema, fd({ date: '2024-02-01', inflow: '10', outflow: '5' }));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.errors.outflow).toBeDefined();
  });

  it('rejects NEITHER column filled', () => {
    const r = parseForm(transactionCreateSchema, fd({ date: '2024-02-01' }));
    expect(r.success).toBe(false);
  });

  it('rejects a minus sign in a column (direction is by column, not sign)', () => {
    const r = parseForm(transactionCreateSchema, fd({ date: '2024-02-01', outflow: '-5' }));
    expect(r.success).toBe(false);
  });

  it('rejects a malformed date', () => {
    const r = parseForm(transactionCreateSchema, fd({ date: '01/02/2024', inflow: '5' }));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.errors.date).toBeDefined();
  });

  it('rejects more than two decimal places', () => {
    const r = parseForm(transactionCreateSchema, fd({ date: '2024-02-01', inflow: '5.005' }));
    expect(r.success).toBe(false);
  });
});
