import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

/**
 * Password hashing for accounts on *this* system.
 *
 * scrypt rather than a plain SHA family: it is memory-hard, which makes
 * GPU-accelerated cracking expensive, and it ships with Node so there is no
 * dependency to audit. Parameters are encoded into the stored string **and read back
 * out of it**, so they can be raised later without invalidating existing hashes — a
 * verification that always derived with today's constants would turn every row
 * written at yesterday's cost into 「用户名或密码错误」, silently.
 *
 * Format: `scrypt$<N>$<r>$<p>$<salt-b64>$<hash-b64>`
 */

const SCHEME = 'scrypt'

/** Cost parameters for a **new** hash. N must be a power of two; these are the Node defaults. */
const COST = 16_384 // N
const BLOCK_SIZE = 8 // r
const PARALLELIZATION = 1 // p

const KEY_LENGTH = 64
const SALT_LENGTH = 16

/** The three cost parameters as one value: separately they mean nothing. */
export interface CostParameters {
  readonly cost: number
  readonly blockSize: number
  readonly parallelization: number
}

/**
 * What one parameter set asks scrypt to allocate: `128 * r * (N + p + 2)` bytes.
 *
 * This is **the runtime's** requirement, not this module's arithmetic, and it is stated once here for the
 * two places that need it: the policy check in `readParameters` and the boot-time pairing check on the
 * constants above.
 *
 * `128 * N * r` — this module's own figure until now — leaves out the `B` blocks scrypt allocates for the
 * `p` lanes (`128 * p * r`) and the two blocks the `V` array carries on top of `N`. The difference is not
 * academic: a stored row that sits *exactly* on the old arithmetic's ceiling was accepted by this module
 * and then refused by the runtime with `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`, so the module promised to
 * accept rows it could never verify, and the boot-time check would have called a raised `COST` a valid
 * pairing while every login failed.
 *
 * Measured on this runtime (Node 25, OpenSSL's `EVP_PBE_scrypt`) rather than read off a doc: for eight
 * parameter sets with `N` from 2 to 1024 and `p` from 1 to 4, the smallest `maxmem` that derives is this
 * sum **to the byte**, and one byte less is refused. The case in `tests/auth-password.test.ts` measures
 * one of them — `N = 16, r = 1, p = 3` derives at 2688 and not at 2687, where `128 * r * (N + 2)` would
 * have said 2304 and `128 * p * r` only 384. So `N = 524288, r = 2, p = 1`, the row the ceiling cases
 * below use, needs 134218496: 768 bytes past the ceiling, which is why it was the row the old arithmetic
 * accepted and the runtime then refused.
 */
export function scryptMemoryBytes(parameters: CostParameters): number {
  return 128 * parameters.blockSize * (parameters.cost + parameters.parallelization + 2)
}

/**
 * The most memory a stored row may ask for.
 *
 * Reading the parameters back makes a row a memory request, so it needs a ceiling: without one, a
 * hand-edited row could ask for gigabytes on the next login attempt. 128 MiB is 134217728 bytes against
 * the 16780288 the constants above need — nearly eight times as much, which leaves room to raise the cost
 * a few times (the point of carrying the parameters at all) while keeping one row from becoming an
 * allocation nobody chose. It is handed to scrypt as `maxmem` so the ceiling is enforced by the runtime as
 * well as by the arithmetic below, which is also why the arithmetic has to be the runtime's own expression
 * (`scryptMemoryBytes`).
 */
const MAX_MEMORY_BYTES = 128 * 1024 * 1024

/**
 * The ceiling has to cover what the constants above need, or raising `COST` would stop verifying instead
 * of being honoured — every row would fall out of `readParameters` and every login would read
 * 「用户名或密码错误」. Checked here, at import, so that pairing mistake is a boot failure rather than a
 * silent one — and checked with the runtime's own expression, because a check that uses a smaller number
 * than scrypt does is a check that passes while every login fails.
 */
const CURRENT_MEMORY_BYTES = scryptMemoryBytes({ cost: COST, blockSize: BLOCK_SIZE, parallelization: PARALLELIZATION })
if (CURRENT_MEMORY_BYTES > MAX_MEMORY_BYTES) {
  throw new Error(
    `scrypt parameters need ${String(CURRENT_MEMORY_BYTES)} bytes but MAX_MEMORY_BYTES is ${String(MAX_MEMORY_BYTES)}`
  )
}

