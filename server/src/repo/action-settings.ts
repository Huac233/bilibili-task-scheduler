import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'

import { asBoolean, asNumber, asString } from '../db/values.js'

/**
 * The action switchboard.
 *
 * One row per (user, Platform, action). **Absence means off**, and that is the
 * point: a new action ships dark, and an action that costs the account something
 * — Douyu's 打卡分鱼丸 spends 200 鱼丸 to enter — can only ever run because a
 * person turned it on.
 *
 * The set of actions that exists is not stored here; it comes from the Platform
 * adapter. This table records only what a person decided about them.
 */

export interface ActionSetting {
  readonly id: number
  readonly userId: number
  readonly platform: string
  readonly actionKey: string
  readonly enabled: boolean
  /** Platform-shaped knobs, as raw JSON. */
  readonly options: string
  readonly createdAt: number
  readonly updatedAt: number
}

function toSetting(row: Record<string, SQLOutputValue>): ActionSetting {
  return {
    id: asNumber(row['id']),
    userId: asNumber(row['user_id']),
    platform: asString(row['platform']),
    actionKey: asString(row['action_key']),
    enabled: asBoolean(row['enabled']),
    options: asString(row['options'], '{}'),
    createdAt: asNumber(row['created_at']),
    updatedAt: asNumber(row['updated_at'])
  }
}

export function listActionSettings(db: DatabaseSync, userId: number): ActionSetting[] {
  const rows = db
    .prepare('SELECT * FROM action_settings WHERE user_id = ? ORDER BY platform ASC, action_key ASC')
    .all(userId)
  return rows.map(toSetting)
}

export function getActionSetting(
  db: DatabaseSync,
  userId: number,
  platform: string,
  actionKey: string
): ActionSetting | null {
  const row = db
    .prepare('SELECT * FROM action_settings WHERE user_id = ? AND platform = ? AND action_key = ?')
    .get(userId, platform, actionKey)
  return row === undefined ? null : toSetting(row)
}

/**
 * Declared / cleared in one call, because that is how the UI treats it — a switch,
 * not a form. The scheduler asks whether **one** action is on, so an absent row and
 * `enabled = 0` read the same.
 */
export function setActionEnabled(
  db: DatabaseSync,
  userId: number,
  platform: string,
  actionKey: string,
  enabled: boolean,
  options?: string,
  now = Date.now()
): ActionSetting {
  db.prepare(
    `INSERT INTO action_settings (user_id, platform, action_key, enabled, options, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, platform, action_key) DO UPDATE SET
       enabled = excluded.enabled,
       options = CASE WHEN ? IS NULL THEN action_settings.options ELSE excluded.options END,
       updated_at = excluded.updated_at`
  ).run(userId, platform, actionKey, enabled ? 1 : 0, options ?? '{}', now, now, options ?? null)

  const setting = getActionSetting(db, userId, platform, actionKey)
  if (setting === null) throw new Error('action setting vanished immediately after upsert')
  return setting
}

/**
 * One action's stored options, parsed, keyed by action key.
 *
 * **This is the seam's read side of `options`, and until it existed that column had none.** The route
 * stored whatever a person set and the UI echoed it back, but no run ever saw it — a knob that can be
 * turned and is silently ignored, which is the exact failure the switchboard exists to prevent.
 * `ReconcileContext.options` is where the value ends up and this is where it comes from, so there is one
 * store, one reader and no second interpretation of what an option means: the meaning belongs to the
 * adapter.
 *
 * **Every value here is an object, and that is this function's policy rather than the store's.**
 * `ReconcileContext.options` promises an adapter a map of objects, so a stored value that is not one —
 * `null`, an array, a bare string, all of which the route accepts because it deliberately validates
 * nothing it cannot own — becomes `{}` on its way to an action. The route renders what was stored instead,
 * unaltered, because its job is to show a person their own value. `parseStoredOptions` is the one parse
 * both readers use; these two policies sit on top of it and are stated where they apply.
 *
 * Reuses `listActionSettings` rather than a second query: what has to stay in step is the row shape
 * (`toSetting`), not the SQL, and a person has few enough rows that filtering platforms in memory costs
 * nothing.
 */
export function actionOptions(db: DatabaseSync, userId: number, platform: string): Readonly<Record<string, unknown>> {
  const options: Record<string, unknown> = {}
  for (const setting of listActionSettings(db, userId)) {
    if (setting.platform !== platform) continue
    const parsed = parseStoredOptions(setting.options)
    options[setting.actionKey] = isOptionsObject(parsed) ? parsed : {}
  }
  return options
}

/**
 * One stored options blob, parsed: `{}` for anything unreadable.
 *
 * **The store's own rule, in one place, because two readers need it and neither may own it.** The route
 * renders a setting's options back to the client; `actionOptions` hands them to an action. A private copy
 * on either side would be one fact with two homes, and the day they disagreed a value would be visible in
 * the interface and invisible to the run that was supposed to use it.
 *
 * **What it deliberately does not decide is whether the result is an object.** A person may store `null`,
 * an array or a number — the route accepts any JSON at all, because the seam describes no options for it
 * to validate — and the two readers want different things from that: the route shows it back exactly as
 * stored, while `actionOptions` turns it into `{}` on the way to an action. Folding those two policies
 * together here would silently change what a person sees for a value only they can explain.
 *
 * An absent row and an unreadable blob both read as no options, and neither throws: a parse failure
 * reported as text would only move the failure into the client, which renders a form from this value, and
 * a thrown error would fail a whole reconcile run over something the UI can rewrite.
 */
export function parseStoredOptions(raw: string | undefined): unknown {
  if (raw === undefined) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * A JSON object, as opposed to `null`, an array or a primitive.
 *
 * The seam's promise, checked rather than asserted: `ReconcileContext.options` is a map of objects, so the
 * one place that builds it out of stored values asks this. A predicate rather than an assertion at the call
 * site, so the parse's answer is *narrowed* by the guard instead of promised by a cast — the same reason
 * `protocol.ts` has one of these, and deliberately not shared with it: this one decides what an action's
 * options are, that one decides whether a Douyu envelope arrived, and neither answer should be able to
 * change the other's.
 */
function isOptionsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * **There is deliberately no "the keys this user has switched on, on this Platform" reader here.**
 *
 * One existed — `enabledActionKeys`, whose doc comment called it "the keys the scheduler is allowed to
 * run" — and it existed for the rule where a run carried *every* switched-on action matching its
 * Task's shape. A reconcile run now carries the single action its Task's own row names, so nothing
 * asks for that set: the runner asks `getActionSetting` about one row, and the switches route merges
 * `listActionSettings` over the catalogue. A whole-set reader that survived the rule would be the
 * deleted rule's shape kept alive, and the next person who wanted a list would rebuild the rule with
 * it.
 */
