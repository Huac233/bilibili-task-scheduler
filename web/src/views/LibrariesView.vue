<script setup lang="ts">
import { NAlert, NButton, NCard, NEmpty, NPopconfirm, NSpace, NSpin, NTag, useMessage } from 'naive-ui'
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { describeError } from '../api/client.js'
import { libraryApi } from '../api/endpoints.js'
import type { Library } from '../types/api.js'

/**
 * Text libraries.
 *
 * Shows what each import produced (bullet count, source size) because that is
 * the fastest way to notice a segmentation setting went wrong — 200 bullets out
 * of a 6 MB novel means the delimiter set is off.
 */
const router = useRouter()
const message = useMessage()

const loading = ref(true)
const libraries = ref<Library[]>([])
const error = ref('')

async function load(): Promise<void> {
  try {
    libraries.value = await libraryApi.list()
  } catch (cause: unknown) {
    error.value = describeError(cause)
  } finally {
    loading.value = false
  }
}

async function remove(id: number): Promise<void> {
  try {
    await libraryApi.remove(id)
    message.success('已删除')
    await load()
  } catch (cause: unknown) {
    message.error(describeError(cause))
  }
}

function formatSize(chars: number): string {
  if (chars < 1000) return `${String(chars)} 字`
  if (chars < 1_000_000) return `${(chars / 1000).toFixed(1)} 千字`
  return `${(chars / 1_000_000).toFixed(2)} 百万字`
}

onMounted(() => {
  void load()
})
</script>

<template>
  <NCard title="文本库">
    <template #header-extra>
      <NButton type="primary" @click="router.push({ name: 'library-import' })">导入文本</NButton>
    </template>

    <!-- The sentence this page could not say before: `error` was written on every failed read and
         rendered nowhere, so a failed `GET /api/libraries` left 「还没有导入文本」 standing on its own —
         the one claim a person would act on, with nothing beside it to say it was not known. -->
    <NAlert v-if="error !== ''" type="error" class="mb">{{ error }}</NAlert>

    <NSpin :show="loading">
      <!-- Claimed only once the read has succeeded: an empty list and an unread one are different
           facts, and this is the state a person reads as 「我这里什么都没有」. -->
      <NEmpty v-if="libraries.length === 0 && error === ''" description="还没有导入文本">
        <template #extra>
          <NButton size="small" @click="router.push({ name: 'library-import' })">去导入</NButton>
        </template>
      </NEmpty>

      <NSpace v-else vertical :size="12">
        <div v-for="library in libraries" :key="library.id" class="row">
          <div class="info">
            <div class="name">
              {{ library.name }}
              <NTag size="tiny" type="info">{{ library.bulletCount }} 条</NTag>
            </div>
            <div class="meta">
              {{ formatSize(library.rawChars) }} · {{ new Date(library.createdAt).toLocaleString('zh-CN') }}
            </div>
          </div>
          <NButton size="small" @click="router.push({ name: 'library-detail', params: { id: library.id } })">
            查看
          </NButton>
          <NPopconfirm @positive-click="() => void remove(library.id)">
            <template #trigger>
              <NButton size="small" quaternary type="error">删除</NButton>
            </template>
            删除后引用它的任务将无法继续发送，确定吗？
          </NPopconfirm>
        </div>
      </NSpace>
    </NSpin>
  </NCard>
</template>

<style scoped>
.mb {
  margin-bottom: 16px;
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid #f0f0f0;
}

.info {
  flex: 1;
  min-width: 0;
}

.name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
}

.meta {
  color: #888;
  font-size: 13px;
  margin-top: 2px;
}
</style>
