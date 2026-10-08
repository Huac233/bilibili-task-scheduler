import type {
  Account,
  ActionChoice,
  ActionDescriptor,
  ActionSetting,
  ActionWorkflow,
  ApiToken,
  BulletPage,
  HealthInfo,
  Library,
  LogSummary,
  Platform,
  PreviewResult,
  ReplacementRule,
  SegmentParams,
  SendLog,
  StoredRule,
  SystemEvent,
  TargetInfo,
  Task,
  TaskEditPatch,
  TaskWithProgress,
  User
} from '../types/api.js'
import { http } from './client.js'

/**
 * Typed API surface.
 *
 * One function per endpoint, each returning the parsed body. Components never
 * touch axios directly, so a route rename or a shape change has exactly one
 * place to land.
 *
 * Everything here is Platform-neutral: the catalogue, the accounts, the
 * switchboard and the tasks are all addressed by whatever key the server hands
 * out, never by a name written into this file. The one exception is the **bind
 * flow** at the bottom, and it is marked as such — a handshake's shape is
 * genuinely platform-specific and cannot be read out of `GET /api/platforms`,
 * which describes what a Platform can *do*, not how a person proves they own an
 * account on it.
 */

interface AuthResponse {
  ok: boolean
  token: string
  user: User
}

export const authApi = {
  async register(username: string, password: string): Promise<AuthResponse> {
    const { data } = await http.post<AuthResponse>('/api/auth/register', { username, password })
    return data
  },

  async login(username: string, password: string): Promise<AuthResponse> {
    const { data } = await http.post<AuthResponse>('/api/auth/login', { username, password })
    return data
  },

  async me(): Promise<User> {
    const { data } = await http.get<{ ok: boolean; user: User }>('/api/auth/me')
    return data.user
  }
}

/**
 * The Platform catalogue, and the one route that turns pasted input into a Target.
 *
 * A Platform's `actions` are its `ActionDescriptor`s verbatim, which is what lets
 * the create form be driven by data: which fields to show, what an interval
 * should default to and whether an action costs the account something are all
 * answered by the descriptor rather than by a branch on a Platform key.
 */
export const platformApi = {
  async list(): Promise<Platform[]> {
    const { data } = await http.get<{ ok: boolean; platforms: Platform[] }>('/api/platforms')
    return data.platforms
  },

  /**
   * Resolves a Target on one Platform from whatever a person pasted.
   *
   * The lookup is server-side because only the Platform's own adapter knows which
   * host allowlist applies, which slug maps to which id, and which of several
   * endpoints returns the title; resolving here also proves the Target exists, so
   * a typo surfaces in the form rather than as a task that monitors nothing.
   */
  async resolveTarget(platform: string, input: string): Promise<TargetInfo> {
    const { data } = await http.post<{ ok: boolean; target: TargetInfo }>('/api/targets/resolve', { platform, input })
    return data.target
  }
}

/** Bound accounts across every Platform. No credential ever arrives through here. */
export const accountApi = {
  async list(): Promise<Account[]> {
    const { data } = await http.get<{ ok: boolean; accounts: Account[] }>('/api/accounts')
    return data.accounts
  },

  async remove(id: number): Promise<void> {
    await http.delete(`/api/accounts/${String(id)}`)
  }
}

/**
 * The action switchboard.
 *
 * The list is already merged over every Platform's catalogue, so an action that
 * has never been switched on still appears with `enabled: false`. That is the
 * only way the UI could show the full catalogue without also holding a copy of
 * it, and it is why absence-means-off stays a server-side fact.
 */
