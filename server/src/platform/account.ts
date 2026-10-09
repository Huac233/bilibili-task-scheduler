import type { DatabaseSync } from 'node:sqlite'

import { type Account, getAccountCredentials, getAccountMeta } from '../repo/accounts.js'
import type { PlatformAccount } from './types.js'

/**
 * A stored account, in the shape an adapter takes.
 *
 * **One home for a mapping that had two, and the reason is the credential.** `runner.ts` loaded accounts
 * this way for the scheduler, and the resolve route needs the very same thing now that a target's label can
 * be read as the account the person picked. The seven fields are mechanical, which is exactly why a second
 * copy is dangerous: a field added to `PlatformAccount` and filled in one place would leave an adapter
 * seeing two different accounts depending on which caller reached it — and the credential, which is the
 * whole point of the shape, is the field a copy is most likely to get wrong.
 *
 * The credential and meta blobs are read here rather than carried on `Account`, because the list and read
 * helpers deliberately omit them: an accidental leak through a route handler is the failure mode that design
 * avoids. A caller that genuinely needs them asks explicitly, which is what this function is.
 */
export function platformAccountOf(db: DatabaseSync, account: Account): PlatformAccount {
  return {
    id: account.id,
    platform: account.platform,
    externalId: account.externalId,
    displayName: account.displayName,
    avatar: account.avatar,
    credentials: getAccountCredentials(db, account.id) ?? '',
    meta: getAccountMeta(db, account.id) ?? ''
  }
}
