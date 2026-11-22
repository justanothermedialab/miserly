/**
 * validation.ts — the F1/F2/F3 form-input schemas (valibot) + a FormData helper.
 * ============================================================================
 * Routes parse raw `FormData` through these before touching a service, so the
 * service layer always receives well-typed, already-coerced input (name trimmed,
 * currency upper-cased, rupees → integer paise) and the boundary owns all the
 * "friendly message per field" logic. `parseForm` flattens valibot's issues into
 * a flat `{ field: message }` map an action returns via SvelteKit `fail(400, …)`.
 *
 * Money crosses the boundary here: forms send RUPEES as a string; we validate at
 * most two decimals and convert to INTEGER paise (never a float that could drift).
 * Dates are civil 'YYYY-MM-DD' strings. No FX/rate math (M9) — currency is stored
 * as a plain 3-letter code only.
 * ============================================================================
 */
import { isRealDate } from '../dates';
import { textProblem, type TextKind } from '../text-limits';
import * as v from 'valibot';

/** A flat field → first-error-message map, ready for `fail(400, { errors })`. */
export type FieldErrors = Record<string, string>;

export type ParseResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly errors: FieldErrors };

/** Collect a FormData into a plain string record (ignoring any File entries). */
export function formToRecord(form: FormData): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') record[key] = value;
  }
  return record;
}

/**
 * Parse a FormData through a valibot schema, returning either the typed output
 * or a flat field-error map. Root-level issues land under the `_` key.
 */
export function parseForm<TSchema extends v.GenericSchema>(
  schema: TSchema,
  form: FormData,
): ParseResult<v.InferOutput<TSchema>> {
  const result = v.safeParse(schema, formToRecord(form));
  if (result.success) {
    return { success: true, data: result.output };
  }
  const flat = v.flatten(result.issues);
  const errors: FieldErrors = {};
  if (flat.nested) {
    for (const [field, messages] of Object.entries(flat.nested)) {
      if (messages && messages.length > 0) errors[field] = messages[0]!;
    }
  }
  if (flat.root && flat.root.length > 0) errors._ = flat.root[0]!;
  return { success: false, errors };
}

// ── shared field pieces ─────────────────────────────────────────────────────

/** A typed text within its kind's limit: hidden characters and over-long text refused. */
const withinLimit = (kind: Exclude<TextKind, 'password'>) =>
  v.rawCheck<string>(({ dataset, addIssue }) => {
    if (!dataset.typed) return;
    const problem = textProblem(dataset.value, kind);
    if (problem) addIssue({ message: problem });
  });

const requiredName = (message = 'Name is required', kind: Exclude<TextKind, 'password'> = 'name') =>
  v.pipe(v.string(), v.trim(), v.minLength(1, message), withinLimit(kind));

/** Optional typed text ('' when absent), trimmed and within its kind's limit. */
const optionalText = (kind: Exclude<TextKind, 'password'>) =>
  v.pipe(v.optional(v.string(), ''), v.trim(), withinLimit(kind));

/** Rupees string ("1000", "1000.50", "-250") → integer paise. ≤2 decimals only. */
/** Amounts are typed as people write them: `1,200`, `1,20,000` (lakh grouping), `₹500` or `$500`. */
const stripGrouping = v.transform((s: string) => s.replace(/[,\s₹$€£]/gu, ''));

export const rupeesToPaise = v.pipe(
  v.string(),
  v.trim(),
  stripGrouping,
  v.regex(/^-?\d+(\.\d{1,2})?$/u, 'Enter an amount like 1000 or 1000.50'),
  v.transform((s) => Math.round(Number(s) * 100)),
  // Beyond Number.MAX_SAFE_INTEGER paise the float math above silently loses
  // precision — reject instead (₹90 trillion is not a real ledger entry).
  v.check((paise) => Number.isSafeInteger(paise), 'Amount is too large'),
);

/** Optional hex colour: '' → null (no colour); otherwise must be #RRGGBB. */
const optionalColour = v.pipe(
  v.optional(v.string(), ''),
  v.trim(),
  v.transform((s): string | null => (s === '' ? null : s)),
  v.check(
    (s) => s === null || /^#[0-9a-fA-F]{6}$/u.test(s),
    'Use a hex colour like #46A758',
  ),
);

// ── F1: account ─────────────────────────────────────────────────────────────

/**
 * Account create. `opening` is RUPEES on the wire and becomes integer paise in
 * the output. `openingDate` is required (as 'YYYY-MM-DD') only when the opening
 * balance is non-zero — a zero opening carries no start date.
 */
