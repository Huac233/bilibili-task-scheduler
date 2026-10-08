import { describe, expect, vi } from 'vitest'

import type { BuiltServer } from '../src/index.js'
import { fishingPanelFacts } from '../src/platform/douyu/index.js'
import { type FishingPanel, fishingPanelSchema } from '../src/platform/douyu/protocol.js'
import { test as it } from './fixtures.js'

/**
 * The target's own facts, read for one Room.
 *
 * §5 of the design asks the task page to show **that Room's** 形象, the bait in use and the window the
 * service reports — and the reason it must be the *task* page is that the preferences page cannot know
 * a Room at all: the route that resolves a choice source is handed an account id and no target. This is
 * the other half of the design's split, and the read behind it is a real one: a person should be able
 * to see, before a run, whether the two preconditions a cast needs are in place.
 *
 * Three properties the fixture exists to hold to.
 *
 * **A refused read is a sentence, never an empty list.** The same rule the choice sources obey: an
 * account we could not ask about and a Room whose panel says nothing are opposite facts, and a page
 * that drew them alike would be telling a person their 形象 is not set when the truth is that the
 * session expired.
 *
 * **An action this build serves no read for says `none`**, which is a different answer from a read that
 * failed — the page draws nothing for the first and a sentence for the second, and neither may be
 * reached from the other.
 *
 * **The account is scoped to the caller**, like every other id this build is handed.
 *
 * The transport is stubbed (`vi.stubGlobal`), which is how `douyu-fishing.test.ts` drives the same
 * protocol family: the panel is read through `platform/douyu/protocol.ts`, whose own `fetch` is the
 * global one, and a suite that stubs it is still a suite that cannot open a socket by accident.
 */

const ROOM = '88013571'

/** What `POST /api/douyu/accounts` accepts: the composite token and the device id beside it. */
const PASTED = {
  token: '456918967_1_ff778899aabbccdd_1700000000_ltkid',
  did: 'f71d67e4fe1f83a5310a3e6a00011701',
  webCookies: 'dy_did=f71d67e4fe1f83a5310a3e6a00011701; LTP0=placeholder'
}

/** The panel's own path, so a fixture answers the endpoint rather than any URL asked of it. */
const PANEL_PATH = '/japi/revenuenc/web/actfans/fishing/homePage'

interface RecordedCall {
  readonly url: string
  readonly headers: Record<string, string>
}

let calls: RecordedCall[] = []

/** One HTTP answer, in the shape Douyu sends: HTTP 200 with the verdict inside the body. */
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** A panel with both preconditions in place: an 形象, and a bait marked in use with stock beside it. */
function readyPanel(): { readonly error: number; readonly data: unknown } {
  return {
    error: 0,
    data: {
      baits: [{ id: 1, cnt: 1150, inUse: 1 }],
      fishing: { stat: 0, fishEtMs: 0 },
      // The 2026-10-08 capture's own window: 18:00–19:00 on Douyu's clock.
      matchInfo: { stat: 1, st: 1_791_453_600, et: 1_791_457_200 },
      myCh: { uid: '456918967' }
    }
  }
}

/** A panel with neither precondition: no 形象 on this Room, and no bait marked as the one in use. */
function barePanel(): { readonly error: number; readonly data: unknown } {
  return {
    error: 0,
    data: {
      baits: [{ id: 1, cnt: 0, inUse: 0 }],
      fishing: { stat: 0, fishEtMs: 0 },
      matchInfo: { stat: 0, st: 0, et: 0 }
    }
  }
}

function stubTransport(panel: () => Response): void {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      headers: (init.headers ?? {}) as Record<string, string>
    })
    return panel()
  })
}

/** Binds one Douyu account through the paste route, which reaches no network. */
async function bindAccount(server: BuiltServer, auth: Record<string, string>): Promise<number> {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/douyu/accounts',
    headers: auth,
    payload: PASTED
  })
  return response.json<{ account: { id: number } }>().account.id
}

interface FactsAnswer {
  readonly ok: boolean
  readonly facts?: { readonly kind: string; readonly items?: readonly { name: string; label: string; value: string }[] }
}

async function readFacts(
  server: BuiltServer,
  auth: Record<string, string>,
  query: { platform?: string; actionKey?: string; accountId?: number; targetKey?: string }
): Promise<{ status: number; body: FactsAnswer }> {
  const params = new URLSearchParams({
    platform: query.platform ?? 'douyu',
    actionKey: query.actionKey ?? 'fishing',
    accountId: String(query.accountId ?? 0),
    targetKey: query.targetKey ?? ROOM
  })
  const response = await server.app.inject({
    method: 'GET',
    url: `/api/action-settings/target-facts?${params.toString()}`,
    headers: auth
  })
  return { status: response.statusCode, body: response.json<FactsAnswer>() }
}

