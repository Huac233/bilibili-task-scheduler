import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BiliHttp, CookieJar } from '../src/bilibili/http.js'
import {
  DEFAULT_CLICK_TIME,
  LIKE_INTERACT_URL,
  LIKE_REPORT_V3_URL,
  LikeScheduleGuard,
  likeInteract,
  likeRoom,
  likeWithFallback
} from '../src/bilibili/like.js'
import { WbiKeyStore } from '../src/bilibili/live.js'
import { LikeCode } from '../src/bilibili/types.js'
import { encodeWbi } from '../src/bilibili/wbi.js'

/**
 * 点赞请求形状的契约测试。
 *
 * 网络全部 mock，理由有两个：真实点赞是公开计数动作，不能拿真账号去试；而这里要断言
 * 的本来就是「发出去的字节」，不是 B 站认不认。mock 只挡住 fetch 这一层，其余全是真
 * 代码 —— `BiliHttp` 的 cookie/请求头、`WbiKeyStore` 从 `/x/web-interface/nav` 取键、
 * `encodeWbi` 的签名 —— 所以断言的是组装结果，不是替身的行为。
 *
 * 期望形状来自两份参考实现的实拍（ref-BLTH `src/library/bili-api/index.ts:79-93` 与
 * `src/library/request/index.ts:72-100`；ref-bilibili-live-helper `src/api.ts:1001-1012`），
 * 取舍理由写在 `like.ts` 模块头，包括那份「未验证风险」。
 */

const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav'

/** 与 wbi.test.ts 同一对已发布的键，用来确认键确实是从 nav 流到签名里的。 */
const IMG_KEY = '7cd084941338484aae1ad9425b84077c'
const SUB_KEY = '4932caff0ff746eab6f01bf08b70ac45'
const keys = { imgKey: IMG_KEY, subKey: SUB_KEY }

const ROOM_ID = 22637261
const ANCHOR_ID = 12345
/** 点赞者 uid。刻意与 cookie 里的 DedeUserID 不同，用来证明取的是入参。 */
const UID = 67890
const CSRF = 'jct-value'

interface CapturedRequest {
  readonly url: string
  readonly method: string
  readonly headers: Headers
  /** 只保留 urlencoded 字符串体；这两个端点之外没有别的形态。 */
  readonly body: string | null
}

let calls: CapturedRequest[] = []

const navPayload = {
  code: 0,
  message: '0',
  data: {
    isLogin: true,
    wbi_img: {
      img_url: `https://i0.hdslb.com/bfs/wbi/${IMG_KEY}.png`,
      sub_url: `https://i0.hdslb.com/bfs/wbi/${SUB_KEY}.png`
    }
  }
}

/**
 * 把 fetch 换成记录器：`/nav` 一律回同样的键，点赞请求按 `likeReplies` 的顺序回放。
 * 回放完还继续发就用一个成功信封兜底，免得测试因为"多打了一次"而变成形状错误。
 */
function installFetchMock(likeReplies: readonly unknown[]): void {
  let replyIndex = 0

  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null
    })

    const reply = url.startsWith(NAV_URL) ? navPayload : likeReplies[replyIndex++]
    return new Response(JSON.stringify(reply ?? { code: 0, message: '0' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  })

  vi.stubGlobal('fetch', fetchMock)
}

function loggedInHttp(): BiliHttp {
  return new BiliHttp({
    cookies: new CookieJar({ SESSDATA: 'sess-value', bili_jct: CSRF, DedeUserID: '100' })
  })
}

/** 第 n 个非 nav 请求，也就是第 n 次点赞尝试。 */
function likeCall(index = 0): CapturedRequest {
  const found = calls.filter(call => !call.url.startsWith(NAV_URL))[index]
  if (!found) throw new Error(`没有记录到第 ${index} 个点赞请求`)
  return found
}

function paramsOf(call: CapturedRequest): URLSearchParams {
  return new URL(call.url).searchParams
}

