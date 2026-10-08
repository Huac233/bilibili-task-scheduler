import type { SQLOutputValue } from 'node:sqlite'

/**
 * Readers for one column of a `node:sqlite` row.
 *
 * Why these are here and not in each `repo/*` module: every repository reads
 * `Record<string, SQLOutputValue>` rows, so the same narrowing was copy-pasted
 * into twelve modules — `repo/{accounts,action-logs,action-settings,api-tokens,
 * bili-accounts,events,libraries,replacements,send-logs,tasks,users}.ts` and
 * `db/migrations.ts`. `repo/**` already imports `db/**`, so this direction adds
 * no coupling that did not exist; a copy per module only meant that a change to
 * a reader had twelve homes, and a reader with one home is the whole point.
 *
 * Two properties are load-bearing, and both were easy to lose in a merge:
 *
 *  - **Every integer reader understands `bigint`.** `node:sqlite` hands back a
 *    big integer as `bigint` rather than `number`, so a reader that only checked
 *    `typeof value === 'number'` would turn a real column value into the
 *    fallback — a stored id silently reading as `0`, or a set flag reading as
 *    unset. `Number(value)` keeps the value.
 *  - **The fallback argument is part of the interface.** `NULL` and a
 *    wrong-typed column both read as the fallback, and callers depend on the
 *    default they pass: `asString(value, TaskStatus.Waiting)` and
 *    `asBoolean(value, true)` mean "absent column stays compatible with the
 *    behaviour this row had before the column existed". Dropping the parameter
 *    would quietly change what an absent value means.
 *
 * `asBoolean` is the one reader whose copies were not textually identical: the
 * three sites were `(value)`, `(value, fallback = false)` and
 * `(value, fallback = false)`, and the arity-only difference was a spelling
 * difference, not a semantic one — all three read a `number`/`bigint` as
 * non-zero and everything else as false. Merged onto the two-argument form,
 * every existing call site keeps its exact behaviour.
 */

/** Signed/unsigned integer column, or `fallback` when it is absent or not numeric. */
export function asNumber(value: SQLOutputValue | undefined, fallback = 0): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return fallback
}

/** Nullable integer column. `NULL` stays `null` — the caller's column has no fallback. */
export function asNumberOrNull(value: SQLOutputValue | undefined): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return null
}

/** `TEXT` column, or `fallback` when it is absent. An empty string is a value, not absence. */
export function asString(value: SQLOutputValue | undefined, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * A column whose values may arrive as either text or a number, read as text.
 *
 * **It exists for exactly one column and the reason is worth stating.** `send_logs.code` is declared
 * `INTEGER`, which is a storage class rather than a constraint: SQLite's INTEGER affinity converts a
 * numeric string on the way in and stores anything else as text, so a Platform code of `10030`
 * comes back as a *number* while a symbolic one (`bad_target`, `relay_full`) comes back as a
 * *string* — from the same column, in the same table. `asString` would read the first as `''`, which
 * is precisely the "silent 0" this column was just repaired out of, so the two classes are folded
 * here instead of at each reader.
 *
 * The alternative — a migration rewriting the column to `TEXT` — is the right end state and is not
 * what a reader needs to be correct today; until it happens, upgraded and freshly created databases
 * hold the two classes side by side, so the reader has to handle both either way. `action_logs.code`
 * is the same fact already declared `TEXT`.
 */
export function asText(value: SQLOutputValue | undefined, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'bigint') return String(value)
  return fallback
}

/** `INTEGER` column read as a flag, where the column's own default is the `fallback`. */
export function asBoolean(value: SQLOutputValue | undefined, fallback = false): boolean {
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'bigint') return value !== 0n
  return fallback
}
