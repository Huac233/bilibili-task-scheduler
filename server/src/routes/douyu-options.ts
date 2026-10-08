import type { ChoiceRead, ChoiceSource, ChoiceSourceRegistry } from '../actions/action-options.js'
import { parseCredential } from '../platform/douyu/index.js'
import { getAccountCredentials } from '../repo/accounts.js'
import { type BackpackFetch, readDouyuBackpack } from './douyu-backpack.js'

/**
 * The one Platform whose actions declare option fields, wired to the reads their choices come from.
 *
 * This is the only file in this build that names a Platform while declaring what an option field's
 * choices are — and it is a file of `routes/**` rather than of `platform/**` for the reason
 * `actions/action-options.ts` records: the field declarations are `platform/**`'s business and are
 * waiting to move back there, while wiring them needs the storage handle and a transport, which
 * `platform/**` has no reason to know about.
 *
 * **The credential stays on this side of the seam.** `parseCredential` is the adapter's own reader
 * — imported rather than reimplemented, so the blob's shape has one reader — and the two halves the
 * backpack call needs are taken out of what it returns and handed straight to the reader. No part
 * of the blob is returned, logged, or put in a message by anything here.
 */

/** The source the 亲密度任务 field declares. Also the key the route is asked about. */
export const BACKPACK_SOURCE = 'douyu.backpack'

/**
 * Registers Douyu's choice sources. Called once, where the server is built.
 *
 * The transport is a parameter rather than `globalThis.fetch` read here, so the call a suite drives
 * and the call production makes are the same code path with one substitution — which is what makes
 * "nothing leaves this build's credential in a request log" an assertion instead of a claim.
 */
export function registerDouyuOptionSources(
  registry: ChoiceSourceRegistry,
  db: Parameters<typeof getAccountCredentials>[0],
  fetchImpl: BackpackFetch
): void {
  registry.register(backpackSource(db, fetchImpl))
}

function backpackSource(db: Parameters<typeof getAccountCredentials>[0], fetchImpl: BackpackFetch): ChoiceSource {
  return {
    key: BACKPACK_SOURCE,
    read: async (accountId: number): Promise<ChoiceRead> => {
      const blob = getAccountCredentials(db, accountId)
      // Two separate states, because they need two different sentences: an account row that is gone
      // is a re-bind, while a blob this build cannot read is the paste path having stored
      // something unusable. Reporting both as "no credential" hides the second.
      if (blob === null) return { kind: 'unavailable', reason: '这个账号已经不在了，先重新绑定一次。' }

      const credential = parseCredential(blob)
      if (credential === null) {
        return { kind: 'unavailable', reason: '这个账号的凭据读不出来，重新扫码绑定一次就能读到背包。' }
      }

      return await readDouyuBackpack({ token: credential.token, webCookies: credential.webCookies }, fetchImpl)
    }
  }
}