const room = { roomId: ROOM_ID, anchorId: ANCHOR_ID, uid: UID }

beforeEach(() => {
  calls = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('likeRoom (A: likeReportV3)', () => {
  it('按参考实现的顺序把六个参数放进 WBI 签名的查询串', async () => {
    installFetchMock([{ code: 0, message: '0' }])

    const result = await likeRoom(loggedInHttp(), new WbiKeyStore(), room)

    expect(result).toEqual({ ok: true })

    // 第一次请求是 /nav 取 WBI 键，第二次才是点赞。
    expect(calls).toHaveLength(2)
    expect(calls[0]?.url.startsWith(NAV_URL)).toBe(true)

    const call = likeCall()
    expect(call.method).toBe('POST')
    expect(call.url.startsWith(`${LIKE_REPORT_V3_URL}?`)).toBe(true)

    const params = paramsOf(call)
    expect(params.get('click_time')).toBe(String(DEFAULT_CLICK_TIME))
    expect(params.get('room_id')).toBe(String(ROOM_ID))
    expect(params.get('uid')).toBe(String(UID))
    expect(params.get('anchor_id')).toBe(String(ANCHOR_ID))
    expect(params.get('web_location')).toBe('444.8')
    expect(params.get('csrf')).toBe(CSRF)

    // 插入顺序按参考实现，`w_rid`/`wts` 由 encodeWbi 追加在末尾。
    expect(call.url).toContain(
      `?click_time=${DEFAULT_CLICK_TIME}&room_id=${ROOM_ID}&uid=${UID}` +
        `&anchor_id=${ANCHOR_ID}&web_location=444.8&csrf=${CSRF}&w_rid=`
    )

    // 空体 + urlencoded：BLTH 的 Request.post 在 data 为 null 时正是这么发的。
    expect(call.body).toBe('')
    expect(call.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(call.headers.get('origin')).toBe('https://live.bilibili.com')
    expect(call.headers.get('referer')).toBe('https://live.bilibili.com/')
    expect(call.headers.get('cookie')).toContain(`bili_jct=${CSRF}`)
  })

  /**
   * 签名必须覆盖请求里发的每一个参数。用请求自己带的 `wts` 重算一遍是唯一能在不联网
   * 的情况下证明这一点的方法：漏掉任何一个参数（最典型的是 `csrf`），重算值就不一样。
   */
  it('签名的输入正好是这六个参数加上 wts，键来自 /nav', async () => {
    installFetchMock([{ code: 0, message: '0' }])

    await likeRoom(loggedInHttp(), new WbiKeyStore(), room)

    const params = paramsOf(likeCall())
    const wts = Number(params.get('wts'))
    expect(Number.isFinite(wts)).toBe(true)

    const recomputed = encodeWbi(
      {
        click_time: DEFAULT_CLICK_TIME,
        room_id: ROOM_ID,
        uid: UID,
        anchor_id: ANCHOR_ID,
        web_location: '444.8',
        csrf: CSRF
      },
      keys,
      wts * 1000
    )

    expect(params.get('w_rid')).toBe(/w_rid=([0-9a-f]{32})/.exec(recomputed)?.[1])
  })

  it('clickTime 与 webLocation 可覆盖，uid 取调用方给的而不是 cookie 里的 DedeUserID', async () => {
    installFetchMock([{ code: 0, message: '0' }])

    await likeRoom(loggedInHttp(), new WbiKeyStore(), {
      roomId: ROOM_ID,
      anchorId: ANCHOR_ID,
      uid: 111_222,
      clickTime: 1,
      webLocation: '444.9'
    })

    const params = paramsOf(likeCall())
    expect(params.get('click_time')).toBe('1')
    expect(params.get('web_location')).toBe('444.9')
    // cookie 里的 DedeUserID 是 100，这里必须是入参的 111222。
    expect(params.get('uid')).toBe('111222')
  })

  it('业务失败返回数据而不是抛异常，并在签名失败时让 WBI 键失效', async () => {
    installFetchMock([
      { code: LikeCode.SignError, message: 'csrf 校验失败' },
      { code: 0, message: '0' }
    ])
    const http = loggedInHttp()
    const wbi = new WbiKeyStore()

    const first = await likeRoom(http, wbi, room)
    expect(first).toEqual({ ok: false, code: -111, error: 'csrf 校验失败' })

    // 键已被 invalidate：第二次调用必须重新取 nav，而不是复用。
    const second = await likeRoom(http, wbi, room)
    expect(second).toEqual({ ok: true })
    expect(calls.filter(call => call.url.startsWith(NAV_URL))).toHaveLength(2)
  })

  it('未知码原样带出，`message` 缺失时退到 `msg`，不硬套已知码的语义', async () => {
    installFetchMock([{ code: -352, msg: '风控校验失败' }])

    const result = await likeRoom(loggedInHttp(), new WbiKeyStore(), room)

    expect(result).toEqual({ ok: false, code: -352, error: '风控校验失败' })
  })

  it('缺 bili_jct 时本地短路，一个请求都不发', async () => {
    installFetchMock([])
    const http = new BiliHttp({ cookies: new CookieJar({ SESSDATA: 'sess-value' }) })

    const result = await likeRoom(http, new WbiKeyStore(), room)

    expect(result).toEqual({ ok: false, code: LikeCode.NotLoggedIn, error: '未登录：cookie 中缺少 bili_jct' })
    expect(calls).toHaveLength(0)
  })
})

describe('likeInteract (B: likeInteract)', () => {
  it('用五个字段的表单体提交，不取 WBI，也不碰 nav', async () => {
    installFetchMock([{ code: 0, message: '0' }])
    const before = Date.now()

    const result = await likeInteract(loggedInHttp(), { roomId: ROOM_ID, uid: UID })

    expect(result).toEqual({ ok: true })

    // 一个请求，而且不是 nav：这个端点不需要 WBI。
    expect(calls).toHaveLength(1)

    const call = likeCall()
    expect(call.url).toBe(LIKE_INTERACT_URL)
    expect(call.method).toBe('POST')

    const body = new URLSearchParams(call.body ?? '')
    expect([...body.keys()]).toEqual(['roomid', 'uid', 'ts', 'csrf', 'csrf_token'])
    expect(body.get('roomid')).toBe(String(ROOM_ID))
    expect(body.get('uid')).toBe(String(UID))
    expect(body.get('csrf')).toBe(CSRF)
    expect(body.get('csrf_token')).toBe(CSRF)
    // ts 是毫秒时间戳（参考实现传 Date.now()）。
    expect(Number(body.get('ts'))).toBeGreaterThanOrEqual(before)

    expect(call.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    // 参考实现给这个端点设置的是 www.bilibili.com，与本项目默认的 live.bilibili.com 不同。
    expect(call.headers.get('referer')).toBe('https://www.bilibili.com/')
  })

  it('缺 bili_jct 时同样本地短路', async () => {
    installFetchMock([])
    const http = new BiliHttp({ cookies: new CookieJar({ SESSDATA: 'sess-value' }) })

    const result = await likeInteract(http, { roomId: ROOM_ID, uid: UID })

    expect(result).toEqual({ ok: false, code: LikeCode.NotLoggedIn, error: '未登录：cookie 中缺少 bili_jct' })
    expect(calls).toHaveLength(0)
  })
})

describe('likeWithFallback', () => {
  it('A 成功时不再打 B', async () => {
    installFetchMock([{ code: 0, message: '0' }])

    const result = await likeWithFallback(loggedInHttp(), new WbiKeyStore(), room)

    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(2) // nav + A
  })

  it('A 失败后切 B，两次都失败时把两条原因都留住', async () => {
    installFetchMock([
      { code: -352, msg: '风控校验失败' },
      { code: -400, message: '请求错误' }
    ])

    const result = await likeWithFallback(loggedInHttp(), new WbiKeyStore(), room)

    expect(result).toEqual({ ok: false, code: -400, error: '风控校验失败 / 请求错误' })
    expect(calls).toHaveLength(3) // nav + A + B
    expect(likeCall(1).url).toBe(LIKE_INTERACT_URL)
  })

  it('A 报未登录时不再打 B —— 同一个 cookie 只会同样失败', async () => {
    installFetchMock([])
    const http = new BiliHttp({ cookies: new CookieJar({ SESSDATA: 'sess-value' }) })

    const result = await likeWithFallback(http, new WbiKeyStore(), room)

    // 显式收窄再读 `code`：`LikeResult` 成功分支上没有这个字段，读它本身就是错的。
    if (result.ok) throw new Error('缺 cookie 时不该报成功')
    expect(result.code).toBe(LikeCode.NotLoggedIn)
    expect(calls).toHaveLength(0)
  })
})

describe('LikeScheduleGuard', () => {
  it('本地只剩一个硬下限和一个跨天闸门，节奏与额度都交给服务端', () => {
    // 服务端权威字段：逐次节奏是 like_info_v3.cooldown（实测 0.35 秒），额度是勋章任务
    // task_info[like] 的 sub_title 与 is_done（见 likeGate）。原先那两个猜测
    // （MinIntervalMs = 15_000、DailyLikeLimit = 5_000）都在实盘里被推翻，已经不在这里。
    expect(LikeScheduleGuard.MinIntervalFloorMs).toBe(350)
    expect(LikeScheduleGuard.CrossDayStopAt).toBe('23:55')
    expect(LikeScheduleGuard.CrossDayResumeAt).toBe('00:05')
  })
})

/**
 * 被拒文案里的 `csrf`。
 *
 * 端点 A 把 `csrf` 放进查询串、端点 B 放进请求体，而「点赞被拒」正是服务端最可能把请求回显
 * 回来的场合。`medal.ts` 为同一条查询串早就把值抠掉了（`bilibili-medal.test.ts` 有对应用例），
 * 这条路上原先没有 —— 于是同一次交换里，URL 脱敏了、交给调用方的那句话没有。
 */
describe('凭据不会经被拒文案交给调用方', () => {
  it('likeRoom：查询串里的 csrf 被回显时抹掉再交出', async () => {
    installFetchMock([{ code: -352, message: `风险校验失败：GET ...?csrf=${CSRF} rejected` }])

    const result = await likeRoom(loggedInHttp(), new WbiKeyStore(), room)

    if (result.ok) throw new Error('被拒时不该报成功')
    expect(result.error).not.toContain(CSRF)
    expect(result.error).toContain('<redacted>')
  })

  it('likeInteract：请求体里的 csrf 被回显时抹掉再交出', async () => {
    installFetchMock([{ code: -400, message: `请求错误：roomid=${ROOM_ID}&csrf=${CSRF}&csrf_token=${CSRF}` }])

    const result = await likeInteract(loggedInHttp(), { roomId: ROOM_ID, uid: UID })

    if (result.ok) throw new Error('被拒时不该报成功')
    expect(result.error).not.toContain(CSRF)
    expect(result.error).toContain('<redacted>')
  })

  it('回退路径把两条已脱敏的原因拼起来，不会重新带出值', async () => {
    installFetchMock([
      { code: -352, message: `A 拒绝：csrf=${CSRF}` },
      { code: -400, message: `B 拒绝：csrf_token=${CSRF}` }
    ])

    const result = await likeWithFallback(loggedInHttp(), new WbiKeyStore(), room)

    if (result.ok) throw new Error('两次都失败时不该报成功')
    expect(result.error).not.toContain(CSRF)
    expect(result.error.match(/<redacted>/g)).toHaveLength(2)
  })
})