export const actionSettingApi = {
  async list(): Promise<ActionSetting[]> {
    const { data } = await http.get<{ ok: boolean; settings: ActionSetting[] }>('/api/action-settings')
    return data.settings
  },

  /**
   * Declares or clears one action, and optionally writes its options.
   *
   * The write answers with the resulting setting, which is what the store caches;
   * the fallback is only for a build that answers with a bare `ok`, and it mirrors
   * the endpoint's own "no options" representation (`{}`, not `'{}'`).
   *
   * `options` is omitted for a bare toggle, which the route reads as "keep what is stored" — the one
   * distinction this parameter exists to carry, because sending `{}` would quietly delete a value
   * somebody had set. It is `unknown` rather than a shape for the same reason the setting's own is:
   * the fields belong to the action, and the form builds the value out of the field list it was
   * handed rather than out of anything written here.
   */
  async set(platform: string, actionKey: string, enabled: boolean, options?: unknown): Promise<ActionSetting> {
    const { data } = await http.put<{ ok: boolean; setting?: ActionSetting }>('/api/action-settings', {
      platform,
      actionKey,
      enabled,
      ...(options === undefined ? {} : { options })
    })
    return data.setting ?? { platform, actionKey, enabled, options: options ?? {} }
  },

  /**
   * The choices for one choice-backed field, read live.
   *
   * **Failure is a value, not a throw**, because the route answers a refusal and a contract change
   * as `unavailable` with a sentence rather than a status code: a form that showed an error toast
   * and an empty list for both would be telling a person their backpack holds nothing.
   */
  async options(platform: string, actionKey: string, accountId: number, field: string): Promise<ActionChoice> {
    const { data } = await http.get<{ ok: boolean; choice: ActionChoice }>('/api/action-settings/options', {
      params: { platform, actionKey, accountId, field }
    })
    return data.choice
  },

  /** Which Tasks run this action, or the offer to create the one that is missing. */
  async workflow(platform: string, actionKey: string): Promise<ActionWorkflow> {
    const { data } = await http.get<{ ok: boolean; workflow: ActionWorkflow }>('/api/action-settings/workflow', {
      params: { platform, actionKey }
    })
    return data.workflow
  }
}

/**
 * The floor under a task's cadence, and the sentence that explains it.
 *
 * The number belongs to the action (`ActionDescriptor.minIntervalSeconds`), which
 * is also what the create and edit routes enforce — one catalogue value, checked
 * twice, so a value the form allows is a value the route accepts. A global floor
 * here would be wrong in both directions: it would forbid a Platform's own
 * measured-safe cadence and permit one faster than the Platform tolerates.
 *
 * The guard is not decoration: a payload from a build older than the field has
 * `undefined` here, and `Math.max(undefined, x)` is `NaN` — an interval box that
 * silently swallows every value. `1` is the route's own structural rule (a
 * positive whole number of seconds), which is the only honest fallback.
 */
export function intervalFloorOf(descriptor: ActionDescriptor): number {
  const declared = descriptor.minIntervalSeconds
  return typeof declared === 'number' && declared >= 1 ? declared : 1
}

/**
 * The two forms' own sentence for the cadence floor, and the reason it is not the route's.
 *
 * The route enforces the same number and says so in its own words
 * (`server/src/routes/tasks.ts`'s `intervalFloorMessage`). **This is not a copy of that sentence, and
 * the difference is the point**: the two packages cannot share a string, so a copy would be one rule
 * with two homes — which is exactly what this used to be, under a comment claiming the two would
 * "never describe one rule twice". What this form can say truthfully is what it checks: the action's
 * own `minIntervalSeconds`, read out of the catalogue, which is the same field the route compares
 * against. A person who reaches the route anyway hears the route's sentence, never both — the create
 * page and the edit dialog refuse the value here first, so the 400 is not what they meet.
 */
export function intervalFloorMessage(descriptor: ActionDescriptor): string {
  return `「${descriptor.label}」最快 ${String(intervalFloorOf(descriptor))} 秒一次，执行间隔不能比它小`
}

