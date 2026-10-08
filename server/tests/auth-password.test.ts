import { randomBytes, scrypt } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { hashPassword, scryptMemoryBytes, verifyPassword } from '../src/auth/password.js'

/**
 * Password hashing, at its own seam.
 *
 * The behaviour worth a test is not the round trip — it is what happens to a row that
 * was written **before** someone raised the cost. The stored string carries `N`, `r`
 * and `p` for exactly that reason, so a verification that derived with today's
 * constants would be reading the parameters and then ignoring them: the person sees
 * 「用户名或密码错误」 on every account, on the day of the change, with nothing in a log.
 *
 * The fixtures below are built with `node:crypto` directly rather than by editing the
 * module's constants, so the tests state the property (a row verifies against its own
 * parameters) instead of the mechanism.
 */

/** The key length `password.ts` writes; the format carries it implicitly as the hash's length. */
const KEY_LENGTH = 64

/**
 * `node:crypto` with one wrapper on it: every `scrypt` call this process makes, recorded.
 *
 * Delegating to the real function is what keeps the fixtures in this file genuine — a hash below is
 * still derived by the runtime at exactly the parameters it claims — and the record is the **only**
 * observer that can tell 「the module refused this row」 from 「`scrypt` refused it」. Both come out of
 * `verifyPassword` as `false`, which is why the memory ceiling needs a witness inside the process to be
 * testable at all; the ceiling cases below are what use it.
 */
const { derivations } = vi.hoisted(() => ({ derivations: [] as unknown[] }))

vi.mock('node:crypto', async importOriginal => {
  const real = await importOriginal<typeof import('node:crypto')>()
  return {
    ...real,
    scrypt: (...args: Parameters<typeof real.scrypt>) => {
      derivations.push(args[3])
      return real.scrypt(...args)
    }
  }
})

/**
 * Whether the runtime derives this parameter set within `maxmem`, asked directly.
 *
 * `scrypt` reports a memory refusal by **throwing synchronously** rather than handing the error to the
 * callback — measured on this runtime, and the reason `password.ts`'s `derive` catches inside the
 * `Promise` executor. A helper that only awaited the callback would hang on the cases below that are
 * supposed to fail.
 */
function derivesAt(cost: number, blockSize: number, parallelization: number, maxmem: number): Promise<boolean> {
  return new Promise(resolve => {
    try {
      scrypt('pw', randomBytes(16), KEY_LENGTH, { N: cost, r: blockSize, p: parallelization, maxmem }, error => {
        resolve(error === null)
      })
    } catch {
      resolve(false)
    }
  })
}

/** Hedges the fixture's own budget so a raised cost here cannot fail for a reason of its own. */
const FIXTURE_MAX_MEMORY_BYTES = 256 * 1024 * 1024

function storedWith(password: string, cost: number, blockSize: number, parallelization: number): Promise<string> {
  const salt = randomBytes(16)
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      { N: cost, r: blockSize, p: parallelization, maxmem: FIXTURE_MAX_MEMORY_BYTES },
      (error, key) => {
        if (error) reject(error)
        else {
          resolve(
            ['scrypt', cost, blockSize, parallelization, salt.toString('base64'), key.toString('base64')].join('$')
          )
        }
      }
    )
  })
}

/** Rewrites one field of a stored string, the way a hand-edited row would look. */
function withField(stored: string, index: number, value: string): string {
  const parts = stored.split('$')
  parts[index] = value
  return parts.join('$')
}

