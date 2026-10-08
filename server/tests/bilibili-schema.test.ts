import { describe, expect, it } from 'vitest'

import { danmuInfoSchema, navSchema, roomInfoSchema, roomInitSchema } from '../src/bilibili/types.js'

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
      expect(result.data.data.room_id).toBe(22637261)
      expect(result.data.data.uid).toBe(123456)
      expect(result.data.data.live_status).toBe(1)
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
