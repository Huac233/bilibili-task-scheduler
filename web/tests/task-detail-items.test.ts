import { NMessageProvider } from 'naive-ui'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { type App, createApp, h, nextTick } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'

import { http } from '../src/api/client.js'
import TaskDetailView from '../src/views/TaskDetailView.vue'
import TasksView from '../src/views/TasksView.vue'

/**
 * What a person can actually read off a reconcile task.
 *
 * This view used to answer one question — a count per outcome — which left the only
 * useful detail in the server's console. The pages below are the fix, and they are
 * asserted through the mounted DOM rather than through the payload, because both
 * halves of the promise are about rendering:
 *
 *  1. **The fact reaches the screen, and it leads the row.** Which 版块 was signed and
 *     what the check-in awarded, as names and numbers beside the action's own name —
 *     not as a sentence that repeats that name and the heading above it.
 *  2. **No identifier reaches it, except in the debug panel**, which is also where a
 *     record's own `detail` sentence now lives. `356` and `yuba_sign` are the two shapes
 *     of raw data this task exists to keep out of the sections a person reads, and the
 *     assertion is made by cutting the debug panel's text out of the page and searching
 *     what is left.
 */

const DAY = 24 * 60 * 60 * 1000

/** The catalogue the fixtures resolve their labels from: three Douyu reconcile actions. */
const ACTION_CATALOGUE = [
  {
    key: 'sign_in',
    action: 'reconcile',
    label: '客户端签到',
    description: '斗鱼客户端的每日签到。',
    costly: false,
    needsTarget: false,
    needsLibrary: false,
    maxMessageLength: 0,
    defaultIntervalSeconds: 300,
    minIntervalSeconds: 60
  },
  {
    key: 'yuba_sign',
    action: 'reconcile',
    label: '鱼吧签到',
    description: '给已关注的每个鱼吧签到。',
    costly: false,
    needsTarget: false,
    needsLibrary: false,
    maxMessageLength: 0,
    defaultIntervalSeconds: 300,
    minIntervalSeconds: 60
  },
  {
    key: 'activity_sign',
    action: 'reconcile',
    label: '任务中心签到',
    description: '斗鱼任务中心的每日签到。',
    costly: false,
    needsTarget: false,
    needsLibrary: false,
    maxMessageLength: 0,
    defaultIntervalSeconds: 300,
    minIntervalSeconds: 60
  },
  {
    key: 'send_danmaku',
    action: 'send',
    label: '发送弹幕',
    description: '按固定间隔把文本库里的弹幕一条条发进直播间。',
    costly: false,
    needsTarget: true,
    needsLibrary: true,
    maxMessageLength: 20,
    defaultIntervalSeconds: 30,
    minIntervalSeconds: 10
  }
] as const

/** A fixed instant, so the rendered times cannot drift with the clock. */
const AT_TODAY = Date.parse('2026-03-10T09:12:00+08:00')
const AT_YESTERDAY = Date.parse('2026-03-09T21:30:00+08:00')

/**
 * One reconcile task, with everything this feature added on it.
 *
 * `code: '3561207'` on the 鱼吧 record is kept literal so the assertion below is about the
 * actual string rather than about a shape. It is deliberately seven digits rather than the
 * spec's short `356`: a short numeric literal can be **formed by two adjacent rendered
 * values** — this fixture already carries 「本次经验 +100」 beside a timestamp, and `1001`
 * read as a substring of `+100` + `1:12:00` made the assertion fail in CI while passing
 * locally. A long literal cannot be assembled by accident, which is the same reason the
 * Bilibili fixtures spell `secret_key` out. Real Douyu codes are long anyway (`1003212`).
 *
 * The `detail` strings are the adapters' own, in their fact form: 「连签 7 天」 rather than
 * 「签到成功：连续签到 7 天…」. A record whose items are the action itself carries the same two
 * strings on the record and on its item, because both adapters build the pair from one value.
 */
