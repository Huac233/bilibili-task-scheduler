<script setup lang="ts">
import { NAlert, NButton, NCheckbox, NCheckboxGroup, NFormItem, NInput, NInputNumber, NSelect } from 'naive-ui'
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
import { itemLabel, missingReason, noAccountReason } from './choice-notes.js'

/**
 * One action's parameters, built out of the action's own field list.
 *
 * **Where this form's knowledge comes from**: `ActionDescriptor.optionFields`, which the Platform
 * declares beside the action itself. Nothing here names a Platform, a field name or a control — a
 * text field is a `NInput`, a number field is a `NInputNumber`, a `choice` field is a checkbox
 * list whose options are read live from the source the field names, and a `pick_one` field is a
 * single-choice control over that same kind of read. That is the same indirection the
 * create form already relies on, applied to `options`.
 *
 * **The kind decides both the control and the shape written back, and that pairing is the point.** A
 * checkbox group writes what it draws — a list — and the two kinds hold a different number of values:
 * `choice` is the set a person ticks, `pick_one` is one of them. Declaring a "pick one" field `choice`
 * therefore drew the wrong control *and* stored a shape the action's own reader could not get a value out
 * of, which is two defects with one cause; a form that instead taught every reader to unwrap both shapes
 * would have left the third field free to repeat it.
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
 * The fields whose stored cell holds **more than one value** — the one state a single-choice control
 * cannot draw.
 *
 * Held rather than derived on demand because it is a fact about what was *stored* when the form opened,
 * and the controls below overwrite the seeded values as a person types: derived from `values` it would
 * silently become "not several" the moment anything else was read. `save` is its only other reader, and
 * what it decides there is whether that cell may be written at all.
 *
 * Declared above `values` because `seed` fills it, and `values` is seeded at declaration time — a Vue
 * `setup` body runs in source order, so a ref read by `seed` has to exist before the ref that calls it.
 */
const severalCells = ref<Set<string>>(new Set())

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
  const several = new Set<string>()
  for (const field of props.descriptor.optionFields ?? []) {
    const cell = stored[field.name]
    if (field.kind === 'pick_one') {
      seeded[field.name] = pickedOneOf(cell)
      if (Array.isArray(cell) && cell.length > 1) several.add(field.name)
      continue
    }
    seeded[field.name] = field.kind === 'choice' ? stringListOf(cell) : scalarOf(cell)
  }
  severalCells.value = several
  return seeded
}

/** A stored value as a choice field holds it: a list of strings, however it was written. */
function stringListOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const entries: readonly unknown[] = value
  return entries.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * A stored value as a pick-one field holds it: **the one value it means, however it was written**.
 *
 * Two shapes, and the second one is a repair rather than a contract. A checkbox group writes what it
 * draws, and this field was declared `choice` until it was declared `pick_one` — so the row already in the
 * owner's database holds a one-element list (`{"dumpRoomId":["12306"],…}`), and a control that read only a
 * bare value would show him an empty box over a room he had picked, which is the same defect arriving on
 * the form instead of in the action log. Anything else — nothing stored, an empty list, an empty string,
 * or a list of two or more — is nothing this control can show, and the two readings behind that blank are
 * told apart where they matter: `severalCells` for the save, and the action's own report for the run.
 *
 * **`server/src/platform/douyu/index.ts`'s `dumpRoomIn` tolerates the same one-element list**, and the
 * two implementations are deliberate: the packages share no code, and the rule is one row rather than one
 * function — the shape the old form wrote, read back by both halves that have to agree about it.
 */
function pickedOneOf(value: unknown): string | null {
  const entries: readonly unknown[] = Array.isArray(value) ? value : [value]
  if (entries.length !== 1) return null
  const [only] = entries
  if (typeof only === 'number') return String(only)
  return typeof only === 'string' && only !== '' ? only : null
}

/** A stored value as a text or number field holds it. Anything else reads as untouched. */
function scalarOf(value: unknown): string | number | null {
  return typeof value === 'string' || typeof value === 'number' ? value : null
}

const fields = computed<readonly ActionOptionField[]>(() => props.descriptor.optionFields ?? [])

/**
 * Whether this action declares a ticked list at all.
 *
 * The note below is about what a list does and what it does not, so it is drawn only where a list
 * is. An action whose only option is a number — 「钓几次」 — has no list for the sentence to be
 * about, and drawing it there is how one Platform's private fact ended up on another action's form.
 *
 * **A `pick_one` field is not that list, and the two are told apart by `kind` for exactly this reason.**
 * The note is about a *set* — 「这份清单决定这个动作可以动哪些」 — while a pick-one field names one destination,
 * which decides *where* an action goes rather than *which* things it may touch. The field's own `help`
 * says what its values mean, so an action declaring only a destination loses nothing by this gate.
 */
const hasChoiceField = computed<boolean>(() => fields.value.some(field => field.kind === 'choice'))