export const accountCreateSchema = v.pipe(
  v.object({
    type: requiredName('Choose an account type'),
    name: requiredName('Give the account a name'),
    currency: v.pipe(
      v.string(),
      v.trim(),
      v.transform((s) => s.toUpperCase()),
      v.regex(/^[A-Z]{3}$/u, 'Use a 3-letter currency code, e.g. INR'),
    ),
    opening: rupeesToPaise,
    openingDate: v.pipe(
      v.optional(v.string(), ''),
      v.trim(),
      v.transform((s): string | null => (s === '' ? null : s)),
    ),
  }),
  v.forward(
    v.check(
      (input) =>
        input.opening === 0 ||
        (input.openingDate !== null && isRealDate(input.openingDate)),
      'A start date is required for a non-zero opening balance',
    ),
    ['openingDate'],
  ),
);
export type AccountCreateInput = v.InferOutput<typeof accountCreateSchema>;

// ── F2: category groups + categories ────────────────────────────────────────

const kindSchema = v.picklist(
  ['income', 'spending', 'neutral', 'investments'] as const,
  'Choose income, spending, neutral or investments',
);

export const groupCreateSchema = v.object({ name: requiredName(), kind: kindSchema });
export type GroupCreateInput = v.InferOutput<typeof groupCreateSchema>;

export const groupRenameSchema = v.object({ name: requiredName() });

export const categoryCreateSchema = v.object({
  name: requiredName(),
  colour: optionalColour,
});
export type CategoryCreateInput = v.InferOutput<typeof categoryCreateSchema>;

export const categoryRenameSchema = v.object({ name: requiredName() });

// ── F3: payee ───────────────────────────────────────────────────────────────

export const payeeNameSchema = v.object({ displayName: requiredName('Name is required', 'payee') });
export type PayeeNameInput = v.InferOutput<typeof payeeNameSchema>;

// ── C1/C2: transaction capture ───────────────────────────────────────────────

/** Civil date 'YYYY-MM-DD' and a real day, required (defaults to Today are applied client-side). */
const dateSchema = v.pipe(
  v.string(),
  v.trim(),
  v.check(isRealDate, 'Enter a valid date'),
);

/**
 * One amount column (Deposit/Inflow OR Withdrawal/Outflow). Blank → null (that
 * column is unused); otherwise a POSITIVE rupees amount → positive integer paise.
 * Direction is expressed by WHICH column carries the value, never by a minus
 * sign (C1 Validation) — so no leading '-' is accepted here.
 */
const amountColumn = v.pipe(
  v.optional(v.string(), ''),
  v.trim(),
  stripGrouping,
  v.check(
    (s) => s === '' || /^\d+(\.\d{1,2})?$/u.test(s),
    'Enter an amount like 500 or 500.50',
  ),
  v.transform((s): number | null => (s === '' ? null : Math.round(Number(s) * 100))),
  v.check(
    (p) => p === null || (Number.isSafeInteger(p) && p > 0),
    'Amount must be greater than zero',
  ),
);

/**
 * C1/C2 transaction create. Two amount columns; EXACTLY ONE must be filled
 * (both-empty or both-filled → reject, C1 Validation). The output is the shape
 * `createTransaction` expects: a SIGNED `amountPaise` (inflow +, outflow −),
 * with payee text / category id / notes collapsed to null when blank. The
 * account id is NOT part of this schema — the route supplies it (URL param for
 * the register, a form field for the global overlay) and the service gates it
 * through `accountsVisibleTo`. One schema for both entry surfaces (no divergence).
 */
export const transactionCreateSchema = v.pipe(
  v.object({
    date: dateSchema,
    inflow: amountColumn,
    outflow: amountColumn,
    payee: optionalText('payee'),
    category: v.pipe(v.optional(v.string(), ''), v.trim()),
    notes: optionalText('note'),
  }),
  v.forward(
    v.check(
      // XOR: exactly one column non-null.
      (i) => (i.inflow !== null) !== (i.outflow !== null),
      'Enter an amount in exactly one of Deposit or Withdrawal',
    ),
    ['outflow'],
  ),
  v.transform((i) => ({
    date: i.date,
    amountPaise: i.inflow !== null ? i.inflow : -(i.outflow as number),
    payeeName: i.payee === '' ? null : i.payee,
    categoryId: i.category === '' ? null : i.category,
    notes: i.notes === '' ? null : i.notes,
  })),
);
export type TransactionCreateInput = v.InferOutput<typeof transactionCreateSchema>;