const TASK = {
  id: 1,
  userId: 1,
  platform: 'douyu',
  accountId: 1,
  libraryId: null,
  action: 'reconcile',
  actionKey: 'sign_in',
  targetKey: '',
  targetTitle: '',
  startTime: 0,
  endTime: DAY,
  interval: 300,
  status: 'running',
  cursor: 0,
  loopCount: 0,
  sentCount: 0,
  successCount: 0,
  failCount: 0,
  saltEnabled: false,
  requireOnline: false,
  lastSentAt: null,
  lastLiveStatus: null,
  lastCheckedAt: null,
  lastError: '',
  createdAt: 0,
  updatedAt: 0,
  progress: {
    cursor: 0,
    loopCount: 0,
    sentCount: 0,
    successCount: 0,
    failCount: 0,
    libraryTotal: null,
    bulletIndex: 0,
    percentInLoop: 0,
    remainingInLoop: null
  },
  actionLogSummary: { total: 3, done: 2, already: 1, skipped: 0, failed: 0, blocked: 0 },
  settledTodayKeys: ['activity_sign', 'sign_in', 'yuba_sign'],
  actionLogsToday: [
    {
      id: 2,
      taskId: 1,
      actionKey: 'sign_in',
      targetKey: '',
      outcome: 'done',
      detail: '连签 7 天、本次经验 +10',
      code: '0',
      items: [
        {
          kind: 'account',
          label: '客户端签到',
          outcome: 'done',
          detail: '连签 7 天、本次经验 +10',
          code: '0'
        }
      ],
      at: AT_TODAY
    },
    {
      id: 3,
      taskId: 1,
      actionKey: 'yuba_sign',
      targetKey: '',
      outcome: 'done',
      detail: '新签 1、已签 2（共 3 个版块）',
      code: '3561207',
      items: [
        { kind: 'group', label: '主版块', outcome: 'done', detail: '等级分 +3', code: '200' },
        { kind: 'group', label: '斗鱼官方手游区', outcome: 'already', detail: '已签', code: '1003212' }
      ],
      at: AT_TODAY + 60_000
    },
    {
      // A row written before the `items` column existed: the migration is purely additive
      // (`NOT NULL DEFAULT '[]'`, see `server/src/db/index.ts`), so its `items` really is
      // empty and its own sentence really is all there is to show.
      id: 4,
      taskId: 1,
      actionKey: 'activity_sign',
      targetKey: '',
      outcome: 'already',
      detail: '斗鱼「任务中心」今天已经签过了，本日已完成。',
      code: '6305',
      items: [],
      at: AT_TODAY + 120_000
    }
  ],
  actionLogDays: [
    {
      dayKey: '2026-03-09',
      startedAt: AT_YESTERDAY - 21 * 60 * 60 * 1000,
      records: [
        {
          id: 1,
          taskId: 1,
          actionKey: 'sign_in',
          targetKey: '',
          outcome: 'already',
          detail: '已签',
          code: '6305',
          items: [
            {
              kind: 'account',
              label: '客户端签到',
              outcome: 'already',
              detail: '已签',
              code: '6305'
            }
          ],
          at: AT_YESTERDAY
        }
      ]
    }
  ]
}

let switchesOff = false
/** When set, `GET /api/tasks/2/logs` is refused, which is the read this page can do without. */
let logsRefused = false
/** When set, `GET /api/tasks` is refused, which is the read behind 「还没有任务」. */
let tasksRefused = false

/** A Send task whose window has closed: the row that showed 「已完成」 after sending part of its library. */
const SEND_TASK = {
  ...TASK,
  id: 2,
  libraryId: 3,
  action: 'send',
  actionKey: 'send_danmaku',
  targetKey: '8801',
  targetTitle: '电棍',
  status: 'done',
  endTime: Date.parse('2020-01-01T00:00:00+08:00'),
  saltEnabled: true,
  actionLogsToday: [],
  actionLogDays: [],
  settledTodayKeys: undefined
}

/** A paused account-scoped reconcile task, which is the state the edit dialog is offered in. */
const PAUSED_TASK = { ...TASK, id: 3, status: 'paused' }