/**
 * A task's create body.
 *
 * `targetKey` and `libraryId` are optional because they are required exactly when
 * the chosen descriptor says `needsTarget` / `needsLibrary`, and `interval`,
 * `saltEnabled` and `requireOnline` fall back to server-side defaults when omitted. Optional rather
 * than nullable-everywhere so a caller cannot send an empty target for an action that has none.
 *
 * `requireOnline` is the 等待开播 switch — the one liveness gate the scheduler's `decide` reads.
 * `monitorOnline` used to sit beside it here and travelled into the row without a single reader, so the
 * route stopped accepting it; a request that still sends it now sends a key the schema does not declare,
 * which the route strips rather than refuses.
 */
export interface CreateTaskPayload {
  platform: string
  accountId: number
  actionKey: string
  startTime: number
  endTime: number
  interval?: number
  targetKey?: string
  targetTitle?: string
  libraryId?: number | null
  saltEnabled?: boolean
  requireOnline?: boolean
}

export const taskApi = {
  async list(): Promise<TaskWithProgress[]> {
    const { data } = await http.get<{ ok: boolean; tasks: TaskWithProgress[] }>('/api/tasks')
    return data.tasks
  },

  async create(payload: CreateTaskPayload): Promise<TaskWithProgress> {
    const { data } = await http.post<{ ok: boolean; task: TaskWithProgress }>('/api/tasks', payload)
    return data.task
  },

  async get(id: number): Promise<{
    task: TaskWithProgress
    library: Library | null
    account: Account | null
    logSummary: LogSummary
  }> {
    const { data } = await http.get<{
      ok: boolean
      task: TaskWithProgress
      library: Library | null
      account: Account | null
      logSummary: LogSummary
    }>(`/api/tasks/${String(id)}`)
    return { task: data.task, library: data.library, account: data.account, logSummary: data.logSummary }
  },

  /** Edits a paused task. The server rejects this for any other status. */
  async update(id: number, patch: TaskEditPatch): Promise<TaskWithProgress> {
    const { data } = await http.patch<{ ok: boolean; task: TaskWithProgress }>(`/api/tasks/${String(id)}`, patch)
    return data.task
  },

  async setStatus(id: number, status: Task['status']): Promise<TaskWithProgress> {
    const { data } = await http.patch<{ ok: boolean; task: TaskWithProgress }>(`/api/tasks/${String(id)}`, {
      status
    })
    return data.task
  },

  async reset(id: number): Promise<TaskWithProgress> {
    const { data } = await http.post<{ ok: boolean; task: TaskWithProgress }>(`/api/tasks/${String(id)}/reset`)
    return data.task
  },

  async logs(id: number, limit = 100): Promise<{ summary: LogSummary; logs: SendLog[] }> {
    const { data } = await http.get<{ ok: boolean; summary: LogSummary; logs: SendLog[] }>(
      `/api/tasks/${String(id)}/logs?limit=${String(limit)}`
    )
    return { summary: data.summary, logs: data.logs }
  },

  async remove(id: number): Promise<void> {
    await http.delete(`/api/tasks/${String(id)}`)
  }
}

/** Imported text, segmented into Bullets. Platform-neutral: a library is just text. */
export const libraryApi = {
  async list(): Promise<Library[]> {
    const { data } = await http.get<{ ok: boolean; libraries: Library[] }>('/api/libraries')
    return data.libraries
  },

  async preview(text: string, params: SegmentParams): Promise<PreviewResult> {
    const { data } = await http.post<PreviewResult>('/api/libraries/preview', { text, ...params })
    return data
  },

  async create(payload: {
    name: string
    filename: string
    text: string
    params: SegmentParams
  }): Promise<{ library: Library; stats: PreviewResult['stats'] }> {
    const { data } = await http.post<{ ok: boolean; library: Library; stats: PreviewResult['stats'] }>(
      '/api/libraries',
      { ...payload.params, name: payload.name, filename: payload.filename, text: payload.text }
    )
    return { library: data.library, stats: data.stats }
  },

  async get(id: number): Promise<Library> {
    const { data } = await http.get<{ ok: boolean; library: Library }>(`/api/libraries/${String(id)}`)
    return data.library
  },

  async bullets(id: number, offset: number, limit: number): Promise<BulletPage> {
    const { data } = await http.get<BulletPage>(
      `/api/libraries/${String(id)}/bullets?offset=${String(offset)}&limit=${String(limit)}`
    )
    return data
  },

  async remove(id: number): Promise<void> {
    await http.delete(`/api/libraries/${String(id)}`)
  }
}

