import { test as base } from 'vitest'

import { closeDatabase, type Db, openDatabase } from '../src/db/index.js'
import { type BuiltServer, buildServer } from '../src/index.js'
import type { BackpackFetch } from '../src/routes/douyu-backpack.js'

/**
 * Shared per-test fixtures.
 *
 * The reason this is worth a large diff is a hole the compiler cannot see. A test
 * file that writes `let server: BuiltServer` and assigns it in `beforeEach`
 * typechecks no matter what happens to that hook: at module scope TypeScript takes
 * any `let` with a declared type as assigned, so a `beforeEach` that forgets one
 * of thirteen bindings — or a `describe` that re-declares the hook and drops a
 * line — stays green through `typecheck` and fails at run time instead, in
 * whichever case happens to run first, with a message about the value that was
 * missing rather than about the setup that never ran. `test.extend` closes that:
 * the fixture *is* the setup, a test asks for what it needs by name, and the type
 * of that name is the type of the value. No binding exists before its value does.
 *
 * The second reason is the recipe itself. `buildServer({ logger: false, dbPath:
 * ':memory:' })`, one registered user, and `closeDatabase()` afterwards is one
 * fact with eight homes; a fixture is how it gets one. `db` is the same fact for
 * the repository tests that want the handle without the HTTP layer.
 *
 * Three things this deliberately does not do:
 *
 *  - **It imposes no timer policy.** `douyu-bind.test.ts` runs three cases on real
 *    timers because the code under test sleeps through `node:timers/promises`,
 *    which `vi.useFakeTimers()` cannot reach; a `beforeEach` here that switched
 *    timers on would silently put those cases back on a clock they cannot use.
 *  - **It registers no Platform.** `registry.ts` has no unregister, so a stub is
 *    per-file state that has to stay visible in the file that owns it.
 *  - **It hides nothing a test asserts.** `session` is one user, registered
 *    through the real route; a file that needs a different name or a second user
 *    overrides or calls `registerUser` itself.
 */

/** A registered user and the header that authenticates as it. */
export interface Session {
  readonly username: string
  readonly userId: number
  readonly token: string
  /** This session's `Authorization` header, or another token's when given one. */
  readonly auth: (token?: string) => Record<string, string>
}

/**
 * The HTTP layer's clock, as a mutable holder.
 *
 * `buildServer` reads `now` once, at wiring time, so passing an instant only
 * helps if a test can move it afterwards: the `settledTodayKeys` cases in
 * `tasks.test.ts` pin one midnight, assert the answer, then pin the second after
 * it and assert that the answer moved. Null is the real clock, which is what
 * every other file reads.
 */
export interface TestClock {
  pinnedAt: number | null
}

/**
 * The transport behind every choice source, as a mutable holder.
 *
 * A holder rather than a `let`, for the reason `TestClock` is one: the server reads the wiring once,
 * at build time, so a test can only change the answer if the function it was given reads through
 * something it can still reach. The default refuses, so a suite that forgets to stub it fails loudly
 * instead of opening a socket.
 */
export interface OptionFetch {
  current: BackpackFetch
}

/** The minimum the auth routes accept. A test's placeholder, not a secret. */
const PASSWORD = 'password123'

/** Registers one user through the real route. Files that need a second user call this. */
export async function registerUser(server: BuiltServer, username: string): Promise<Session> {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: PASSWORD }
  })
  const body = response.json<{ token: string; user: { id: number } }>()
  return {
    username,
    userId: body.user.id,
    token: body.token,
    auth: (token = body.token) => ({ authorization: `Bearer ${token}` })
  }
}

export const test = base.extend<{
  clock: TestClock
  optionFetch: OptionFetch
  server: BuiltServer
  session: Session
  db: Db
}>({
  // biome-ignore lint/correctness/noEmptyPattern: Vitest requires a fixture's first parameter to be a destructuring pattern, empty when it names no dependencies.
  clock: ({}, use) => use({ pinnedAt: null }),

  /**
   * The transport a choice source reads over, as a swappable holder.
   *
   * Default: a refusal, because **a test that reaches a Platform by accident is worse than one that
   * fails**. A file that wants a live read's own behaviour assigns `holder.current`, and that is the
   * only substitution — the reader, the source, the route and the envelope shape are all the
   * shipping ones, so what a file asserts is what a page would be shown.
   */
  // biome-ignore lint/correctness/noEmptyPattern: same shape as `clock`: a value, no dependencies.
  optionFetch: ({}, use) =>
    use({
      current: async () => {
        throw new Error('this test did not stub the option transport')
      }
    }),

  server: async ({ clock, optionFetch }, use) => {
    const server = buildServer({
      logger: false,
      dbPath: ':memory:',
      now: () => clock.pinnedAt ?? Date.now(),
      optionFetch: (url, init) => optionFetch.current(url, init)
    })
    await use(server)
    await server.app.close()
    closeDatabase()
  },

  session: async ({ server }, use) => {
    await use(await registerUser(server, 'tester'))
  },

  // The handle without the HTTP layer, for the repository tests. `openDatabase` is a
  // process-wide singleton, so closing it is what makes one test's rows invisible
  // to the next — the same reason `server` closes it too.
  // biome-ignore lint/correctness/noEmptyPattern: same shape as `clock`: a teardown, no dependencies.
  db: async ({}, use) => {
    const db = openDatabase(':memory:')
    await use(db)
    closeDatabase()
  }
})