/**
 * A reconcile task whose window has closed with the action unsettled.
 *
 * `done` is the window's own word — the scheduler reaches it through `finish` alone, for either
 * executor — so this row is the shape that used to read 「已完成」 in the badge and 「今天的动作还没落定」
 * on the line under it.
 */
const DONE_TASK = {
  ...TASK,
  id: 4,
  status: 'done',
  endTime: Date.parse('2020-01-01T00:00:00+08:00'),
  settledTodayKeys: []
}

/** A Task whose Platform a newer build wrote, so this catalogue cannot answer for its switch. */
const ORPHAN_TASK = { ...TASK, id: 5, platform: 'newplatform', actionKey: 'sign_in' }

/**
 * A Task holding a record whose **outcome** this build cannot name — a row written by a newer build.
 *
 * `ActionLog.outcome` is typed as the five, but the column holds text: `toOutcome` is what turns a stored
 * value into one of them, and the browser is handed the value *before* that reading. The counters beside
 * the list are the other half: `summarizeActionLogs` derives its `failed` as the remainder, so this one
 * row is already counted as a failure up on 「已存记录」 — 「失败 1」 — while the row itself drew a tag
 * holding nothing.
 */
const UNKNOWN_OUTCOME_TASK = {
  ...TASK,
  id: 6,
  actionLogSummary: { total: 1, done: 0, already: 0, skipped: 0, failed: 1, blocked: 0 },
  actionLogsToday: [
    {
      id: 9,
      taskId: 6,
      actionKey: 'sign_in',
      targetKey: '',
      outcome: 'a-newer-build',
      detail: '这个版本不认识这条记录的结果',
      code: '0',
      items: [],
      at: AT_TODAY
    }
  ],
  actionLogDays: []
}

const TASKS: Record<number, unknown> = {
  1: TASK,
  2: SEND_TASK,
  3: PAUSED_TASK,
  4: DONE_TASK,
  5: ORPHAN_TASK,
  6: UNKNOWN_OUTCOME_TASK
}

/** Two refusals and an acceptance, with the codes the Platform really answered (`SendLog.code`). */
const SEND_LOGS = [
  { id: 1, taskId: 2, content: '这是成功的一条', ok: true, code: '0', error: '', at: AT_TODAY },
  { id: 2, taskId: 2, content: '这是失败的一条', ok: false, code: '560', error: '弹幕内容被拒绝', at: AT_TODAY + 1000 },
  // No code came back at all — the shape a transport failure has — so the row has the word without a
  // number.
  { id: 3, taskId: 2, content: '这是失败且没有码的一条', ok: false, code: '', error: '连接被重置', at: AT_TODAY + 2000 }
]

function fixtureFor(url: string): unknown {
  if (url.endsWith('/api/platforms')) {
    return { ok: true, platforms: [{ key: 'douyu', label: '斗鱼', actions: ACTION_CATALOGUE }] }
  }
  if (url.endsWith('/api/action-settings')) {
    return {
      ok: true,
      settings: ACTION_CATALOGUE.map(action => ({
        platform: 'douyu',
        actionKey: action.key,
        enabled: switchesOff ? action.key !== 'sign_in' : true,
        options: {}
      }))
    }
  }
  if (pathOf(url).endsWith('/api/tasks')) {
    if (tasksRefused) throw new Error('这一次没读到任务列表')
    return { ok: true, tasks: Object.values(TASKS) }
  }

  for (const [id, task] of Object.entries(TASKS)) {
    if (pathOf(url).endsWith(`/api/tasks/${id}/logs`)) {
      if (logsRefused) throw new Error('发送日志这次没读到')
      const logs = id === '2' ? SEND_LOGS : []
      return { ok: true, summary: { total: logs.length, ok: 1, failed: logs.length - 1 }, logs }
    }
    if (pathOf(url).endsWith(`/api/tasks/${id}`)) {
      return { ok: true, task, library: null, account: null, logSummary: { total: 0, ok: 0, failed: 0 } }
    }
  }

  throw new Error(`no fixture for ${url}`)
}