/**
 * Reads every source-backed field once.
 *
 * A form opened with no account bound still renders — and each such field says why it has no list
 * rather than drawing an empty one, which is the reading this whole path exists to avoid: an empty
 * checkbox list and a failed read look identical on screen and mean opposite things.
 *
 * **The gate is `source`, not `kind`.** Which control a field draws (and therefore how many values it
 * stores) is what `kind` decides, while *whether the options come from a live read at all* is what the
 * source says — so a gate naming one kind would leave a `pick_one` field drawn as a control no read ever
 * fills, which is what 「默认倾泻直播间」 met the moment it stopped being declared `choice`.
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
    if (field.source === undefined) continue
    if (field.name in choices.value || pendingReads.has(field.name)) continue

    if (props.accountId === null) {
      choices.value[field.name] = { kind: 'unavailable', reason: noAccountReason(props.accountsLoaded) }
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
 * Which class one field's note is drawn with — one per reading `missingReason` words.
 *
 * **Three readings, three classes, and only the refusal is a failure.** `choiceOf` answers `null` while the
 * read is in flight, so a two-way test on `kind` — `'ok'`, or everything else — drew the in-flight row as
 * `.missing`, `--row-danger`: 「正在读取可选项…」 in the failure's colour on the first frame of the form, over a
 * request with nothing wrong with it. The reading that arrived empty is not a failure either — it is the
 * *source's* answer — so it keeps the quiet class it already had, and the wait needs one of its own rather
 * than a reuse of that name: a wait and an empty answer are two different facts, and the class names are
 * how the two are told apart. Which colour each name resolves to is the stylesheet's business, and the
 * stylesheet's comment states the rule this function has to keep.
 */
function choiceNoteClass(field: ActionOptionField): string {
  const choice = choiceOf(field)
  if (choice === null) return 'note-pending'
  return choice.kind === 'ok' ? 'note-empty' : 'missing'
}

/**
 * A single-choice field's two readings, and what each is drawn from.
 *
 * `pickedOf` is what the control shows — the one stored value, or nothing — and `optionsOf` is the live
 * read in the shape `NSelect` wants, worded by the same `itemLabel` the checkbox group's rows use, so the
 * two controls cannot describe one item differently. `heldSeveral` is the third reading: the cell holds
 * more than the control can draw, which is a fact about the *cell* rather than about the control, so it is
 * drawn as a sentence beside the control instead.
 */
function pickedOf(field: ActionOptionField): string | null {
  const value = values.value[field.name]
  return typeof value === 'string' && value !== '' ? value : null
}

function setPicked(field: ActionOptionField, next: string | number | null): void {
  // The group's own narrowing, for the group's own reason: every row is keyed by the source's `value`,
  // which is a string, so nothing else may reach the stored cell.
  values.value[field.name] = typeof next === 'string' ? next : null
}

/**
 * The live read in the shape `NSelect` takes: one row per item, worded by the same `itemLabel` the
 * checkbox group's rows use, so the two controls cannot describe one item two ways.
 *
 * The array is mutable because the widget's own prop type is — `SelectMixedOption[]` — and the *fields* are
 * readonly, which is the half this form can make true: nothing here mutates a row, and the widget only
 * reads them.
 */
function selectOptionsOf(field: ActionOptionField): { readonly label: string; readonly value: string }[] {
  return itemsOf(field).map(item => ({ label: itemLabel(item), value: item.value }))
}

/** Whether the cell one field was seeded from holds more than its control can draw. */
function heldSeveral(field: ActionOptionField): boolean {
  return severalCells.value.has(field.name)
}

