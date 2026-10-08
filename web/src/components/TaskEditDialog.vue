<script setup lang="ts">
import {
  NAlert,
  NButton,
  NDatePicker,
  NForm,
  NFormItem,
  NInputNumber,
  NModal,
  NSpace,
  NSwitch,
  useMessage
} from 'naive-ui'
import { computed, ref, watch } from 'vue'

import { describeError } from '../api/client.js'
import { intervalFloorMessage, intervalFloorOf, taskApi } from '../api/endpoints.js'
import { usePlatformStore } from '../stores/platform.js'
import { TaskAction, type TaskEditPatch, type TaskWithProgress } from '../types/api.js'

/**
 * Edit form for a paused task.
 *
 * Only the scheduling fields are editable — the target, account, and library are
 * fixed, because changing any of them mid-run would make the recorded progress
 * meaningless (the cursor indexes into a specific library).
 *
 * Edits never touch progress, so the change affects what gets sent next rather
 * than what was already sent. The server enforces the paused-only rule; this
 * component only hides the form when it would be rejected anyway.
 *
 * Which switches appear comes from the task's Action, not from its Platform: 加盐
 * rewrites each Bullet and 等待开播 gates on a live room, so an account-scoped
 * Reconcile task is shown neither. When the catalogue no longer has the action —
 * a task written by another build — both are shown, because hiding a field that
 * might still apply is worse than offering one that does not.
 */
const props = defineProps<{
  task: TaskWithProgress
  show: boolean
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  updated: [task: TaskWithProgress]
}>()

const message = useMessage()
const catalog = usePlatformStore()

const window = ref<[number, number]>([props.task.startTime, props.task.endTime])
const interval = ref(props.task.interval)
const requireOnline = ref(props.task.requireOnline)
const saltEnabled = ref(props.task.saltEnabled)

const saving = ref(false)
const error = ref('')

const descriptor = () => catalog.descriptorOf(props.task.platform, props.task.actionKey)
const showsSalt = () => descriptor()?.action === TaskAction.Send || descriptor() === null
const showsTarget = () => descriptor()?.needsTarget === true || descriptor() === null

/**
 * The cadence floor, which the PATCH route enforces against the same descriptor.
 *
 * Falls back to the task's current interval when this build cannot name the action
 * (`descriptorOf` answers null for a key a newer adapter wrote): the value is then
 * already in the row, so it is a valid floor, and inventing a number here would be
 * the only alternative.
 */
const intervalFloor = computed(() => {
  const action = descriptor()
  return action === null ? props.task.interval : intervalFloorOf(action)
})

// Reset the form each time the dialog opens, otherwise a cancelled edit would
// linger and be applied on the next open.
watch(
  () => props.show,
  open => {
    if (!open) return
    window.value = [props.task.startTime, props.task.endTime]
    interval.value = props.task.interval
    requireOnline.value = props.task.requireOnline
    saltEnabled.value = props.task.saltEnabled
    error.value = ''
  }
)

async function save(): Promise<void> {
  if (window.value[1] <= window.value[0]) {
    error.value = '结束时间必须晚于开始时间'
    return
  }

  // The same number the route compares against, said in this form's own sentence rather than the
  // route's: refusing the value before the request is what keeps a person from meeting a 400, and a
  // copied sentence would be a second home for a rule that already has one.
  const action = descriptor()
  if (action !== null && interval.value < intervalFloorOf(action)) {
    error.value = intervalFloorMessage(action)
    return
  }

  saving.value = true
  error.value = ''

  // Only send what actually changed, so a stale field cannot overwrite a value
  // that changed elsewhere in the meantime.
  const patch: TaskEditPatch = {}
  const next: Record<string, unknown> = { ...patch }

  if (window.value[0] !== props.task.startTime) next['startTime'] = window.value[0]
  if (window.value[1] !== props.task.endTime) next['endTime'] = window.value[1]
  if (interval.value !== props.task.interval) next['interval'] = interval.value
  if (requireOnline.value !== props.task.requireOnline) next['requireOnline'] = requireOnline.value
  if (saltEnabled.value !== props.task.saltEnabled) next['saltEnabled'] = saltEnabled.value

  if (Object.keys(next).length === 0) {
    message.info('没有改动')
    saving.value = false
    emit('update:show', false)
    return
  }

  try {
    const updated = await taskApi.update(props.task.id, next as TaskEditPatch)
    emit('updated', updated)
    message.success('已保存，之后的发送按新设置执行')
    emit('update:show', false)
  } catch (cause: unknown) {
    error.value = describeError(cause)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="编辑任务"
    style="max-width: 520px"
    @update:show="value => emit('update:show', value)"
  >
    <NAlert v-if="error !== ''" type="error" class="mb">{{ error }}</NAlert>

    <NAlert type="info" :bordered="false" class="mb">
      {{
        props.task.action === TaskAction.Send
          ? '已发送的弹幕不受影响，改动只作用于之后的发送。'
          : '平台那边已经完成的动作不受影响，改动只作用于之后的执行。'
      }}
    </NAlert>

    <NForm label-placement="top">
      <NFormItem label="生效时间">
        <NDatePicker v-model:value="window" type="datetimerange" clearable style="width: 100%" />
      </NFormItem>

      <NFormItem label="执行间隔（秒）">
        <NSpace align="center">
          <NInputNumber v-model:value="interval" :min="intervalFloor" :max="86400" style="width: 180px" />
          <span class="hint">这个动作最快 {{ intervalFloor }} 秒一次</span>
        </NSpace>
      </NFormItem>

      <NFormItem v-if="showsTarget()" label="等待开播">
        <NSwitch v-model:value="requireOnline">
          <template #checked>开播后才执行</template>
          <template #unchecked>一直执行</template>
        </NSwitch>
      </NFormItem>

      <NFormItem v-if="showsSalt()" label="加盐">
        <NSwitch v-model:value="saltEnabled">
          <template #checked>随机插入标点</template>
          <template #unchecked>原样发送</template>
        </NSwitch>
      </NFormItem>
    </NForm>

    <template #footer>
      <NSpace justify="end">
        <NButton @click="emit('update:show', false)">取消</NButton>
        <NButton type="primary" :loading="saving" @click="save">保存</NButton>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped>
.mb {
  margin-bottom: 16px;
}

.hint {
  color: #888;
  font-size: 13px;
}
</style>