http.defaults.adapter = async config => {
  const data = fixtureFor(config.url ?? '')
  return { data, status: 200, statusText: 'OK', headers: {}, config }
}

/** localStorage, which the request interceptor reads. */
const tokens = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => tokens.get(key) ?? null,
    setItem: (key: string, value: string) => void tokens.set(key, value),
    removeItem: (key: string) => void tokens.delete(key)
  }
})

/** Naive UI measures its overlays; these views do not, but the components assume both exist. */
class StubObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return []
  }
}
Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: StubObserver })
Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: StubObserver })

/** Flushes microtasks and one macrotask, so the `onMounted` chain lands. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  for (let i = 0; i < 6; i += 1) await nextTick()
}

async function mountView(view: Parameters<typeof h>[0], path: string): Promise<App> {
  const host = document.createElement('div')
  document.body.append(host)

  const router = createRouter({
    history: createWebHashHistory(),
    routes: [
      { path: '/tasks', name: 'tasks', component: { render: () => null } },
      { path: '/tasks/:id', name: 'task-detail', component: { render: () => null } },
      { path: '/action-settings', name: 'action-settings', component: { render: () => null } }
    ]
  })
  await router.push(path)

  // `useMessage` needs its provider above the view, exactly as the app's tree has it.
  const app = createApp({ render: () => h(NMessageProvider, null, { default: () => h(view) }) })
  app.use(createPinia())
  app.use(router)
  app.mount(host)
  await settle()
  return app
}

function text(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ')
}

/**
 * The page as a person reads it: everything except the debug panel.
 *
 * The panel's text is cut out by value rather than by hiding it from the query, so the
 * assertion is the rule itself — that the identifier is *there* and nowhere else. It
 * works whether the panel's body is in the document or not, which keeps this test from
 * asserting a framework's decision about when collapsed content is rendered.
 */
function readableText(): string {
  const debug = [...document.querySelectorAll('.n-collapse-item')].find(item =>
    (item.querySelector('.n-collapse-item__header')?.textContent ?? '').includes('高级/调试')
  )
  const panel = debug?.textContent ?? ''
  return (document.body.textContent ?? '').replace(panel, '').replace(/\s+/g, ' ')
}

/** The path of a request, so a fixture can compare against it rather than against the query too. */
function pathOf(url: string): string {
  return url.split('?')[0] ?? url
}

/**
 * The rows of the record lists — where an outcome's word is drawn, and nowhere else.
 *
 * Scoped on purpose: the counters row on this same page legitimately prints 「失败」 for the same record
 * (the server derives that number through `toOutcome`), so a page-wide search would pass over a row that
 * says nothing.
 */
function recordRows(): string {
  return [...document.querySelectorAll('.item')].map(row => row.textContent ?? '').join(' | ')
}

/**
 * The tags in the one card header these pages draw: the Platform's name and the status word.
 *
 * Asserted together rather than by searching the page's text, because 「今日已完成」 contains
 * 「已完成」 — the whole point of splitting the word is that one is a status and the other is the day,
 * and only the header carries the status.
 */
function statusWords(): string[] {
  return [...document.querySelectorAll('.n-card-header .n-tag')].map(tag => (tag.textContent ?? '').trim())
}

/**
 * Opens the debug panel the way a person does, since it ships shut.
 *
 * The click goes on the header's inner element, which is what naive-ui puts the toggle
 * handler's element around; clicking it is the same event a pointer produces.
 */
async function openDebugPanel(): Promise<void> {
  const debug = [...document.querySelectorAll('.n-collapse-item')].find(item =>
    (item.querySelector('.n-collapse-item__header')?.textContent ?? '').includes('高级/调试')
  )
  const toggle = debug?.querySelector('.n-collapse-item__header-main')
  if (toggle === undefined || toggle === null) throw new Error('the debug panel was not rendered')

  toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await settle()
}

beforeEach(() => {
  document.body.innerHTML = ''
  switchesOff = false
  logsRefused = false
  tasksRefused = false
})

