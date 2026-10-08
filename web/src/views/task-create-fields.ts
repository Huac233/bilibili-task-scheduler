import type { ActionDescriptor } from '../types/api.js'

/**
 * Which form fields an action asks for.
 *
 * The reported bug was a form that showed a field no branch had asked for, so the
 * question "which fields does this action have?" now has one answer, in one place,
 * as data — rather than being re-derived from `v-if` conditions scattered down a
 * 500-line template. The names below are the *invariant* the form is checked
 * against: switching action must leave the form showing exactly this set.
 *
 * Each field belongs to exactly one deciding property of the descriptor, because
 * that is what the report demands: `needsTarget` decides 目标 and 等待开播,
 * `needsLibrary` decides 文本库, the action family decides 加盐 — and nothing else
 * decides anything. 执行间隔 is unconditional: every task is a scheduling shell with
 * a cadence, so it is not in this list at all.
 */
export const FORM_FIELDS = {
  /** `needsTarget` — a Room to aim at. */
  target: '目标',
  /** `needsLibrary` — the Bullets to send. */
  library: '文本库',
  /** `needsTarget` — run only while that Room is live. */
  requireOnline: '等待开播',
  /** A `send` action only: 加盐 rewrites each Bullet before it goes out. */
  salt: '加盐'
} as const

export type FormField = (typeof FORM_FIELDS)[keyof typeof FORM_FIELDS]

/**
 * A stable DOM key per field, for the wrapper each one lives in.
 *
 * `NSpace` wraps every child in `<div key={1}>` (naive-ui `es/space/src/Space.mjs`),
 * so a slot of several children is a keyed fragment with duplicate keys; Vue then
 * reconciles the wrong nodes and fields multiply. Keying the wrapper — with
 * something that is a `string`, so a future Vue release cannot confuse it with
 * Vue's own numeric `v-if` branch keys — keeps that list stable across a change of
 * action, which is the whole fix.
 */
export const FIELD_KEY: Readonly<Record<FormField, string>> = {
  [FORM_FIELDS.target]: 'field-target',
  [FORM_FIELDS.library]: 'field-library',
  [FORM_FIELDS.requireOnline]: 'field-online',
  [FORM_FIELDS.salt]: 'field-salt'
}

/**
 * Stable DOM keys for the notices whose `v-if` changes the slot's child count.
 *
 * **The same trap as `FIELD_KEY`, in the same slot.** `NSpace` keys every child it wraps with the
 * literal `1`, so what has to stay stable is the *list of children*, not only which field each one
 * holds: a notice that is NSpace's own child adds and removes entries from that list when the action
 * changes, and Vue then reconciles the wrong nodes — which is how this form multiplied 「执行间隔」
 * and left 「加盐」 on screen for an action that has no such concept. Six notices here are drawn
 * conditionally, so each lives in a keyed wrapper with its own branch inside, exactly like the fields.
 */
export const NOTICE_KEY = {
  /** The chosen action's own label and description. */
  description: 'notice-description',
  /** The chosen action spends something the account owns. */
  costly: 'notice-costly',
  /** The chosen action's switch is off, so the server would refuse to create this Task. */
  switchOff: 'notice-switch-off',
  /** The window is longer than a month. */
  longTerm: 'notice-long-term',
  /** The typed cadence is below the action's own floor. */
  floor: 'notice-floor',
  /** The form moved the cadence to that floor. */
  correction: 'notice-correction'
} as const

/** The order the fields appear in, so a test can assert the whole visible set at once. */
const ORDER: readonly FormField[] = [
  FORM_FIELDS.target,
  FORM_FIELDS.library,
  FORM_FIELDS.requireOnline,
  FORM_FIELDS.salt
]

/**
 * The fields a descriptor asks for, in display order.
 *
 * A null descriptor — no action chosen yet — asks for nothing, which is the honest
 * answer: the form should show its platform choices and nothing else.
 */
export function fieldsFor(descriptor: ActionDescriptor | null): readonly FormField[] {
  if (descriptor === null) return []

  function asksFor(field: FormField): boolean {
    switch (field) {
      case FORM_FIELDS.target:
        return descriptor?.needsTarget === true
      case FORM_FIELDS.library:
        return descriptor?.needsLibrary === true
      case FORM_FIELDS.requireOnline:
        return descriptor?.needsTarget === true
      case FORM_FIELDS.salt:
        return descriptor?.action === 'send'
      // Unreachable: the four cases above exhaust `FormField`. The `return` is here
      // because a callback whose paths do not all return is a real defect elsewhere
      // (`useIterableCallbackReturn`), and the `satisfies never` is what makes a fifth
      // field — one added to `FORM_FIELDS` and `ORDER` but not here — a compile error
      // rather than a field that silently counts as "asked for".
      default:
        field satisfies never
        return false
    }
  }

  return ORDER.filter(asksFor)
}