/**
 * Policy ceilings on a stored row's `r` and `p`.
 *
 * The memory ceiling alone is not enough: `p` multiplies scrypt's work without
 * touching its memory at all, so a row with a huge `p` and a tiny `N` passes the
 * memory check and then occupies a core for hours on one login attempt. These are far
 * above the constants above — which they describe a loosening of, not a replacement
 * for — and far below anything that could do that.
 */
const MAX_BLOCK_SIZE = 32
const MAX_PARALLELIZATION = 16

const CURRENT: CostParameters = { cost: COST, blockSize: BLOCK_SIZE, parallelization: PARALLELIZATION }

/** Promisified scrypt with an explicit signature (the overloads confuse promisify). */
function derive(password: string, salt: Buffer, keyLength: number, parameters: CostParameters): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keyLength,
      {
        N: parameters.cost,
        r: parameters.blockSize,
        p: parameters.parallelization,
        maxmem: MAX_MEMORY_BYTES
      },
      (error, derivedKey) => {
        if (error) reject(error)
        else resolve(derivedKey)
      }
    )
  })
}

/** Reads one parameter as the plain decimal digits this module writes. */
function readInteger(text: string | undefined): number | null {
  if (text === undefined || !/^\d+$/.test(text)) return null
  return Number.parseInt(text, 10)
}

/**
 * Reads `N`, `r` and `p` back out of a stored string.
 *
 * `null` for anything this system would not have written — a corrupted or hand-edited
 * row is a failed login, not a server error and not an allocation the runtime gets to
 * size. N is checked for the power-of-two scrypt requires rather than trusted: a
 * non-power-of-two would otherwise reach the native call and be reported as an
 * internal fault from a login attempt.
 */
function readParameters(parts: readonly (string | undefined)[]): CostParameters | null {
  const cost = readInteger(parts[1])
  const blockSize = readInteger(parts[2])
  const parallelization = readInteger(parts[3])
  if (cost === null || blockSize === null || parallelization === null) return null
  if (cost < 2 || Math.log2(cost) % 1 !== 0) return null
  if (blockSize < 1 || blockSize > MAX_BLOCK_SIZE) return null
  if (parallelization < 1 || parallelization > MAX_PARALLELIZATION) return null
  // The ceiling, stated the way the runtime states it (`scryptMemoryBytes`): a row whose requirement is
  // above it is one this system cannot verify — `scrypt` would refuse it — rather than one that gets to
  // size an allocation on the way to being refused. The two checks being the same expression is the
  // point: while they differed by the `(p + 2)` term, a row could pass this one and be refused by the
  // runtime, so this module's answer and the runtime's could not be told apart from outside.
  if (scryptMemoryBytes({ cost, blockSize, parallelization }) > MAX_MEMORY_BYTES) return null
  return { cost, blockSize, parallelization }
}

/** Hashes a password for storage. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH)
  const hash = await derive(password, salt, KEY_LENGTH, CURRENT)
  return [
    SCHEME,
    CURRENT.cost,
    CURRENT.blockSize,
    CURRENT.parallelization,
    salt.toString('base64'),
    hash.toString('base64')
  ].join('$')
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns false for malformed hashes instead of throwing: a corrupted row is a
 * failed login, not a server error. The memory check above now states the runtime's
 * own requirement to the byte, so a row over the ceiling is refused there; this
 * `catch` is for whatever `scrypt` refuses that those checks do not model — chiefly
 * the key length, which comes from the row's own hash and which nothing here bounds.
 * The comparison is constant-time so the response latency does not leak how much of
 * the hash matched.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6) return false
  if (parts[0] !== SCHEME) return false

  const parameters = readParameters(parts)
  if (parameters === null) return false

  const saltB64 = parts[4]
  const hashB64 = parts[5]
  if (saltB64 === undefined || hashB64 === undefined) return false

  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(saltB64, 'base64')
    expected = Buffer.from(hashB64, 'base64')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false

  let actual: Buffer
  try {
    actual = await derive(password, salt, expected.length, parameters)
  } catch {
    // Whatever scrypt itself refuses — a key length the row's own hash asked for, say,
    // which the three checks above never looked at — is a row this system did not
    // write. Reported as a failed login, which is this module's answer for a corrupted
    // row everywhere else too.
    return false
  }
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

/** Minimum accepted password length, enforced at the API boundary too. */
export const MIN_PASSWORD_LENGTH = 8

/** Username constraints, shared by the route validator and the UI. */
export const USERNAME_PATTERN = /^[A-Za-z0-9_\u4e00-\u9fa5]{3,24}$/