describe('the task detail page', () => {
  it('shows what today’s actions did, item by item', async () => {
    const app = await mountView(TaskDetailView, '/tasks/1')
    const shown = readableText()

    // The check-in's item carries what it awarded, the 鱼吧 items carry which 版块 — as numbers
    // beside a name, which is what a person reads, rather than inside a sentence about them.
    expect(shown).toContain('客户端签到')
    expect(shown).toContain('连签 7 天')
    expect(shown).toContain('主版块')
    expect(shown).toContain('等级分 +3')
    expect(shown).toContain('斗鱼官方手游区')
    expect(shown).toContain('已签')

    // And the action's own name is not said twice: its one item is the action, so the row is
    // the name and then the fact.
    expect(shown).toMatch(/客户端签到\s*连签 7 天/)

    app.unmount()
  })

  it('shows a record that named no item from its own sentence, rather than dropping it', async () => {
    const app = await mountView(TaskDetailView, '/tasks/1')

    // An empty `items` is not only a pre-migration shape: an action this build cannot name has
    // no catalogue entry to be labelled from, so both adapters deliberately write no item for
    // it. Its own `detail` is then the whole truth about the row, and hiding it — as the rows
    // that do have items hide theirs — would leave the row saying nothing.
    expect(readableText()).toContain('斗鱼「任务中心」今天已经签过了，本日已完成。')

    app.unmount()
  })

  it('shows earlier days, and keeps their records out of today’s section', async () => {
    const app = await mountView(TaskDetailView, '/tasks/1')

    // The day is the server's grouping, so the heading is the day it sent.
    expect(text()).toContain('2026-03-09')
    // Yesterday's check-in is not reported as today's: the two questions are separate,
    // and one section answering both is what the old screen did.
    expect(TASK.actionLogsToday?.map(record => record.actionKey)).not.toContain('fishball')

    app.unmount()
  })

  it('keeps every identifier inside the debug panel, and says what was done outside it', async () => {
    const app = await mountView(TaskDetailView, '/tasks/1')

    // The rule holds with the panel shut…
    expect(readableText()).not.toContain('3561207')
    expect(readableText()).not.toContain('yuba_sign')
    // The rewritten rows carry the same shapes the sentences they replaced did: a group's code,
    // and the 鱼吧 record's own aggregate — which is the audit line the rows no longer print.
    expect(readableText()).not.toContain('1003212')
    expect(readableText()).not.toContain('共 3 个版块')

    await openDebugPanel()

    // …and the panel is where the raw feed lives: a code, an action key and a platform
    // key, which is exactly what a bug report needs and what a person reading 「今天做
    // 了什么」 must not have to parse.
    expect(text()).toContain('3561207')
    expect(text()).toContain('yuba_sign')
    // 「斗鱼」 is what the panel above shows; the key itself is here.
    expect(text()).toContain('douyu')
    // The record's own `detail` moved here, beside the code it came with. It stays in the
    // payload and in the database — it is only the rows above that stopped printing it.
    expect(text()).toContain('共 3 个版块')

    // None of it leaked into the sections that say what was done.
    expect(readableText()).not.toContain('3561207')
    expect(readableText()).not.toContain('yuba_sign')
    expect(readableText()).not.toContain('sign_in')
    expect(readableText()).toContain('主版块')

    app.unmount()
  })
})

describe('the one action a reconcile task names', () => {
  it('reads today off that action, not off the Platform’s other switches', async () => {
    const app = await mountView(TaskDetailView, '/tasks/1')

    // `settledTodayKeys` carries three keys — 客户端签到 among them, which is the one this Task names —
    // and the verdict is written for that single action rather than for the set. A Task does not run
    // the other two: they are not switched into this row at all.
    expect(readableText()).toContain('今日已完成')
    expect(readableText()).toContain('客户端签到 今天已经落定')

    app.unmount()
  })

  it('says the switch is off, instead of leaving "nothing happened" unexplained', async () => {
    switchesOff = true
    const app = await mountView(TaskDetailView, '/tasks/1')

    expect(readableText()).toContain('动作开关未打开')
    expect(readableText()).toContain('「客户端签到」没开启，这个任务不会跑')
    // Not 「今日已完成」: the action has not run, and a settled day would be a claim about work that
    // never happened — which is the state this whole screen used to be silent about.
    expect(readableText()).not.toContain('今日已完成')

    app.unmount()
  })
})

