import { TASK_STATUS_LABEL, type TaskStatus } from '../types/api.js'

/**
 * What a create-or-get left behind, in the words both screens that call it use.
 *
 * **`POST /api/tasks` is create-or-get on (Platform, target, action) for a reconcile action**, and
 * `findReconcileTask` deliberately keeps a `paused` row (`server/src/repo/tasks.ts` says why: excluding
 * it would make the create path write a *second* row for the same key, and two rows would run one chore
 * twice). So the row the route answers with may be one it just wrote and may be one that already
 * existed, and it may be a row nothing will run: `listSchedulableTasks` takes only
 * `waiting`/`offline`/`running`, which leaves `paused` out.
 *
 * That is what makes 「已有一个任务**会运行**「X」」 and 「任务已创建」 the same defect, in two files: both
 * claimed a run over a row the sweep never takes. The settings panel's heading was narrowed to
 * 「指名这个动作的任务：」 for exactly this row; these two toasts were the copies that stayed, and they are
 * one sentence again rather than two.
 *
 * **The sentence names the row the route answered with and its own status, and never which branch ran.**
 * Neither branch is separable from the payload: `routes/tasks.ts` answers `{ok, task}` for the create and
 * for the existing row alike, so 「未新建」 would be a guess over the created case and 「已创建」 one over
 * the existing case. What the payload does carry is the row's status, which is the fact a person needs —
 * and for `paused` it carries the other half too: nothing runs it until somebody presses 恢复 on the
 * tasks screen, which is where that button is (`TasksView.vue`).
 */
export function namingNote(label: string, status: TaskStatus): string {
  const named = `现在有一条任务指名「${label}」，任务状态：${TASK_STATUS_LABEL[status]}。`
  return status === 'paused' ? `${named}要它跑，先在任务列表里按「恢复」。` : named
}
