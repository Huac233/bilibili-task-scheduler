import type { DatabaseSync } from 'node:sqlite'

/**
 * Transactions.
 *
 * `node:sqlite` has no transaction helper of its own, and a partially applied
 * import would leave a library with a bullet count that does not match its rows —
 * so every multi-statement write goes through here.
 *
 * It lives in its own module because it has two callers that cannot see each
 * other: `db/index.ts`'s schema setup and `db/migrations.ts`. `index.ts` imports
 * `migrations.ts`, so a shared helper kept there would have been a cycle, and the
 * copy inlined into `runMigrations` was the result. Nothing in this file imports
 * anything, which is what makes it usable from both.
 *
 * **A savepoint rather than `BEGIN`.** `BEGIN` inside an open transaction is an
 * error — "cannot start a transaction within a transaction" — so a nested call
 * used to be a crash rather than a join. `SAVEPOINT` is the same thing one level
 * down: the outermost one starts an implicit transaction exactly as `BEGIN` does,
 * and an inner one rolls back only its own `fn`, leaving whatever the outer call
 * had already written in place. That is the behaviour a caller expects from
 * "transaction", nested or not, so there is one path here rather than a depth
 * check and two code paths that differ only in their spelling.
 */

/** Distinguishes concurrent savepoints. Never reaches SQL from anywhere but here. */
let sequence = 0

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  sequence += 1
  const savepoint = `bts_tx_${String(sequence)}`
  db.exec(`SAVEPOINT ${savepoint}`)

  try {
    const result = fn()
    db.exec(`RELEASE ${savepoint}`)
    return result
  } catch (error: unknown) {
    // `ROLLBACK TO` leaves the savepoint itself on the stack, so it is released
    // after the rollback rather than being left for a later call to trip over.
    db.exec(`ROLLBACK TO ${savepoint}`)
    db.exec(`RELEASE ${savepoint}`)
    throw error
  }
}