describe('the task list row', () => {
  /**
   * Today's action rows alone.
   *
   * The counters beside them legitimately print outcome words — 「已存记录 无需处理 1」 counts the rows
   * the table still holds, which is a different question from today — so a claim about what a *row*
   * says has to be made against the rows.
   */
  function actionRows(): string {
    return [...document.querySelectorAll('.result')].map(row => row.textContent ?? '').join(' | ')
  }

  it('names each of today’s actions and what it got done', async () => {
    const app = await mountView(TasksView, '/tasks')
    const shown = readableText()

    expect(shown).toContain('今日动作')
    expect(shown).toContain('客户端签到')
    // The action's result, not only its name: the group that was signed and what it awarded is
    // the answer to "今天这个动作怎么样了", which a count per outcome could never give.
    expect(shown).toContain('主版块 等级分 +3')
    expect(shown).toContain('斗鱼官方手游区 已签')

    // No tag on a row the day has settled: the 今日 line above has already said 今日已完成, so
    // 「无需处理」 down the column would be that sentence again. The count in the counters row stays —
    // under 「已存记录」, which is what the number is: the rows the table holds, today included.
    expect(actionRows()).not.toContain('无需处理')
    expect(shown).toContain('已存记录')
    // The fact leads, and the action's name appears once: the two sit in adjacent elements,
    // with no text node between them, so the gap is the layout's rather than the text's.
    expect(actionRows()).toMatch(/客户端签到\s*连签 7 天/)

    app.unmount()
  })

  it('leaves the raw fields off the row as well', async () => {
    const app = await mountView(TasksView, '/tasks')

    expect(readableText()).not.toContain('3561207')
    expect(readableText()).not.toContain('yuba_sign')
    // The row carries no history at all — the endpoint does not ship any — so nothing
    // from an earlier day may appear on it.
    expect(readableText()).not.toContain('2026-03-09')

    app.unmount()
  })

  it('says on the row that the action’s switch is off', async () => {
    switchesOff = true
    const app = await mountView(TasksView, '/tasks')

    // The same verdict as the detail page's, from the same `reconcileTodayOf`: the row is where a
    // person notices that nothing is happening, so it has to say which switch would fix it.
    expect(readableText()).toContain('动作开关未打开')
    expect(readableText()).toContain('「客户端签到」没开启，这个任务不会跑')
    expect(readableText()).not.toContain('今日已完成')

    app.unmount()
  })

  it('does not claim there are no tasks when the list could not be read', async () => {
    tasksRefused = true
    const app = await mountView(TasksView, '/tasks')

    // 「还没有任务」 is the one sentence a person acts on, and a failed read leaves behind exactly the
    // empty array an empty account does. The error bar above is where the difference is said, so the
    // claim is drawn only once the read has succeeded.
    expect(readableText()).toContain('这一次没读到任务列表')
    expect(readableText()).not.toContain('还没有任务')

    app.unmount()
  })
})