/** The value of one named fact, or a thrown error naming what the answer did carry. */
function factOf(body: FactsAnswer, name: string): string {
  const item = body.facts?.items?.find(candidate => candidate.name === name)
  if (item === undefined) throw new Error(`no fact named ${name} in ${JSON.stringify(body.facts)}`)
  return item.value
}

/**
 * The stub is removed after every case, and `vi.unstubAllGlobals` is the only teardown here: the
 * suites in this package are separate files, so nothing else has to be reset.
 */
it.afterEach(() => {
  vi.unstubAllGlobals()
  calls = []
})

describe('the facts of one target, for the action aimed at it', () => {
  it('answers the Room’s 形象, the bait in use and the window, in that order', async ({ server, session }) => {
    stubTransport(() => json(readyPanel()))
    const accountId = await bindAccount(server, session.auth())

    const { status, body } = await readFacts(server, session.auth(), { accountId })

    expect(status).toBe(200)
    expect(body.facts?.kind).toBe('ok')
    expect(body.facts?.items?.map(item => item.label)).toEqual(['形象', '在用鱼饵', '服务端报的钓鱼窗口'])
    expect(factOf(body, 'character')).toBe('已经设置')
    // The stock of the bait the service marks `inUse` — the number a person checks before a run.
    expect(factOf(body, 'bait')).toContain('1150')
    // The two instants the panel sent, on the Platform's own clock — a window, not a duration, and
    // the fixture's own pair is the capture's 18:00–19:00.
    expect(factOf(body, 'window')).toMatch(/^\d{2}:\d{2}–\d{2}:\d{2}$/)

    // And it was that Room's panel that was read. The `rid` travels in the query and **the credential
    // does not** — this family sends the composite token as a header, which is what makes a URL that
    // ends up in a log harmless — and the read is authenticated with the account's own credential,
    // which is the whole reason the route asks for an account id.
    expect(calls[0]?.url).toContain(PANEL_PATH)
    expect(calls[0]?.url).toContain(`rid=${ROOM}`)
    expect(calls[0]?.url).not.toContain(PASTED.token)
    expect(calls[0]?.headers['token']).toBe(PASTED.token)
  })

  it('says the two preconditions are not in place, rather than drawing them as facts', async ({ server, session }) => {
    stubTransport(() => json(barePanel()))
    const accountId = await bindAccount(server, session.auth())

    const { body } = await readFacts(server, session.auth(), { accountId })

    expect(factOf(body, 'character')).toContain('还没有设置')
    // Not 「还剩 0 枚」: nothing is marked in use at all, which is a different fact from a bait that
    // ran out — and the action refuses to cast on either.
    expect(factOf(body, 'bait')).toContain('没有标记')
    expect(factOf(body, 'window')).toContain('没有报')
  })

  it('reports a refused read as a sentence, not as an empty list', async ({ server, session }) => {
    // The session has gone: the service answers its own code inside an HTTP 200, which is how this
    // family refuses.
    stubTransport(() => json({ error: 1002, msg: '登录失效，请重新登录' }))
    const accountId = await bindAccount(server, session.auth())

    const { status, body } = await readFacts(server, session.auth(), { accountId })

    expect(status).toBe(200)
    expect(body.facts?.kind).toBe('unavailable')
    // The refusal's own words, so the person can tell a dead session from a Room with nothing set.
    expect(JSON.stringify(body.facts)).toContain('登录失效')
    expect(body.facts?.items).toBeUndefined()
  })

  it('says this build serves no such read for an action it has none for', async ({ server, session }) => {
    stubTransport(() => json(readyPanel()))
    const accountId = await bindAccount(server, session.auth())

    const { status, body } = await readFacts(server, session.auth(), { accountId, actionKey: 'intimacy_tasks' })

    expect(status).toBe(200)
    expect(body.facts?.kind).toBe('none')
    // Nothing was asked of a Platform: the answer is about this build's wiring, not about the Room.
    expect(calls).toEqual([])
  })

  it('refuses a read for an account that is not the caller’s', async ({ server, session }) => {
    stubTransport(() => json(readyPanel()))
    const accountId = await bindAccount(server, session.auth())

    const { status, body } = await readFacts(server, session.auth(), { accountId: accountId + 999 })

    expect(status).toBe(404)
    expect(JSON.stringify(body)).toContain('账号不存在')
    expect(calls).toEqual([])
  })

  it('refuses a read with no target at all, rather than asking the service about nothing', async ({
    server,
    session
  }) => {
    stubTransport(() => json(readyPanel()))
    const accountId = await bindAccount(server, session.auth())

    const { status } = await readFacts(server, session.auth(), { accountId, targetKey: '' })

    expect(status).toBe(400)
    expect(calls).toEqual([])
  })
})

