import { describe, expect, it } from 'vitest'

import { anchorNameSchema, danmuInfoSchema, navSchema, roomInfoSchema, roomInitSchema } from '../src/bilibili/types.js'

/**
 * Response-shape regression tests.
 *
 * These exist because of a real failure: `room_init` returns `encrypted` as a
 * boolean, but an earlier version of the schema declared it as a number. Every
 * room lookup failed with "unexpected response shape" — a whole feature broken
 * by a field the application never reads.
 *
 * The payloads below are trimmed but otherwise faithful copies of live
 * responses, including the fields this app does *not* declare. They are here to
 * fail loudly if the schemas are ever tightened back toward strictness.
 */

describe('room_init response', () => {
  /**
   * The shape that broke: `encrypted` is a boolean, and the payload carries a
   * dozen fields beyond what the app consumes.
   */
  const livePayload = {
    code: 0,
    message: '0',
    ttl: 1,
    data: {
      room_id: 22637261,
      short_id: 0,
      uid: 123456,
      need_p2p: 0,
      is_hidden: false,
      is_locked: false,
      is_portrait: false,
      live_status: 1,
      hidden_till: 0,
      lock_till: 0,
      encrypted: false,
      pwd_verified: false,
      live_time: 1791261000,
      room_shield: 1,
      is_sp: 0,
      special_type: 0
    }
  }

  it('parses a real payload carrying a boolean `encrypted` and many extra fields', () => {
    const result = roomInitSchema.safeParse(livePayload)
    expect(result.success).toBe(true)
    if (result.success) {
      // Optional-chained because the envelope's `data` is optional now — a refusal must reach its code
      // (see the cases at the foot of this describe) — and the assertions keep their strength either way:
      // `undefined` fails `toBe(22637261)` exactly as a wrong number does.
      expect(result.data.data?.room_id).toBe(22637261)
      expect(result.data.data?.uid).toBe(123456)
      expect(result.data.data?.live_status).toBe(1)
    }
  })

  it('does not fail when an undeclared field changes shape again', () => {
    const mutated = {
      ...livePayload,
      data: { ...livePayload.data, encrypted: 'true', is_hidden: 1, special_type: 'weird' }
    }
    expect(roomInitSchema.safeParse(mutated).success).toBe(true)
  })

  it('still rejects a payload missing a field the app depends on', () => {
    const incomplete = { code: 0, data: { room_id: 22637261, uid: 1 } }
    expect(roomInitSchema.safeParse(incomplete).success).toBe(false)
  })

  it('rejects a payload whose consumed field has the wrong type', () => {
    const wrongType = { ...livePayload, data: { ...livePayload.data, live_status: '1' } }
    expect(roomInitSchema.safeParse(wrongType).success).toBe(false)
  })

  /**
   * The refusal, which is a shape the *code* has to survive.
   *
   * **Not a capture, and it says so**: no body of a `60004` answer exists anywhere in this repo, so the
   * code space comes from the reference field table (`room_init`: `0` 成功 / `60004` 直播间不存在) rather
   * than from a saved response. What is pinned is the property `resolveRoom` stands on — a payload
   * demanded before the code is read is what made a missing room unreadable, and a missing room is a
   * fact about the number a person pasted. The `null` case is the same refusal written the other way a
   * JSON API writes "nothing here"; both readings have to reach the code.
   */
  it.each([
    ['absent', { code: 60004, message: '直播间不存在', ttl: 1 }],
    ['null', { code: 60004, message: '直播间不存在', ttl: 1, data: null }]
  ])('parses a refusal whose data is %s, keeping the code', (_shape, payload) => {
    const result = roomInitSchema.safeParse(payload)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.code).toBe(60004)
      expect(result.data.data ?? undefined).toBeUndefined()
    }
  })
})

describe('room get_info response', () => {
  it('accepts a numeric live_time when the room is live', () => {
    const payload = {
      code: 0,
      data: {
        room_id: 22637261,
        short_id: 0,
        uid: 123456,
        live_status: 1,
        live_time: 1791261000,
        title: '测试直播间',
        online: 42,
        attention: 1000,
        area_name: '虚拟主播',
        parent_name: '虚拟主播'
      }
    }
    expect(roomInfoSchema.safeParse(payload).success).toBe(true)
  })

  it('accepts the zero-date string live_time returned when offline', () => {
    const payload = {
      code: 0,
      data: {
        room_id: 22637261,
        short_id: 0,
        uid: 123456,
        live_status: 0,
        live_time: '0000-00-00 00:00:00',
        title: '测试直播间'
      }
    }
    const result = roomInfoSchema.safeParse(payload)
    expect(result.success).toBe(true)
  })
})

/**
 * The read that answers the Anchor's name, and the one thing about it that can be got wrong silently.
 */