describe('the word for a closed window', () => {
  it('reads 「时间窗已结束」 for a Send task that reached its window, not 「已完成」', async () => {
    const app = await mountView(TaskDetailView, '/tasks/2')

    // `done` is written by the scheduler's `finish` alone — `now >= endTime` — for either executor,
    // so a Send task that sent what it could is `done` because its window closed, not because its
    // work finished. 「已完成」 said the second.
    expect(statusWords()).toContain('时间窗已结束')
    expect(statusWords()).not.toContain('已完成')
    // Its own row still shows what it actually sent, which is the fact the badge is not allowed to
    // overwrite.
    expect(readableText()).toContain('已刷遍数')

    app.unmount()
  })

  it('says a closed window with an unsettled action, instead of 「还没落定」 alone', async () => {
    const app = await mountView(TaskDetailView, '/tasks/4')

    // The row this defect was reported on: the window ended and the action never settled today, so
    // both facts belong on it. 「今天的动作还没落定」 by itself reads as "it may still happen".
    expect(statusWords()).toContain('时间窗已结束')
    expect(readableText()).toContain('时间窗已结束，今天的动作没落定')
    expect(readableText()).toContain('窗口已经过完')
    expect(readableText()).not.toContain('今天的动作还没落定')

    app.unmount()
  })

  it('keeps 「今日已完成」 for the day a reconcile task really finished', async () => {
    const app = await mountView(TaskDetailView, '/tasks/1')

    // The other word, at the other question: this Task's action settled today, so the day is done —
    // and the status word above it is still the window's, because that is what the status is.
    expect(readableText()).toContain('今日已完成')
    expect(statusWords()).not.toContain('今日已完成')

    app.unmount()
  })
})

describe('what the page may claim about the numbers it shows', () => {
  it('names the range the action-record count covers, which includes today', async () => {
    const app = await mountView(TaskDetailView, '/tasks/1')

    // The count is `summarizeActionLogs` — one `COUNT(*)` over `action_logs WHERE task_id = ?` — so it is
    // the rows the table *still holds*: today's are all in it, and everything older is there only as far
    // as the retention keeps it. The sentence this replaces said both halves backwards, 「共 N 条动作记录，
    // 不代表今天」, over exactly this number.
    expect(readableText()).toContain('含今天')
    expect(readableText()).toContain('保留上限')
    expect(readableText()).not.toContain('不代表今天')
    // And the label above it, which is the same claim in one word: 「累计」 promised a total the query
    // does not compute. Both are asserted because both are what a reader acted on.
    expect(readableText()).not.toContain('从绑定到现在')
    expect(readableText()).toContain('已存记录')

    app.unmount()
  })

  it('shows a failure’s own code, and never the success code under 「失败」', async () => {
    const app = await mountView(TaskDetailView, '/tasks/2')

    // The Platform's answer is printed when it is one…
    expect(readableText()).toContain('失败 #560')
    expect(readableText()).toContain('连接被重置')
    // …and `#0` never is: `0` is the success code on both Platforms, so a failed row carrying it would
    // be this page contradicting the very word beside it. The row that has no code says only 「失败」.
    expect(readableText()).not.toContain('#0')

    app.unmount()
  })

  it('names only the fields the edit dialog actually draws for this task', async () => {
    const app = await mountView(TaskDetailView, '/tasks/3')

    // 客户端签到 is account-scoped: the dialog draws 生效时间 and 执行间隔, and neither switch, because
    // 等待开播 needs a Target and 加盐 is a Send concept. The hint named all four.
    expect(readableText()).toContain('可以修改生效时间、间隔')
    expect(readableText()).not.toContain('等待开播')
    expect(readableText()).not.toContain('加盐')

    app.unmount()
  })
})

/**
 * An outcome this build cannot name, on the screen a person reads.
 *
 * The settling half of this boundary was repaired in the previous round (`isUnsettledOutcome`), and the
 * display half was left behind it: `ACTION_OUTCOME_LABEL[value]` is keyed by the five's own type, so this
 * payload — the value *before* `toOutcome`'s reading — drew a tag containing nothing, under a heading and
 * beside a counter that both already said 失败. The fix is a fallback in the lookup, and the assertion is
 * on the row rather than on the payload because an empty cell is exactly what a data assertion cannot see.
 */