describe('password hashing', () => {
  it('round-trips a password it hashed itself', async () => {
    const stored = await hashPassword('correct horse battery staple')

    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true)
    expect(await verifyPassword('correct horse battery stapl', stored)).toBe(false)
  })

  it('verifies a row written at a different cost instead of invalidating it', async () => {
    // Whatever `COST` is today, a row written at half of it and a row written at twice
    // it must both still verify. This is the assertion the module exists to keep true.
    const cheaper = await storedWith('correct horse', 8_192, 8, 1)
    const dearer = await storedWith('correct horse', 32_768, 4, 1)

    expect(await verifyPassword('correct horse', cheaper)).toBe(true)
    expect(await verifyPassword('correct horse', dearer)).toBe(true)
    // And reading the parameters back must not turn a wrong password into a right one.
    expect(await verifyPassword('wrong horse', cheaper)).toBe(false)
    expect(await verifyPassword('wrong horse', dearer)).toBe(false)
  })

  it('verifies a row with a different parallelization, which scrypt mixes in', async () => {
    const stored = await storedWith('correct horse', 8_192, 4, 2)

    expect(await verifyPassword('correct horse', stored)).toBe(true)
    expect(await verifyPassword('wrong horse', stored)).toBe(false)
  })

  it('reports a hand-edited row as a failed login rather than throwing', async () => {
    const stored = await storedWith('correct horse', 8_192, 8, 1)

    // A non-power-of-two N is not a set scrypt accepts; `0` and a non-number are not
    // sets this system writes.
    expect(await verifyPassword('correct horse', withField(stored, 1, '3'))).toBe(false)
    expect(await verifyPassword('correct horse', withField(stored, 1, '0'))).toBe(false)
    expect(await verifyPassword('correct horse', withField(stored, 1, 'many'))).toBe(false)
    // A cost far past the module's memory ceiling is refused before scrypt is called.
    expect(await verifyPassword('correct horse', withField(stored, 1, '1073741824'))).toBe(false)
    // A parallelization that would occupy a core for hours with almost no memory.
    expect(await verifyPassword('correct horse', withField(stored, 3, '1000000000'))).toBe(false)
  })

  /**
   * The three policy ceilings, each asserted **at the boundary and one step past it**.
   *
   * A cap nobody tests at its edge is a cap that can be deleted without a test going red, and these are
   * not scrypt's own limits — which is what makes them worth a case of their own. Every row below is a
   * *genuine* hash (`node:crypto` derives it at exactly the parameters it claims), and `N = 2` keeps the
   * memory trivial: `r = 33` and `p = 17` both derive happily in scrypt, so the refusal can only come from
   * `readParameters`'s policy. Without the fixtures being real, `false` would be the answer for a reason
   * the test could not name.
   */
  it('accepts r = 32 and refuses r = 33', async () => {
    const at = await storedWith('correct horse', 2, 32, 1)
    const past = await storedWith('correct horse', 2, 33, 1)

    expect(await verifyPassword('correct horse', at)).toBe(true)
    expect(await verifyPassword('correct horse', past)).toBe(false)
  })

  it('accepts p = 16 and refuses p = 17', async () => {
    const at = await storedWith('correct horse', 2, 1, 16)
    const past = await storedWith('correct horse', 2, 1, 17)

    expect(await verifyPassword('correct horse', at)).toBe(true)
    expect(await verifyPassword('correct horse', past)).toBe(false)
  })

  /**
   * The expression the module's bound is written as, measured against the runtime rather than believed.
   *
   * The parameter set is chosen so the three candidate formulas are three different numbers: `128 * p * r`
   * is 384 bytes, `128 * r * (N + 2)` is 2304, and the sum `128 * r * (N + p + 2)` is 2688. The runtime
   * asks for the sum — not for the larger of the two pieces, which 2304 would be — and it asks for it to
   * the byte: 2687 is refused, 2688 is not. `p = 3` is what makes the first two candidates differ from
   * the third, and `N = 16, r = 1` keep the derivation instant.
   *
   * This is the premise of everything below it. `128 * N * r` — the arithmetic this module used until
   * now — is none of the three.
   */
  it('states the memory requirement scrypt itself enforces, to the byte', async () => {
    const required = scryptMemoryBytes({ cost: 16, blockSize: 1, parallelization: 3 })
    expect(required).toBe(2_688)

    expect(await derivesAt(16, 1, 3, required)).toBe(true)
    expect(await derivesAt(16, 1, 3, required - 1)).toBe(false)
  })

  /**
   * The memory ceiling, at the boundary and one step past it.
   *
   * What this case can **not** do is fail when the ceiling is removed, and that is worth recording rather
   * than hiding: a row over the ceiling is refused by `scrypt` as well, and a refusal is a failed login
   * whichever side of the call it happens on. Removing `readParameters`' check would move the answer from
   * `false` to `false`.
   *
   * The arithmetic behind the ceiling is what changed here: the module refused a row when
   * `128 * N * r > MAX_MEMORY_BYTES` while the runtime needs `128 * r * (N + p + 2)`, so a row sitting
   * *exactly* on the ceiling — `N = 2^19, r = 2, p = 1` below — passed the module's check and was then
   * refused by 'scrypt' with `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`. Both checks now state the same number, so
   * what the module promises to accept is what the runtime accepts. The case after this one is what
   * watches the difference that is left: whether a derivation was attempted at all.
   */
  it('verifies below the memory ceiling, and refuses a genuine row at it and one step past it', async () => {
    // `128 * 2^18 * 3` is 96 MiB, and the runtime needs 128 * 3 * (2^18 + 1 + 2) = 100664448 of it: a real
    // row this build could have written at a raised cost, and the half of the pair that goes red if the
    // ceiling is ever lowered onto the rows in the table.
    const below = await storedWith('correct horse', 262_144, 3, 1)
    expect(await verifyPassword('correct horse', below)).toBe(true)

    // `128 * 2^19 * 2` is exactly 128 MiB by the old arithmetic, and 134218496 by the runtime's: 768 bytes
    // over the ceiling, which is why this row is the one that tells the two formulas apart. `N < 2^(16 * r)`
    // holds, so the parameter set itself is one scrypt accepts — the row is real, and it is refused.
    const atCeiling = await storedWith('correct horse', 524_288, 2, 1)
    expect(await verifyPassword('correct horse', atCeiling)).toBe(false)

    // One parameter step past the ceiling: `r = 3` is the smallest integer change that crosses it (192
    // MiB). Rewriting the field rather than deriving is deliberate — a row whose demand is over the
    // ceiling cannot be derived here at all, and that is the point of the ceiling.
    expect(await verifyPassword('correct horse', withField(atCeiling, 2, '3'))).toBe(false)
  })

  /**
   * The ceiling as a decision the module makes rather than one it leaves to the runtime — the only
   * observable the corrected bound has.
   *
   * The row is the same one as above: genuine, over the ceiling by 768 bytes. Before, `readParameters`
   * accepted it and `scrypt` refused it; now the module refuses it, and `scrypt` is never asked to
   * allocate for it. From outside the process both are a failed login, so the witness has to be inside —
   * the recorded derivations — and it is the honest limit of this test as much as its mechanism: what it
   * protects is that the module's promise binds, not that a hand-edited row behaves differently.
   */
  it('refuses a row over the ceiling without asking scrypt to allocate for it', async () => {
    const atCeiling = await storedWith('correct horse', 524_288, 2, 1)

    const before = derivations.length
    expect(await verifyPassword('correct horse', atCeiling)).toBe(false)

    expect(derivations.length).toBe(before)
  })

  it('rejects a malformed row without throwing', async () => {
    expect(await verifyPassword('correct horse', '')).toBe(false)
    expect(await verifyPassword('correct horse', 'scrypt$16384$8$1$onlyfivefields')).toBe(false)
    expect(await verifyPassword('correct horse', 'bcrypt$16384$8$1$c2FsdA==$aGFzaA==')).toBe(false)
    expect(await verifyPassword('correct horse', 'scrypt$16384$8$1$$aGFzaA==')).toBe(false)
  })
})