export const replacementApi = {
  async list(): Promise<{ rules: StoredRule[]; limit: number }> {
    const { data } = await http.get<{ ok: boolean; rules: StoredRule[]; limit: number }>('/api/replacements')
    return { rules: data.rules, limit: data.limit }
  },

  async create(input: ReplacementRule): Promise<StoredRule> {
    const { data } = await http.post<{ ok: boolean; rule: StoredRule }>('/api/replacements', input)
    return data.rule
  },

  async setEnabled(id: number, enabled: boolean): Promise<StoredRule> {
    const { data } = await http.patch<{ ok: boolean; rule: StoredRule }>(`/api/replacements/${String(id)}`, {
      enabled
    })
    return data.rule
  },

  async remove(id: number): Promise<void> {
    await http.delete(`/api/replacements/${String(id)}`)
  }
}

export const eventApi = {
  /** Incremental pull. Feed `nextCursor` back in as `since` on the next call. */
  async list(
    since: number,
    limit = 100
  ): Promise<{ events: SystemEvent[]; nextCursor: number; latestId: number; hasMore: boolean }> {
    const { data } = await http.get<{
      ok: boolean
      events: SystemEvent[]
      nextCursor: number
      latestId: number
      hasMore: boolean
    }>(`/api/events?since=${String(since)}&limit=${String(limit)}`)
    return data
  },

  async recent(limit = 50): Promise<SystemEvent[]> {
    const { data } = await http.get<{ ok: boolean; events: SystemEvent[] }>(`/api/events/recent?limit=${String(limit)}`)
    return data.events
  }
}

export const tokenApi = {
  async list(): Promise<{ tokens: ApiToken[]; limit: number }> {
    const { data } = await http.get<{ ok: boolean; tokens: ApiToken[]; limit: number }>('/api/tokens')
    return { tokens: data.tokens, limit: data.limit }
  },

  /** Returns the plaintext once. It cannot be retrieved again. */
  async create(name: string): Promise<{ token: string; record: ApiToken }> {
    const { data } = await http.post<{ ok: boolean; token: string; record: ApiToken }>('/api/tokens', { name })
    return { token: data.token, record: data.record }
  },

  async remove(id: number): Promise<void> {
    await http.delete(`/api/tokens/${String(id)}`)
  }
}

export const systemApi = {
  async health(): Promise<HealthInfo> {
    const { data } = await http.get<HealthInfo>('/api/health')
    return data
  }
}

/* ------------------------------------------------------------------ *
 * The bind flow — the one deliberately platform-shaped corner
 * ------------------------------------------------------------------ */

/**
 * How a Platform's credential is obtained, and which call stores it.
 *
 * A handshake is not derivable from anything the server publishes, because the
 * catalogue describes capabilities and a bind method is about authentication:
 *
 *  - **Scanning is the primary path on both Platforms.** The server hands back a
 *    URL that a person scans, keeps the cookie jar the scan creates, and the client
 *    polls one `key` until a terminal state — three calls, identical on both sides,
 *    which is why `qrBindApi` is one function pair keyed by this table rather than
 *    one per Platform.
 *  - **A pasted credential is the backup**, and only where the server offers one:
 *    a composite token plus the device id the danmaku socket needs
 *    (`server/src/platform/douyu/index.ts` owns that blob's shape). A Platform with
 *    no paste route leaves `credentialPath` empty and the accounts view offers only
 *    the scan.
 *
 * **This table is the only place in `web/src` that names a Platform**, and every
 * screen asks it instead of testing a key, so a Platform added later changes one
 * row here rather than a view. `none` means this build has no bind entry point at
 * all for that Platform, and the accounts view says so instead of offering a button
 * that cannot work.
 */
