<script setup lang="ts">
import { NAlert, NButton, NCheckbox, NCheckboxGroup, NFormItem, NInput, NInputNumber } from 'naive-ui'
import { computed, ref, watch } from 'vue'

import { describeError } from '../api/client.js'
import { actionSettingApi } from '../api/endpoints.js'
import { usePlatformStore } from '../stores/platform.js'
import {
  type ActionChoice,
  type ActionChoiceItem,
  type ActionDescriptor,
  type ActionOptionField,
  flattenOptions
} from '../types/api.js'

/**
 * One action's parameters, built out of the action's own field list.
 *
 * **Where this form's knowledge comes from**: `ActionDescriptor.optionFields`, which the Platform
 * declares beside the action itself. Nothing here names a Platform, a field name or a control — a
 * text field is a `NInput`, a number field is a `NInputNumber`, and a `choice` field is a checkbox
 * list whose options are read live from the source the field names. That is the same indirection the
 * create form already relies on, applied to `options`.
 *
 * **There is no free-form JSON box, and its absence is deliberate.** A field whose value a person
 * cannot type — a document, a nested map — is not a field this component draws at all, because a
 * textarea full of braces would ask a person to write the adapter's own shape by hand and would fail
 * silently when they got it wrong. The kind union has no member for it: see `ActionOptionKind`.
 *
 * **Nothing here is the safety boundary, and the form says so.** An action reads its own options and
 * refuses whatever its own rule does not allow, so a value this form cannot express makes an action
 * do *less*; a value it can express is a convenience over that rule and never a widening of it.
 *
 * **A list decides what may be sent, and the switch decides whether anything is.** An option field of
 * kind `choice` is read out of a live source and stored as the ids a person ticked — that and nothing
 * more: the ticked ids are the set the action *may* act on. Whether it acts at all is the action's own
 * switch (`A costly action asks first` in `ActionSettingsPanel`, and the adapter skips a switched-off
 * action), which is why the note drawn beside a list says exactly that and promises nothing else.
 */
const props = defineProps<{
  /** The action's own Platform. Used for the write and for the choice reads, never interpreted. */
  readonly platformKey: string
  readonly descriptor: ActionDescriptor
  /** The account whose live data a choice-backed field reads. Null when none is bound, *or* when the
   *  account list could not be read — which of the two is what `accountsLoaded` answers. */
  readonly accountId: number | null
  /**
   * Whether the account list actually arrived.
   *
   * `accountId: null` is two different facts, and only one of them supports a sentence about absence:
   * the list landed and this Platform has no account bound, or the list did not land and whether one is
   * bound is unknown. Set on a successful read alone, exactly like the flag of the same name in
   * `ActionSettingsPanel.vue` — whose create guard asks it before it makes the claim — and
   * `TaskCreateView.vue`'s 「账号列表没读到…」.
   */
  readonly accountsLoaded: boolean
  /** What is stored today, so the form opens on the current value rather than on empty controls. */
  readonly storedOptions: unknown
}>()

const emit = defineEmits<{ readonly saved: [] }>()

const catalog = usePlatformStore()

const error = ref('')
const saving = ref(false)

/**
 * The typed values, keyed by field name.
 *
 * Seeded once from `storedOptions` and then owned by the controls. Seeding is **copied** rather than
 * referenced — `flattenOptions` returns a fresh object — so nothing a person types can reach the
 * store's value through this map, and a cancelled edit leaves nothing behind.
 */
const values = ref<Record<string, string | number | null | string[]>>(seed(props.storedOptions))

/** One field's choices, keyed by field name. Absent means "not read yet". */
const choices = ref<Record<string, ActionChoice>>({})

const pendingReads = new Set<string>()

function seed(options: unknown): Record<string, string | number | null | string[]> {
  const stored = flattenOptions(options)
  const seeded: Record<string, string | number | null | string[]> = {}
  for (const field of props.descriptor.optionFields ?? []) {
    seeded[field.name] = field.kind === 'choice' ? stringListOf(stored[field.name]) : scalarOf(stored[field.name])
  }
  return seeded
}

/** A stored value as a choice field holds it: a list of strings, however it was written. */
function stringListOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const entries: readonly unknown[] = value
  return entries.filter((entry): entry is string => typeof entry === 'string')
}

/** A stored value as a text or number field holds it. Anything else reads as untouched. */
function scalarOf(value: unknown): string | number | null {
  return typeof value === 'string' || typeof value === 'number' ? value : null
}

const fields = computed<readonly ActionOptionField[]>(() => props.descriptor.optionFields ?? [])

/**
 * Whether this action declares a list at all.
 *
 * The note below is about what a list does and what it does not, so it is drawn only where a list
 * is. An action whose only option is a number — 「钓几次」 — has no list for the sentence to be
 * about, and drawing it there is how one Platform's private fact ended up on another action's form.
 */
const hasChoiceField = computed<boolean>(() => fields.value.some(field => field.kind === 'choice'))

