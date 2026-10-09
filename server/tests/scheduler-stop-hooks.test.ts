import { afterEach, beforeEach, describe, expect } from 'vitest'

import type { Db } from '../src/db/index.js'
import { registerPlatform } from '../src/platform/registry.js'
import type { Platform, RefreshResult } from '../src/platform/types.js'
import { getAccountCredentials, upsertAccount } from '../src/repo/accounts.js'
import { createUser } from '../src/repo/users.js'
import { onSchedulerStop, Scheduler } from '../src/scheduler/runner.js'
import { test as base } from './fixtures.js'

/**
 * `Scheduler.stop()` 的第二个承诺：**跑在 sweep 之外的工作也要被停掉**。
 *
 * `runner.ts` 的 `stop()` 先等完在途的那一次 sweep，再依次跑 `onSchedulerStop` 注册的钩子。顺序是承诺的
 * 一部分，而且是这个文件唯一要钉的东西：常驻观看循环是被某一次 sweep 启动的，所以「停它」必须发生在
 * 那次 sweep 之后 —— 反过来的话，sweep 还能再启动一个再也没人会停的循环。
 *
 * 三件事分开钉，因为它们分得开：钩子跑在 sweep 之后（用一个真的发生在 sweep 里的写库读出来，而不是靠两个
 * 回调的排队顺序）、一个抛了的钩子既不拦后面的钩子也不让 `stop()` 拒绝、以及返回的那个函数就是注销。
 *
 * **`stopHooks` 是 `runner.ts` 的模块级 `Set`，所以同一个文件里的用例之间它会留存。** 这个文件每注册一个
 * 钩子都把它记下来，`afterEach` 里全部注销：一个用例留下的钩子会跑进下一个用例的 `stop()`，而那种失败看
 * 起来像「钩子跑了两次」。随 `fixtures.ts` 的 import 图进来的那一个（B 站适配器的 `stopWatchLoops`，它在
 * 模块加载时注册）不在这个文件注销 —— 它不是这个文件注册的，而它在空注册表上什么也不做。
 */

const STUB_KEY = 'stophook-stub'
const NOW = 1_791_411_776_000
const OLD_CREDENTIAL = '{"token":"old"}'
const RENEWED_CREDENTIAL = '{"token":"renewed"}'

/** 续期停在哪里的闸门，以及它进过几次。用例换掉它，桩平台读它。 */
let gate: Promise<void> = Promise.resolve()
let renewals = 0

/**
 * 这个文件只用平台的一个成员：`refresh`。
 *
 * 理由是它**是 sweep 自己的第一个 `await`**，所以把一次 sweep 卡在半路最省的办法就是卡在这里 —— 不需要
 * 一个像样的动作链，也不需要让桩平台回答任何别的问题（那几个成员只会抛，好让「走错了路」立刻现形）。
 */
const stubPlatform: Platform = {
  key: STUB_KEY,
  label: '停止钩子测试用的桩平台',
  actions: [],
  resolveTarget: () => {
    throw new Error('这个文件不走这条路：resolveTarget')
  },
  probe: () => {
    throw new Error('这个文件不走这条路：probe')
  },
  send: () => {
    throw new Error('这个文件不走这条路：send')
  },
  reconcile: () => Promise.resolve([]),
  // Required of every adapter (`platform/types.ts`). This stub starts nothing that outlives a sweep, and the
  // stop hooks below are what this file is about: they end work no later sweep will be there to retire.
  retainResidentWork: () => {},
  refresh: async (): Promise<RefreshResult> => {
    renewals += 1
    await gate
    // 一个真的换过的凭据，好让 `stop()` 之后能读出来「sweep 那一步已经落库了」。
    return { status: 'refreshed', detail: '桩平台：续期成功', credentials: RENEWED_CREDENTIAL }
  }
}

// 注册表没有撤销（`registry.ts` 说明了为什么），所以桩平台是**本文件**的状态：它只在这里可见。
registerPlatform(stubPlatform)

interface Desk {
  readonly db: Db
  readonly accountId: number
}