export type BindMethod = 'qrcode' | 'credential' | 'none'

interface BindSpec {
  /** The path a person is expected to use. */
  readonly method: BindMethod
  /** Where the primary bind call goes. Empty when `method` is `none`. */
  readonly path: string
  /** The backup paste entry point, or empty when the Platform has none. */
  readonly credentialPath: string
}

const BILI_QR_BASE = '/api/bili/accounts/qrcode'

const BIND_SPECS: Readonly<Record<string, BindSpec>> = {
  bilibili: { method: 'qrcode', path: BILI_QR_BASE, credentialPath: '' },
  douyu: {
    method: 'qrcode',
    path: '/api/douyu/accounts/qrcode',
    credentialPath: '/api/douyu/accounts'
  }
}

export function bindSpecOf(platformKey: string): BindSpec {
  return BIND_SPECS[platformKey] ?? { method: 'none', path: '', credentialPath: '' }
}

/**
 * The scan handshake.
 *
 * One flow, keyed by whatever Platform the bind table says binds by scanning: two
 * calls sharing one `key` — request a code, render the URL as a QR image, then poll
 * until a terminal state. The path comes from the bind table rather than from this
 * function, so a second Platform whose main path is a scan goes through exactly
 * these three steps instead of needing a second copy of them.
 *
 * The returned account is deliberately not modelled: the accounts list is re-read
 * after a successful bind, and that list is the same call every Platform uses, so
 * the bind response's shape never has to be duplicated here.
 */
export const qrBindApi = {
  async start(platformKey: string): Promise<{ url: string; key: string }> {
    const spec = bindSpecOf(platformKey)
    if (spec.method !== 'qrcode') throw new Error('该平台不支持扫码绑定')

    const { data } = await http.post<{ ok: boolean; url: string; key: string }>(spec.path)
    return { url: data.url, key: data.key }
  },

  /** Polls a binding; `state` is `pending | scanned | success | expired`. */
  async poll(platformKey: string, key: string): Promise<{ state: string; message: string }> {
    const spec = bindSpecOf(platformKey)
    if (spec.method !== 'qrcode') throw new Error('该平台不支持扫码绑定')

    const { data } = await http.get<{ ok: boolean; state: string; message?: string }>(
      `${spec.path}/${encodeURIComponent(key)}`
    )
    return { state: data.state, message: data.message ?? '' }
  }
}

/**
 * A pasted credential: the composite token, the device id, and an optional web
 * session cookie header. Field names follow the credential blob the adapter
 * parses, because the blob is the server's to define and the form is only a way
 * to type it in.
 */
export interface PastedCredential {
  readonly token: string
  readonly did: string
  readonly webCookies?: string
}

export const credentialBindApi = {
  /**
   * Stores a pasted credential as a bound account.
   *
   * Deliberately returns nothing: the accounts list is re-read afterwards, and
   * that list is the same call every Platform uses, so nothing here depends on a
   * response shape the paste route is free to choose.
   *
   * A 404 or 405 here is not a failure of the credential: it means the server
   * build in front of the form does not serve this route yet, and the caller says
   * exactly that rather than reporting a bad token. Nothing is invented to fill
   * the gap — the route's absence is surfaced.
   */
  async bind(platformKey: string, credential: PastedCredential): Promise<void> {
    const path = bindSpecOf(platformKey).credentialPath
    if (path === '') throw new Error('该平台没有粘贴凭据的绑定入口')

    await http.post(path, credential)
  },

  /** The route a credential bind would go to, for a message that names it. */
  pathOf(platformKey: string): string {
    return bindSpecOf(platformKey).credentialPath
  }
}