/**
 * Reads every choice-backed field once.
 *
 * A form opened with no account bound still renders — and each choice field says why it has no list
 * rather than drawing an empty one, which is the reading this whole path exists to avoid: an empty
 * checkbox list and a failed read look identical on screen and mean opposite things.
 *
 * **`accountId: null` is two facts, and the sentence divides them.** The panel hands one value for
 * "this Platform has no account bound" and for "the account list did not arrive", and 「还没有绑定账号」 is
 * only supported by the first: the other one is this form asserting from a read that never answered, and
 * it tells a person who *does* have an account bound that they have none. So the flag decides which
 * sentence is drawn, and the second one says what actually happened — the same pairing as the panel's
 * own create guard and `TaskCreateView.vue`'s account notice.
 */
async function loadChoices(): Promise<void> {
  for (const field of fields.value) {
    if (field.kind !== 'choice' || field.source === undefined) continue
    if (field.name in choices.value || pendingReads.has(field.name)) continue

    if (props.accountId === null) {
      choices.value[field.name] = {
        kind: 'unavailable',
        reason: props.accountsLoaded
          ? '这个平台还没有绑定账号，读不到可选项。'
          : '账号列表这次没读到，所以不知道这个平台有没有绑定账号，可选项也就读不到。'
      }
      continue
    }

    pendingReads.add(field.name)
    try {
      choices.value[field.name] = await actionSettingApi.options(
        props.platformKey,
        props.descriptor.key,
        props.accountId,
        field.name
      )
    } catch (cause: unknown) {
      // A refused read is the same reading as an unavailable source: a sentence, never a list.
      choices.value[field.name] = { kind: 'unavailable', reason: describeError(cause) }
    } finally {
      pendingReads.delete(field.name)
    }
  }
}

watch(
  () => [props.platformKey, props.descriptor.key, props.storedOptions] as const,
  () => {
    values.value = seed(props.storedOptions)
    choices.value = {}
    void loadChoices()
  },
  { immediate: true }
)

function choiceOf(field: ActionOptionField): ActionChoice | null {
  return choices.value[field.name] ?? null
}

function itemsOf(field: ActionOptionField): readonly ActionChoiceItem[] {
  const choice = choiceOf(field)
  return choice?.kind === 'ok' ? choice.items : []
}

/**
 * What to say where a choice field has no list, in the words of the answer that produced it.
 *
 * **Three states, and only the first one is "loading".** `null` is a read still in flight;
 * `unavailable` carries the source's own sentence about why it could not answer; and `ok` with no
 * items is a *successful* read of a source that holds nothing. Drawing that last one as 「正在读取可选项…」
 * left a person waiting for a list that had already arrived — and it collapsed exactly the distinction
 * the route's `ChoiceView` union was built to carry: an account with nothing in it and a read that
 * failed are different sentences, and a form that gives them one rendering is telling somebody their
 * account is empty when the truth is that the session expired (or the reverse).
 */
function missingReason(field: ActionOptionField): string {
  const choice = choiceOf(field)
  if (choice === null) return '正在读取可选项…'
  if (choice.kind === 'unavailable') return choice.reason
  return '这个来源这次读到了，但里面一个可选项都没有。'
}

/**
 * One item's line: the name, how many the account holds, and the Platform's own marking.
 *
 * `costsSomething === true` is the only marking printed, and 「平台标了付费道具」 is the whole of what
 * is claimed. A `false` prints nothing rather than 「免费」: the Platform's own flags on this payload
 * do not separate free from paid — which is exactly why a person has to choose this list by hand —
 * so the form must not turn "no marking" into a promise about the price.
 */
function itemLabel(item: ActionChoiceItem): string {
  const parts: string[] = []
  if (item.count !== null && item.count > 0) parts.push(`持有 ${String(item.count)}`)
  if (item.costsSomething === true) parts.push('平台标了付费道具')
  return parts.length === 0 ? item.label : `${item.label}（${parts.join('、')}）`
}

function checkedOf(field: ActionOptionField): string[] {
  const value = values.value[field.name]
  return Array.isArray(value) ? value : []
}

function setChecked(field: ActionOptionField, next: string[]): void {
  values.value[field.name] = next
}

/**
 * A checkbox group's answer, narrowed to what this form stores.
 *
 * naive-ui types a group's value as `(string | number)[]` because a checkbox may be keyed either
 * way; every item this form draws is keyed by the source's own `value`, which is a string. Narrowing
 * at the edge is what keeps the stored value a list of ids rather than a list of whatever the widget
 * happened to hand over.
 */
function onlyStrings(next: readonly (string | number)[]): string[] {
  return next.filter((entry): entry is string => typeof entry === 'string')
}

function setNumber(field: ActionOptionField, next: number | null): void {
  values.value[field.name] = next
}

function setText(field: ActionOptionField, next: string): void {
  values.value[field.name] = next
}

function numberOf(field: ActionOptionField): number | null {
  const value = values.value[field.name]
  return typeof value === 'number' ? value : null
}

function textValueOf(field: ActionOptionField): string {
  const value = values.value[field.name]
  return typeof value === 'string' ? value : ''
}

