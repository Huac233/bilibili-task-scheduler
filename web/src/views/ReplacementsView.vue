<script setup lang="ts">
import { NAlert, NButton, NCard, NEmpty, NInput, NPopconfirm, NSpace, NSpin, NSwitch, NTag, useMessage } from 'naive-ui'
import { computed, onMounted, ref } from 'vue'

import { describeError } from '../api/client.js'
import { replacementApi } from '../api/endpoints.js'
import type { StoredRule } from '../types/api.js'

/**
 * Replacement rule library ("反和谐").
 *
 * Rules stored here are applied at import time alongside any typed into the
 * import form, so this is where a durable rule set lives. Rules are applied in
 * insertion order, which matters when one rule's output feeds another's
 * pattern — the list is therefore shown in that order and cannot be reordered.
 *
 * A regex is compiled server-side when the rule is created, so an invalid
 * pattern is rejected here while the user is looking at the form.
 */
const message = useMessage()

const loading = ref(true)
const rules = ref<StoredRule[]>([])
const limit = ref(200)
const error = ref('')

const newPattern = ref('')
const newReplacement = ref('')
const newIsRegex = ref(false)
const creating = ref(false)

const canCreate = computed(() => newPattern.value !== '' && !creating.value)

async function load(): Promise<void> {
  try {
    const result = await replacementApi.list()
    rules.value = result.rules
    limit.value = result.limit
    error.value = ''
  } catch (cause: unknown) {
    error.value = describeError(cause)
  } finally {
    loading.value = false
  }
}

async function create(): Promise<void> {
  if (!canCreate.value) return
  creating.value = true
  error.value = ''

  try {
    const rule = await replacementApi.create({
      pattern: newPattern.value,
      replacement: newReplacement.value,
      isRegex: newIsRegex.value
    })
    rules.value = [...rules.value, rule]
    newPattern.value = ''
    newReplacement.value = ''
    newIsRegex.value = false
    message.success('规则已添加')
  } catch (cause: unknown) {
    error.value = describeError(cause)
  } finally {
    creating.value = false
  }
}

async function toggle(rule: StoredRule, enabled: boolean): Promise<void> {
  try {
    const updated = await replacementApi.setEnabled(rule.id, enabled)
    rules.value = rules.value.map(item => (item.id === updated.id ? updated : item))
  } catch (cause: unknown) {
    message.error(describeError(cause))
    await load()
  }
}

async function remove(id: number): Promise<void> {
  try {
    await replacementApi.remove(id)
    rules.value = rules.value.filter(item => item.id !== id)
    message.success('已删除')
  } catch (cause: unknown) {
    message.error(describeError(cause))
  }
}

onMounted(() => {
  void load()
})
</script>

<template>
  <NSpace vertical :size="16">
    <NAlert v-if="error !== ''" type="error">{{ error }}</NAlert>

    <NCard title="替换规则">
      <template #header-extra>
        <NTag size="small">{{ rules.length }} / {{ limit }}</NTag>
      </template>

      <NAlert type="info" :bordered="false" class="mb">
        规则在导入文本时应用，按添加顺序依次执行。开启正则后，匹配内容会当作 JavaScript 正则表达式。
      </NAlert>

      <NSpace class="add-row" align="center">
        <NInput v-model:value="newPattern" placeholder="要匹配的内容" style="width: 220px" />
        <span class="arrow">→</span>
        <NInput v-model:value="newReplacement" placeholder="替换为（留空表示删除）" style="width: 220px" />
        <NSwitch v-model:value="newIsRegex">
          <template #checked>正则</template>
          <template #unchecked>文本</template>
        </NSwitch>
        <NButton type="primary" :disabled="!canCreate" :loading="creating" @click="create">添加</NButton>
      </NSpace>

      <NSpin :show="loading">
        <NEmpty v-if="rules.length === 0 && !loading" description="还没有替换规则" />

        <NSpace v-else vertical :size="10">
          <div v-for="rule in rules" :key="rule.id" class="row">
            <NSpace align="center" :size="10" class="content">
              <NTag size="small" :bordered="false" :type="rule.isRegex ? 'info' : 'default'">
                {{ rule.isRegex ? '正则' : '文本' }}
              </NTag>
              <code class="pattern">{{ rule.pattern }}</code>
              <span class="arrow">→</span>
              <code class="replacement">{{ rule.replacement === '' ? '（删除）' : rule.replacement }}</code>
            </NSpace>

            <NSpace align="center" :size="8">
              <NSwitch
                size="small"
                :value="rule.enabled"
                @update:value="value => void toggle(rule, value)"
              />
              <NPopconfirm @positive-click="() => void remove(rule.id)">
                <template #trigger>
                  <NButton size="small" quaternary type="error">删除</NButton>
                </template>
                确定删除这条规则吗？
              </NPopconfirm>
            </NSpace>
          </div>
        </NSpace>
      </NSpin>
    </NCard>
  </NSpace>
</template>

<style scoped>
.mb {
  margin-bottom: 16px;
}

.add-row {
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid #f0f0f0;
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 0;
  border-bottom: 1px solid #fafafa;
}

.content {
  flex: 1;
  min-width: 0;
}

.pattern,
.replacement {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  word-break: break-all;
}

.arrow {
  color: #999;
}
</style>