describe('anchor name response (getInfoByRoom)', () => {
  /**
   * The field the reader consumes, at the level the response actually nests it.
   *
   * `anchor_info.base_info.uname` — and the block is worth pinning at this depth because the shape a
   * reference implementation's room type suggests is a flat `anchor_info: { uname }`, whose `uname`
   * read is `undefined`. That is the failure this case exists to make loud: a name that is silently
   * `undefined` is indistinguishable from a room reporting none.
   *
   * `face` rides along beside the declared field, and undeclared siblings are the point of it: this
   * payload is hundreds of keys at the top level, so a read that only survives a hand-trimmed body is
   * the read that breaks on the next upstream addition.
   */
  it('reads the Anchor’s name out of the nested anchor block', () => {
    const result = anchorNameSchema.safeParse({
      code: 0,
      message: '0',
      data: { anchor_info: { base_info: { uname: '炫神_', face: 'https://i0.hdslb.com/bfs/face/x.jpg' } } }
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.data?.anchor_info.base_info.uname).toBe('炫神_')
    }
  })

  /**
   * The refusal, which is a shape the code has to survive.
   *
   * `19002000`（获取初始化数据失败）is the code this endpoint answers for a room it will not initialise.
   * The fixture is the *shape* a refusal takes on this family — a code and its words, no payload — and
   * what it pins is the property `fetchAnchorName` stands on: a reader that demanded an anchor before
   * reading the code would report a shape problem where Bilibili had named a state. (It is not a saved
   * body: no `getInfoByRoom` refusal is captured in this repo, so the code comes from the endpoint's own
   * reference test rather than from a response this build has seen.)
   */
  it('parses a refusal that carries no data, keeping the code', () => {
    const result = anchorNameSchema.safeParse({
      code: 19002000,
      message: '获取初始化数据失败',
      msg: '获取初始化数据失败'
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.code).toBe(19002000)
      expect(result.data.data ?? undefined).toBeUndefined()
    }
  })

  /** The other side of the depth: a success that lost the block is a contract change, not a name-less room. */
  it('rejects a success whose anchor block was flattened to where it never was', () => {
    const flattened = { code: 0, data: { anchor_info: { uname: '炫神_' } } }

    expect(anchorNameSchema.safeParse(flattened).success).toBe(false)
  })
})

describe('getDanmuInfo response', () => {
  it('parses a host list with extra per-host fields', () => {
    const payload = {
      code: 0,
      data: {
        group: 'live',
        business_id: 0,
        max_delay: 5000,
        refresh_row_factor: 0.125,
        refresh_rate: 100,
        token: 'abc123',
        host_list: [
          { host: 'broadcastlv.chat.bilibili.com', port: 2243, wss_port: 443, ws_port: 2244 },
          { host: 'tx-bj-live-comet-02.chat.bilibili.com', port: 2243, wss_port: 443, ws_port: 2244 }
        ]
      }
    }
    const result = danmuInfoSchema.safeParse(payload)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.data.host_list).toHaveLength(2)
      expect(result.data.data.token).toBe('abc123')
    }
  })
})

describe('nav response', () => {
  it('parses the WBI key payload', () => {
    const payload = {
      code: 0,
      message: '0',
      ttl: 1,
      data: {
        isLogin: true,
        mid: 123456,
        uname: '测试用户',
        face: 'https://i0.hdslb.com/bfs/face/x.jpg',
        wbi_img: {
          img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
          sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'
        }
      }
    }
    const result = navSchema.safeParse(payload)
    expect(result.success).toBe(true)
    if (result.success) {
      // Optional now, because the rejection envelope has no `data` at all; the
      // assertions still fail if the success payload ever loses it.
      expect(result.data.data?.isLogin).toBe(true)
      expect(result.data.data?.wbi_img?.img_url).toContain('7cd084941338484aae1ad9425b84077c')
    }
  })

  it('tolerates a logged-out payload without the WBI block', () => {
    const payload = { code: 0, data: { isLogin: false } }
    expect(navSchema.safeParse(payload).success).toBe(true)
  })

  /**
   * Risk control answers without a `data` field at all. Parsed strictly this was
   * "unexpected response shape at data", which threw away the code and reported a
   * payload problem where the server had said exactly what was wrong. `code` is the
   * first thing every caller reads, so it has to survive the rejection.
   */
  it('parses a rejection that carries no data, keeping the code', () => {
    const result = navSchema.safeParse({ code: -412, message: '请求被拦截' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.code).toBe(-412)
      expect(result.data.data).toBeUndefined()
    }
  })

  it('parses a bare success envelope, so "no session answer" is readable rather than fatal', () => {
    const result = navSchema.safeParse({ code: 0 })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.data).toBeUndefined()
    }
  })
})