/**
 * Writes the whole value, merged over what is stored.
 *
 * `options` is one column and the route replaces it, so a field this build cannot render would be
 * deleted by a save it took no part in — the merge below is what keeps it. An empty tick list is
 * stored as an empty list rather than omitted: 「一件都不许送」 is a real answer, and the action reads
 * an absent list and an empty one the same way, so a person who cleared the list means exactly what
 * the cleared list says.
 *
 * **The write goes through the store, not straight at the API.** The store caches the row the server
 * answers with, and this form re-seeds from that cache every time it is opened — it is mounted inside
 * a `v-if`, so closing it destroys the instance. A save that wrote past the store left the server
 * holding the new value and the next open showing the old one, which is the one thing a form seeded
 * from "what is stored today" is not allowed to do. The switch's own value is not this form's to
 * send: `setOptions` reads it from the store, so a parameters write cannot become a flip.
 */
async function save(): Promise<void> {
  const merged = flattenOptions(props.storedOptions)
  for (const field of fields.value) {
    const value = values.value[field.name]
    if (field.kind === 'choice') merged[field.name] = Array.isArray(value) ? value : []
    else merged[field.name] = value === null ? undefined : value
  }

  saving.value = true
  error.value = ''
  try {
    await catalog.setOptions(props.platformKey, props.descriptor.key, merged)
    emit('saved')
  } catch (cause: unknown) {
    error.value = describeError(cause)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="param-form">
    <NAlert v-if="error !== ''" type="error">{{ error }}</NAlert>

    <!--
      One field per wrapper, and the wrapper's key is the field's own name.

      **Not an `NSpace`.** `NSpace` wraps every slot child in a `<div key={1}>`
      (naive-ui `es/space/src/Space.mjs`), so its keyed fragment carries duplicate keys and Vue's
      keyed diff reuses the wrong nodes when the set of children changes — the trap
      `web/tests/nspace-fragment.test.ts` pins on the create form, where it multiplied 「执行间隔」 and
      left 「加盐」 on screen for an action that has no such concept. Here the child set genuinely
      differs per action, so the list is a plain element with one key per field name, which is the one
      key that cannot collide.
    -->
    <div v-for="field in fields" :key="`field-${field.name}`" class="field">
      <NFormItem :label="field.label">
        <div v-if="field.kind === 'choice'" class="choice">
          <NCheckboxGroup
            v-if="itemsOf(field).length > 0"
            :value="checkedOf(field)"
            @update:value="(next: (string | number)[]) => setChecked(field, onlyStrings(next))"
          >
            <div class="items">
              <NCheckbox v-for="item in itemsOf(field)" :key="`item-${item.value}`" :value="item.value" :label="itemLabel(item)" />
            </div>
          </NCheckboxGroup>

          <!--
            No list, and the three reasons are told apart rather than all drawn as a bare empty
            control: a read in flight, a read that failed, and a read that succeeded on an empty
            source. `missingReason` holds the sentences; only a failure is coloured as one.
          -->
          <div v-else :class="choiceOf(field)?.kind === 'ok' ? 'note-empty' : 'missing'">
            {{ missingReason(field) }}
          </div>
        </div>

        <NInputNumber
          v-else-if="field.kind === 'number'"
          :value="numberOf(field)"
          style="width: 200px"
          @update:value="(next: number | null) => setNumber(field, next)"
        />

        <NInput
          v-else
          :value="textValueOf(field)"
          style="width: 320px"
          @update:value="(next: string) => setText(field, next)"
        />
      </NFormItem>

      <div v-if="field.help !== ''" class="hint">{{ field.help }}</div>
    </div>

    <!--
      What a list does, drawn only where a list is (`hasChoiceField`).

      This note used to say the opposite of the truth — that the repository had never captured a gift
      request and that ticking the list therefore sent nothing — while the adapter this same field
      feeds had a captured request in `server/tests/captured/` and posted it for real. What a list
      can honestly promise is what the code reads it as: the ids ticked are the items the action
      **may** act on. Whether it acts is the switch beside it, which is a different control with a
      different answer.
    -->
    <NAlert v-if="hasChoiceField" type="info" :bordered="false">
      清单决定哪些可以送；动作开关决定到底送不送。开关关着的时候，这份清单不会让任何一件东西出去。
    </NAlert>

    <div class="actions">
      <NButton size="small" type="primary" :loading="saving" @click="() => void save()">保存参数</NButton>
    </div>

    <div class="hint boundary">
      这些参数只是让你把值填进去的入口，管住这个动作的是它自己：它读这份值，并且拒绝它不认的东西。
      所以在这里填什么都不可能让动作做出代码本来不允许的事。
    </div>
  </div>
</template>

<style scoped>
.param-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.field {
  display: flex;
  flex-direction: column;
}

.choice {
  display: flex;
  flex-direction: column;
}

.items {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.missing {
  color: #d03050;
  font-size: 13px;
}

/* A read that succeeded on an empty source: an answer, not a failure, so it is not coloured as one. */
.note-empty {
  color: #888;
  font-size: 13px;
}

.hint {
  color: #888;
  font-size: 13px;
}

.actions {
  display: flex;
  gap: 8px;
}

.boundary {
  margin-top: 4px;
}
</style>