/** 一个绑在桩平台上的账号，因为这个文件要读到 `refresh` 走完之后那一行。 */
const it = base.extend<{ desk: Desk }>({
  desk: async ({ db }, use) => {
    const user = createUser(db, 'stophook', 'x', NOW)
    const account = upsertAccount(db, user.id, {
      platform: STUB_KEY,
      externalId: '1',
      displayName: '桩账号',
      avatar: '',
      credentials: OLD_CREDENTIAL
    })
    await use({ db, accountId: account.id })
  }
})

/** 这个文件注册过的钩子；`afterEach` 全部注销，见文件头。 */
const disposers: Array<() => void> = []

/** 让事件循环转几圈（微任务与 `setImmediate` 都走一遍），好让「什么都没发生」有机会被推翻。 */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

beforeEach(() => {
  renewals = 0
  gate = Promise.resolve()
  disposers.length = 0
})

afterEach(() => {
  for (const off of disposers) off()
  disposers.length = 0
})

describe('Scheduler.stop() 的停止钩子', () => {
  it('钩子只在在途的那一次 sweep 结束之后跑', async ({ desk }) => {
    const readByTheHook: string[] = []
    disposers.push(
      onSchedulerStop(async () => {
        // 这个钩子的读数**就是**断言：它读的是 sweep 自己那一步写下的凭据，所以「钩子跑在 sweep 之后」
        // 不靠两个回调的排队顺序，而靠一次真的发生在 sweep 里的写入。
        readByTheHook.push(getAccountCredentials(desk.db, desk.accountId) ?? '')
      })
    )

    let release: () => void = () => {}
    gate = new Promise<void>(resolve => {
      release = resolve
    })

    const scheduler = new Scheduler({ db: desk.db })
    const sweep = scheduler.tick(NOW)

    // `refresh` 是 `tick` 的第一个 `await`，而它停在闸门上：调用 `tick` 只走到这里就回来了，
    // 所以「在途的那一次 sweep」在这个文件里是**确定的**，不是一个概率。
    expect(renewals).toBe(1)

    const stopping = scheduler.stop()
    // 让事件循环真的转几圈，而不是只让两格微任务落下：钩子跑不跑与「谁先排队」无关，只与那次 sweep 有没有
    // 结束有关，所以这一步是给「什么都没发生」那句话一个被推翻的机会（注册表里还有别的钩子在前面）。
    await settle()

    // sweep 还在里面，所以一个钩子都没有跑 —— 这一行是「等它」那半句的可读形式。
    expect(readByTheHook).toEqual([])

    release()
    await stopping

    // 钩子看到的凭据是**续期之后**的那个：`stop()` 等的那一次 sweep 把自己的写入做完了才轮到钩子。
    expect(readByTheHook).toEqual([RENEWED_CREDENTIAL])
    await sweep
  })

  it('一个钩子抛了，不拦住后面的钩子，也不让 stop() 拒绝', async ({ desk }) => {
    const ran: string[] = []
    const lines: string[] = []
    disposers.push(
      onSchedulerStop(async () => {
        ran.push('第一个')
      }),
      onSchedulerStop(async () => {
        throw new Error('这个钩子抛了')
      }),
      onSchedulerStop(async () => {
        ran.push('最后一个')
      })
    )

    const scheduler = new Scheduler({
      db: desk.db,
      log: line => {
        lines.push(line)
      }
    })

    await expect(scheduler.stop()).resolves.toBeUndefined()

    // 按注册顺序跑，中间那个的异常成了日志里的一行，而不是别人的结局。
    expect(ran).toEqual(['第一个', '最后一个'])
    expect(lines.some(line => line.includes('stop hook failed') && line.includes('这个钩子抛了'))).toBe(true)
  })

  it('返回的那个函数就是注销：注销之后 stop() 不会再跑它', async ({ desk }) => {
    const ran: string[] = []
    const off = onSchedulerStop(async () => {
      ran.push('跑了')
    })
    off()

    const scheduler = new Scheduler({ db: desk.db })
    await scheduler.stop()

    expect(ran).toEqual([])
  })
})
