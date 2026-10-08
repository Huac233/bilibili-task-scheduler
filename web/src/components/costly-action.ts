import type { DialogApi } from 'naive-ui'

import type { ActionDescriptor } from '../types/api.js'

/**
 * Switches one action on or off, asking first when turning it on spends the account's own assets.
 *
 * **The promise this keeps is an interface promise, and it is only true while every path keeps it.**
 * `ActionSettingsPanel` says of itself that a costly action asks first; a switch can be turned on
 * from two places — that panel and the create form's 「开启这个动作」 button — and the second one used
 * to write the switch straight through, so the same click that asked on one screen spent silently on
 * the other. One function rather than two dialogs: a third entry point inherits the question instead
 * of repeating the omission, and the wording of the cost cannot drift between them.
 *
 * **Only turning one on asks.** Turning a costly action off is not the dangerous direction — the
 * entry fee is already gone — so it writes straight through, exactly as the panel always did.
 *
 * The spend is not undone by switching the action back off, which is why the question comes before
 * the write rather than as a warning after it.
 */
export function toggleActionSwitch(
  dialog: DialogApi,
  descriptor: ActionDescriptor,
  enabled: boolean,
  apply: (enabled: boolean) => void
): void {
  if (!enabled || !descriptor.costly) {
    apply(enabled)
    return
  }

  dialog.warning({
    title: `开启「${descriptor.label}」？`,
    content: '这个动作会花掉账号里的东西，开一次就扣一次，关掉也不会退回。确认要开吗？',
    positiveText: '确认开启',
    negativeText: '先不开',
    onPositiveClick: () => {
      apply(true)
    }
  })
}
