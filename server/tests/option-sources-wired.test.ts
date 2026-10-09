import { describe, expect, vi } from 'vitest'

import { fieldsOf, shownReadsOf } from '../src/actions/action-options.js'
import { allPlatforms } from '../src/platform/registry.js'
import { test as it } from './fixtures.js'

/**
 * Every choice source a descriptor declares is registered in this build — **on both channels**.
 *
 * **Why this is a test rather than a comment.** The preferences page displays a read *and* feeds the
 * same read to the parameter's list, so a source that is declared and never registered is not a
 * cosmetic gap: the route answers it with `ChoiceSourceRegistry`'s own sentence — 「这一版没有接上…」 —
 * which the page draws faithfully, and a person is then looking at a build-shaped fact where their
 * account's answer belongs. It is the one failure mode of this seam that no fixture can catch, because
 * a fixture *supplies* the registry: the thing under test is whether production's own wiring supplies
 * it.
 *
 * **The second walk is the newer half, and it is the same property.** `shownReads` is the channel for
 * a read no source-backed field names as its source — the shape whose absence made `douyu.medalRooms`
 * registered and invisible — so a shown read whose source this build never wired is a read that
 * reaches the page as 「这一版没有接上…」 *and* has no field channel to have been noticed through. Both
 * declaration tables are walked here because production's wiring is what is under test, and neither
 * table may be the one nobody checks.
 *
 * The assertion is deliberately about registration and not about the answer, so it survives the reads
 * themselves changing: a stub that answers nothing this family understands still proves the source was
 * asked, because the sentence for an unregistered one is specific and appears before any credential is
 * read. And the set is required to be non-empty, so walking zero fields cannot pass for success.
 *
 * The stub is the global `fetch`, which is the transport these families read through; no request
 * leaves this process.
 */
function stubUnreadablePlatform(): void {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 0, data: {} }), { status: 200 }))
}

it.afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the choice sources a catalogue declares', () => {
  it('are all registered, so no form is shown a build-shaped sentence in an account’s place', async ({
    server,
    session
  }) => {
    stubUnreadablePlatform()

    const bound = await server.app.inject({
      method: 'POST',
      url: '/api/douyu/accounts',
      headers: session.auth(),
      payload: {
        token: '456918967_1_ff778899aabbccdd_1700000000_ltkid',
        did: 'f71d67e4fe1f83a5310a3e6a00011701',
        webCookies: 'dy_did=f71d67e4fe1f83a5310a3e6a00011701; LTP0=placeholder'
      }
    })
    const accountId = bound.json<{ account: { id: number } }>().account.id

    const checked: string[] = []
    for (const platform of allPlatforms()) {
      for (const action of platform.actions) {
        // The declaration tables rather than the descriptors: `fieldsOf` and `shownReadsOf` are what
        // the options route itself gates on (`fieldOf`, `shownReadOf`), so walking them walks exactly
        // the names a form can be shown — on both channels, since the route answers both.
        const declared = [
          ...fieldsOf(platform.key, action.key).map(field => ({
            what: field.name,
            // Both source-backed kinds, walked by the one property that makes a field askable at all: a
            // typed field has no source and is skipped by the filter below, and a filter on `kind` would
            // have to name both members — which is how a `pick_one` field's source goes unwalked the day
            // one is added.
            source: field.source
          })),
          ...shownReadsOf(platform.key, action.key).map(read => ({ what: read.name, source: read.source }))
        ]

        for (const entry of declared) {
          if (entry.source === undefined) continue
          checked.push(`${platform.key}/${action.key}/${entry.what}`)

          const params = new URLSearchParams({
            platform: platform.key,
            actionKey: action.key,
            accountId: String(accountId),
            field: entry.what
          })
          const response = await server.app.inject({
            method: 'GET',
            url: `/api/action-settings/options?${params.toString()}`,
            headers: session.auth()
          })
          const body = response.json<unknown>()

          expect(JSON.stringify(body), `${platform.key}/${action.key}/${entry.what}`).not.toContain('没有接上')
        }
      }
    }

    // The build really declares some: an empty walk would otherwise satisfy every assertion above.
    expect(checked.length).toBeGreaterThan(0)
  })
})
