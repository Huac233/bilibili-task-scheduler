import type { ActionChoice, ActionChoiceItem } from '../types/api.js'

/**
 * The sentences one read of a choice source is shown with, in their one home.
 *
 * **Why this is a module of its own.** A choice source has two readers on the same screen: the
 * parameter form, where its items become tickable controls, and the preferences page's own list of
 * what an account-level action read. The design's decision is that one read serves both purposes —
 * displayed to the person *and* the source of the parameter's values — and the moment there are two
 * readers, the sentences they print are one fact with two homes: an account with nothing in it would
 * be described one way beside the checkboxes and another way above them, and the day one of the two
 * was reworded the screen would say two different things about one read.
 *
 * **Three states, and only the first of them is "loading".** `null` is a read still in flight;
 * `unavailable` carries the source's own sentence about why it could not answer; and `ok` with no
 * items is a *successful* read of a source that holds nothing. Drawing that last one as 「正在读取
 * 可选项…」 left a person waiting for a list that had already arrived, and it collapsed exactly the
 * distinction `ChoiceView` in `server/src/routes/action-settings.ts` was built to carry: an account
 * with nothing in it and a read that failed are different sentences, and a form that gives them one
 * rendering is telling somebody their account is empty when the truth is that the session expired.
 */
export function missingReason(choice: ActionChoice | null): string {
  if (choice === null) return '正在读取可选项…'
  if (choice.kind === 'unavailable') return choice.reason
  return '这个来源这次读到了，但里面一个可选项都没有。'
}

/**
 * Why a source-backed field has no list when there is no account to read it for.
 *
 * `accountId: null` is two different facts, and only one of them supports a sentence about absence:
 * the account list landed and this Platform has no account bound, or the list did not land and
 * whether one is bound is unknown. Set on a successful read alone, the same pairing
 * `TaskCreateView.vue` words as 「账号列表没读到，所以这里既不能说你有账号、也不能说你没有」.
 */
export function noAccountReason(accountsLoaded: boolean): string {
  return accountsLoaded
    ? '这个平台还没有绑定账号，读不到可选项。'
    : '账号列表这次没读到，所以不知道这个平台有没有绑定账号，可选项也就读不到。'
}

/**
 * One item's line: the name, how many the account holds, and the Platform's own marking.
 *
 * `costsSomething === true` is the only marking printed, and 「平台标了付费道具」 is the whole of what
 * is claimed. A `false` prints nothing rather than 「免费」: the Platform's own flags on this payload
 * do not separate free from paid — which is exactly why a person has to choose this list by hand —
 * so the form must not turn "no marking" into a promise about the price.
 *
 * **`label` is also where a source puts a fact its own shape has no field for** — the medal read's
 * 「今日亲密度 0」 is the one this build has, because `count` promises a number the account holds and
 * the Platform makes no such claim about a medal. That is a fact about what a source may say, and it
 * is written down here because this function is the one place a reader sees the whole item.
 */
export function itemLabel(item: ActionChoiceItem): string {
  const parts: string[] = []
  if (item.count !== null && item.count > 0) parts.push(`持有 ${String(item.count)}`)
  if (item.costsSomething === true) parts.push('平台标了付费道具')
  return parts.length === 0 ? item.label : `${item.label}（${parts.join('、')}）`
}