/**
 * The one reading both wordings are built from.
 *
 * The route above and the adapter's own report used to read the same panel twice — a private mirror of
 * `fishingHasCharacter`, `inUseBait` and the clock here, and the originals there — which is one fact
 * with two homes, and the copies had already drifted in a way neither could notice: the route rendered
 * an absent window as a *sentence* (「服务端这次没有报窗口」) while the adapter rendered it as `''`, so the
 * two could not be compared even in principle. `fishingPanelFacts` is the one home; what stays in each
 * place is the sentence its own reader needs, and `FishingPanelFacts` records why those survive apart.
 *
 * These cases pin the *reading* at the seam the route now consumes, and each one is a boundary the
 * mirror could have got wrong: a bait that ran out is not no bait at all, no window is not a window,
 * and the clock is the Platform's own 0–23 one rather than a duration.
 */
describe('the 钓鱼 panel reading, shared by the page and the run', () => {
  /**
   * The panel out of one scripted answer, parsed by the module's own schema.
   *
   * Parsed rather than written as a literal of the panel's type: the shape `fishingPanelFacts` takes is
   * `protocol.ts`'s, and a hand-typed fixture would let this suite keep agreeing about a panel the
   * reader no longer produces.
   */
  function panelOf(envelope: { readonly data: unknown }): FishingPanel {
    return fishingPanelSchema.parse(envelope.data)
  }

  it('answers the two preconditions and the window, or the plain absent value for each', () => {
    const ready = fishingPanelFacts(panelOf(readyPanel()))
    expect(ready.hasCharacter).toBe(true)
    expect(ready.bait?.cnt).toBe(1150)
    expect(ready.windowText).toMatch(/^\d{2}:\d{2}–\d{2}:\d{2}$/)

    const bare = fishingPanelFacts(panelOf(barePanel()))
    expect(bare.hasCharacter).toBe(false)
    expect(bare.bait).toBeNull()
    // `null` and not `''`: a caller that printed an empty string would print a window of nothing, and
    // both sentences built from this are chosen by exactly this value.
    expect(bare.windowText).toBeNull()
  })

  it('tells a bait that ran out from no bait at all', () => {
    // The distinction the page's 「还剩 0 枚」 sentence exists for: `inUse: 0` means nothing is marked
    // in use (a Room the owner has not prepared), while `inUse: 1, cnt: 0` is a bait the service would
    // spend and cannot. The action refuses to cast on either, and only one of them is a count.
    const spent = fishingPanelFacts(
      panelOf({
        data: {
          baits: [{ id: 1, cnt: 0, inUse: 1 }],
          fishing: { stat: 0, fishEtMs: 0 },
          matchInfo: { stat: 0, st: 0, et: 0 },
          myCh: { uid: '456918967' }
        }
      })
    )

    expect(spent.bait).not.toBeNull()
    expect(spent.bait?.cnt).toBe(0)
  })

  it('renders the window on the Platform’s own clock, where midnight is 00:00 rather than a duration', async ({
    server,
    session
  }) => {
    // The older capture's own pair: 12:00–24:00 on 2026-10-07 (`st` 1791432000 / `et` 1791475200), whose
    // end prints as `00:00` — the same reading `douyu-fishing.test.ts` pins for the run's own record. The
    // page and the record now come from one clock, so the two can no longer disagree about one panel.
    const midnightWindow = {
      error: 0,
      data: {
        baits: [{ id: 1, cnt: 1150, inUse: 1 }],
        fishing: { stat: 0, fishEtMs: 0 },
        matchInfo: { stat: 1, st: 1_791_432_000, et: 1_791_475_200 },
        myCh: { uid: '456918967' }
      }
    }
    stubTransport(() => json(midnightWindow))
    const accountId = await bindAccount(server, session.auth())

    const { body } = await readFacts(server, session.auth(), { accountId })

    expect(factOf(body, 'window')).toBe('12:00–00:00')
  })
})