/**
 * One item's line, and what to say where a list has none — both from `./choice-notes.js`.
 *
 * They are imported rather than written here because the preferences page draws the same two
 * readings above the form, out of the same read: this module is where those sentences have their one
 * home, so the item beside a checkbox and the item in the displayed list cannot be worded apart.
 */
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
 * **A pick-one field writes one value, and its `undefined` is a deletion rather than an empty cell.**
 * That cell means a destination, so "no destination" is the absence of the key — the state the action
 * reads as 「还没有选好」. The one case this does not write is `heldSeveral`: a cell holding two values is
 * one this control cannot draw, and a save is not entitled to erase a setting it never showed. That is the
 * same promise as the paragraph above, one state further in — the difference being that a field this form
 * cannot *render* is skipped by the loop, while this one is declared and has to be written back on purpose.
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
    else if (field.kind === 'pick_one') {
      if (typeof value === 'string' && value !== '') merged[field.name] = value
      else if (!heldSeveral(field)) merged[field.name] = undefined
    } else merged[field.name] = value === null ? undefined : value
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
          <div v-else :class="choiceNoteClass(field)">
            {{ missingReason(choiceOf(field)) }}
          </div>
        </div>

        <div v-else-if="field.kind === 'pick_one'" class="choice">
          <!--
            **One of them, and not a set.** The field's meaning is "pick one", so the control offers one at
            a time; a checkbox group here would tell a person they may take several of a thing the action is
            aimed at once — and, because a control writes what it draws, it would store a list the action's
            own reader can get no value out of.

            `clearable` is the "choose none" answer, which is a real state: it stores no key at all, and the
            action reads that as 「还没有选好」. It is a select rather than a radio column because the read
            behind it is a person's **follow list**, which can be long, and `filterable` is what makes a long
            one searchable; the trigger shows the chosen room's own name, never the value it stores.
          -->
          <NSelect
            v-if="itemsOf(field).length > 0"
            :value="pickedOf(field)"
            :options="selectOptionsOf(field)"
            clearable
            filterable
            placeholder="从这份清单里挑一个"
            style="width: 320px"
            @update:value="(next: string | number | null) => setPicked(field, next)"
          />

          <!--
            No list, and the same three readings the checkbox group's fallback divides: a read in flight,
            a read that failed, and a read that answered nothing.
          -->
          <div v-else :class="choiceNoteClass(field)">
            {{ missingReason(choiceOf(field)) }}
          </div>

          <!--
            What the control cannot draw, said rather than left as a blank.

            A cell holding two rooms is the other shape the field's old declaration could write, and a
            single-choice control can only show one — so it shows none, and 「空着」 would be this form
            asserting something about a person's own setting that the cell's contents contradict. The
            sentence is read from `heldSeveral`, which is a fact about the stored cell, and it names the one
            move that clears the state: choosing a room from the list replaces it.
          -->
          <div v-if="heldSeveral(field)" class="note-several">
            这一格里存着不止一个直播间，而这里一次只能挑一个，所以它看起来是空的。从上面这份清单里挑一个，这一格就会被换成你挑的那一个。
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

      **The words are the list's, not one action's.** This note used to say 「清单决定哪些可以送；…这份清单不会
      让任何一件东西出去」, which was true while a gift allowlist was the only choice field in the build and
      became a different action's private fact the moment an action declared a list of *rooms* to pour into:
      「送」 and 「东西」 are about sending gifts, and this form draws every action's fields without knowing
      which action it is filling in. What is true of every list is what the code reads it as — the ticked
      values are what the action **may** act on, and whether it acts at all is the switch (`runner.ts` reads
      the switch before it dispatches either executor and answers a shut one with `switchOffReport`) — so the
      note says that, and the concrete meaning of *these* values stays where it belongs: the field's own
      `help`, written by the action that reads it.

      The other half of this note's history is below: it once claimed the repository had never captured a
      gift request, while the adapter this same field feeds had one in `server/tests/captured/` and posted
      it for real.
    -->
    <NAlert v-if="hasChoiceField" type="info" :bordered="false">
      这份清单决定这个动作可以动哪些；动作开关决定它到底动不动。开关关着的时候，这个动作什么都不会做。
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

/*
 * One source-backed field's block: the control, or the sentence that says why there is none, and — under a
 * single-choice control — the sentence about a cell it cannot draw. Both kinds share the name because the
 * layout is the same one; which of them a field is, is the field's own `kind`.
 */
.choice {
  display: flex;
  flex-direction: column;
}

.items {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/*
 * The four colours this form draws are the app palette's, read by name rather than written here:
 * `App.vue` publishes the seven roles from the live theme, and the form is mounted both inside the
 * panel — which has a palette to inherit from either way — and from `TaskDetailView.vue`. The greys
 * that were `#888` are a step darker now, which is what taking the role rather than a literal means:
 * the theme owns the quiet colour, and this form had one of its own for no reason.
 */
.missing {
  color: var(--row-danger);
  font-size: 13px;
}

/*
 * And the reading that has no answer yet is neither of those: the request is out, `missingReason(null)`
 * says so in the wait's own sentence, and it draws in the quiet colour the rest of this form's read-outs
 * use — the same colour the empty answer resolves to, since neither of them is a fault. It is a name of
 * its own rather than a reuse of `.note-empty` because a wait and an answer of nothing are two different
 * facts, and a test has to be able to tell the two apart by name.
 */
.note-pending {
  color: var(--row-quiet);
  font-size: 13px;
}

/* A read that succeeded on an empty source: an answer, not a failure, so it is not coloured as one. */
.note-empty {
  color: var(--row-quiet);
  font-size: 13px;
}

/*
 * And the fourth reading, which is about the *cell* rather than about the read: a single-choice field's
 * stored value holds more than its control can draw. Quiet like the two above it, because nothing has gone
 * wrong anywhere — and a name of its own, for those two names' own reason: three different facts drawn as
 * one class is how a test asserting 「this is the wait」 starts passing over an unshowable setting.
 */
.note-several {
  color: var(--row-quiet);
  font-size: 13px;
}

.hint {
  color: var(--row-quiet);
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
