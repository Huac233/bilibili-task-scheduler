<script setup lang="ts">
import { NSpace, NTag } from 'naive-ui'

import { usePlatformStore } from '../stores/platform.js'
import {
  ACTION_ITEM_KIND_LABEL,
  type ActionItemKind,
  type ActionLog,
  describeOutcome,
  isUnsettledOutcome,
  itemNamesTheAction
} from '../types/api.js'

/**
 * One reconcile run's actions, with what each of them got done.
 *
 * **The facts lead.** A row is the action's name and then what happened today, in as few
 * words as the thing takes — 「客户端签到 连签 7 天」, 「鱼吧签到 · 主版块 等级分 +3」. The
 * record's own `detail` used to be *every* row's text, and it said the same thing three times
 * over: the action's name appeared both as the row's label and inside the sentence, the
 * sentence ended 「…，本日已完成」 under a heading that had already said so, and the tag beside
 * it said it once more. That sentence is now what it always was — an audit line — and it is the
 * debug section's text, beside `code` and `action_key`.
 *
 * **With one exception, and it is the row that has nothing else to say**: a record that named no
 * item at all draws its own sentence, because there is no fact beside it to lead with — see
 * `rowText`. Saying "the debug section alone" without that clause is what a reader would take as
 * a promise about every row, and this file contradicted itself there.
 *
 * Three rules hold throughout, and all three are the reason the markup is fussy about where
 * it reads its names from:
 *
 *  - **Nothing here is an identifier.** An action is named through the catalogue, an item by
 *    the name the Platform gave it, and a record that has no catalogue entry is described
 *    rather than shown as its key.
 *  - **A tag is a mark, not a habit.** Only the unsettled outcomes carry one; see
 *    `isUnsettledOutcome` for which those are and why the settled three do not need one. The word on it
 *    comes from `describeOutcome`, so a stored value outside the five is marked with the reading the rest
 *    of the system gives it instead of with a tag holding nothing — which is what a lookup keyed by the
 *    five alone left on a row written by a newer build.
 *  - **A record whose items are the action contributes its fact alone.** The item's label is
 *    the action's label, so printing both is the duplication this whole shape exists to
 *    remove — `itemNamesTheAction` is the test for it.
 *
 * One component for both sections on purpose: 「今天做了什么」 and 「那天做了什么」 are the
 * same question about different days, and two copies of this markup would only be able
 * to disagree about which of them hides what.
 */

const catalog = usePlatformStore()

const props = defineProps<{
  readonly platform: string
  readonly records: readonly ActionLog[]
}>()

/** The action's catalogue name; a key this build cannot name is described, never shown. */
function actionLabel(actionKey: string): string {
  return catalog.descriptorOf(props.platform, actionKey)?.label ?? '未知动作'
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN')
}

/**
 * Whether the record's facts belong on the action's own row, rather than under it.
 *
 * Two shapes put the record's whole story into one string, and both of them are the case
 * where there is nothing separate to list underneath: a record whose items are the action
 * itself, and a record that named no item at all.
 *
 * The second is not only a legacy shape. `blockedOutcome` in either adapter writes no item
 * for an action this build cannot run — an item's label may never be an identifier, and a key
 * with no catalogue entry cannot be labelled — so its own sentence is deliberately the whole
 * truth about it.
 */
function singleRow(record: ActionLog): boolean {
  return (
    record.items.length === 0 || record.items.every(item => itemNamesTheAction(item, actionLabel(record.actionKey)))
  )
}

/**
 * The text of a record that renders as one row.
 *
 * Its items' facts when it has items, and its own `detail` when it has none. That fallback is
 * why an old row still reads: `action_logs.items` was added by the purely additive column
 * migration in `server/src/db/index.ts` with `NOT NULL DEFAULT '[]'`, so a row written before
 * the column existed genuinely has nothing else to show, and dropping its sentence would
 * leave the row saying nothing at all.
 */
function rowText(record: ActionLog): string {
  return record.items.length === 0 ? record.detail : record.items.map(item => item.detail).join(' · ')
}

/**
 * The glyph for an item's kind.
 *
 * Inline rather than from an icon package: three paths are not a dependency, and the
 * kind is the field that decides them — a room, a group of people, one account — which
 * is what makes 「斗鱼官方手游区」 and 「客户端签到」 tell themselves apart at a glance.
 *
 * An item row carries one; the row of a record whose items are the action does not, because
 * there is nothing beside it to tell apart. Its kind is the action's own.
 */
const ITEM_GLYPH: Readonly<Record<ActionItemKind, string>> = {
  room: 'M2 4h12v7H2zM6 13l2-2 2 2',
  group: 'M3 3h10v7H7l-4 3z',
  account: 'M8 8a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM3 13c0-2.2 2.2-3.5 5-3.5s5 1.3 5 3.5'
}
</script>

<template>
  <NSpace vertical :size="12">
    <div v-for="record in records" :key="record.id" class="record">
      <!-- The action and what it got done, on one row. -->
      <div v-if="singleRow(record)" class="item">
        <span class="item-label">{{ actionLabel(record.actionKey) }}</span>
        <span class="item-detail">{{ rowText(record) }}</span>
        <NTag
          v-if="isUnsettledOutcome(record.outcome)"
          size="tiny"
          :bordered="false"
          :type="describeOutcome(record.outcome).tag"
        >
          {{ describeOutcome(record.outcome).label }}
        </NTag>
        <span class="time">{{ formatTime(record.at) }}</span>
      </div>

      <!-- The action, then one row per thing it acted on, each with its own fact. -->
      <template v-else>
        <NSpace align="center" :size="8">
          <span class="action">{{ actionLabel(record.actionKey) }}</span>
          <NTag
            v-if="isUnsettledOutcome(record.outcome)"
            size="tiny"
            :type="describeOutcome(record.outcome).tag"
          >
            {{ describeOutcome(record.outcome).label }}
          </NTag>
          <span class="time">{{ formatTime(record.at) }}</span>
        </NSpace>

        <NSpace vertical :size="4" class="items">
          <div v-for="(item, index) in record.items" :key="`${record.id}-${index}`" class="item">
            <span class="kind" :title="ACTION_ITEM_KIND_LABEL[item.kind]">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path :d="ITEM_GLYPH[item.kind]" />
              </svg>
            </span>
            <span class="item-label">{{ item.label }}</span>
            <span class="item-detail">{{ item.detail }}</span>
            <NTag
              v-if="isUnsettledOutcome(item.outcome)"
              size="tiny"
              :bordered="false"
              :type="describeOutcome(item.outcome).tag"
            >
              {{ describeOutcome(item.outcome).label }}
            </NTag>
          </div>
        </NSpace>
      </template>
    </div>
  </NSpace>
</template>

<style scoped>
.record {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.action {
  font-size: 13px;
}

.items {
  padding-left: 4px;
}

.item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
}

.kind {
  display: inline-flex;
  width: 14px;
  height: 14px;
  color: #999;
  flex-shrink: 0;
}

.kind svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.2;
  stroke-linecap: round;
}

.item-label {
  flex-shrink: 0;
}

.item-detail {
  color: #888;
  min-width: 0;
}

.time {
  color: #999;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
</style>