describe('a record whose outcome this build cannot name', () => {
  it('is given a word on its row, instead of a tag holding nothing', async () => {
    const app = await mountView(TaskDetailView, '/tasks/6')

    const rows = recordRows()
    // The row itself was 「客户端签到 这个版本不认识这条记录的结果 <空的标签> 09:12:00」.
    expect(rows).toContain('失败')
    // And the same value, counted by the server's own derivation, is where the page already said it —
    // which is the asymmetry the row was on the wrong side of.
    expect(readableText()).toContain('失败 1')

    app.unmount()
  })

  it('is given the same word on the list screen, which draws the same payload field', async () => {
    const app = await mountView(TasksView, '/tasks')

    // `TasksView` draws today's records out of `actionLogsToday` too, through the same two tables — so the
    // empty tag was on two screens rather than one, and a single lookup answering both is what stops them
    // diverging again. Scoped to the record rows for the same reason as above: 「已存记录」 on this row
    // legitimately prints 失败 1 for the same record.
    const rows = [...document.querySelectorAll('.result')].map(row => row.textContent ?? '').join(' | ')
    expect(rows).toContain('失败')

    app.unmount()
  })
})

/**
 * What a history day's heading is entitled to count.
 *
 * `dayTitle` counts `day.records`, and the payload carries at most `HISTORY_LOG_LIMIT` earlier rows
 * (`server/src/routes/tasks.ts`) — so a day with more writes than that arrives cut short, and a heading
 * reading 「2026-03-09（受阻 1）」 was this page calling a sample the day's totals. What the heading can
 * count is what is under it: the very list that entry opens.
 */
describe('what a history day’s heading counts', () => {
  it('says it counts the records this payload carried for the day, not the day', async () => {
    const app = await mountView(TaskDetailView, '/tasks/1')

    expect(readableText()).toContain('2026-03-09')
    expect(readableText()).toContain('下面这 1 条：无需处理 1')

    app.unmount()
  })
})

describe('what one failed read is allowed to take with it', () => {
  it('blames the half that could not answer, not always the server', async () => {
    const app = await mountView(TaskDetailView, '/tasks/5')

    // The verdict has two causes and they are not one sentence. This Task's Platform is one the
    // catalogue does not know — a row a newer build wrote — so the switch cannot be answered here, and
    // the field is present: `settledTodayKeys` came with the payload. The row used to print the
    // field's sentence for both, which is a claim about the server made when the cause is this
    // process's own catalogue (and on the ordinary first paint it is the *usual* cause, because the
    // catalogue is asked for without being awaited).
    expect(readableText()).toContain('动作目录还没读到')
    expect(readableText()).not.toContain('服务端没有返回按天的动作状态')

    app.unmount()
  })

  it('keeps the page when the send log cannot be read', async () => {
    logsRefused = true
    const app = await mountView(TaskDetailView, '/tasks/2')

    // The detail is what this page is for and it arrived; the log is an extra. Sharing one `try` — and
    // one error slot, which the template draws *instead of* everything else — left nothing but the
    // error sentence.
    expect(readableText()).toContain('发送弹幕')
    expect(readableText()).toContain('已刷遍数')
    expect(readableText()).toContain('发送日志这次没读到')
    // And the empty state is not claimed for a read that failed.
    expect(readableText()).not.toContain('还没有发送记录')
    // Nor is the range sentence, which is a claim about what the list below holds: it is drawn only once
    // that read landed, exactly as 「还没有发送记录」 is. This assertion guards the condition rather than
    // reproducing a defect — it passed before the sentence existed, and it is here to stop it being drawn
    // over a card with no list.
    expect(readableText()).not.toContain('发送日志表')

    app.unmount()
  })

  it('re-reads when the address names another task', async () => {
    const app = await mountView(TaskDetailView, '/tasks/1')
    const router = app.config.globalProperties.$router as { push: (to: string) => Promise<unknown> } | undefined
    expect(router).toBeDefined()

    expect(statusWords()).toContain('运行中')

    // The instance is reused across two addresses on the same route record, so `onMounted` alone left
    // task 1 on screen while the address said 2 — and the edit dialog takes its row from this page.
    await router?.push('/tasks/3')
    await settle()

    expect(statusWords()).toContain('已暂停')
    expect(readableText()).toContain('可以修改生效时间、间隔')

    app.unmount()
  })
})
