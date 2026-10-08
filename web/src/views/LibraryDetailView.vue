<script setup lang="ts">
import { NAlert, NButton, NCard, NEmpty, NPagination, NSpace, NSpin, NTag, useMessage } from 'naive-ui'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { describeError } from '../api/client.js'
import { libraryApi } from '../api/endpoints.js'
import type { Library } from '../types/api.js'

/**
 * Library detail: metadata plus a paged view of the bullets.
 *
 * Paginated rather than virtualised because the page is for spot-checking what
 * segmentation produced, not for reading 148k rows.
 */
const route = useRoute()
const router = useRouter()
const message = useMessage()

/**
 * The library in the address, as a value rather than a snapshot.
 *
 * `Number(route.params['id'])` read once in `setup` is only right while the instance and the address
 * change together, and vue-router reuses one instance across two addresses that match the same route
 * record. This page is reached from the list with a `push`, so the *route* changes while the instance
 * stays: without the watcher below, `#/libraries/1` followed by `#/libraries/2` kept drawing the first
 * library's bullets under the second library's name.
 */
const libraryId = computed<number>(() => Number(route.params['id']))
const loading = ref(true)
const library = ref<Library | null>(null)
const bullets = ref<{ seq: number; content: string }[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 50

async function loadInfo(): Promise<void> {
  try {
    library.value = await libraryApi.get(libraryId.value)
    total.value = library.value.bulletCount
  } catch (cause: unknown) {
    message.error(describeError(cause))
  }
}

async function loadPage(at: number): Promise<void> {
  loading.value = true
  try {
    const result = await libraryApi.bullets(libraryId.value, (at - 1) * pageSize, pageSize)
    bullets.value = [...result.bullets]
    total.value = result.total
  } catch (cause: unknown) {
    message.error(describeError(cause))
  } finally {
    loading.value = false
  }
}

watch(page, at => {
  void loadPage(at)
})

/**
 * A different library is a different page: reset the pager and read it.
 *
 * One read of the bullets either way — `page`'s watcher fires only when the number really changes, so
 * when the page was already 1 this reads the first page itself.
 */
watch(libraryId, () => {
  library.value = null
  bullets.value = []
  total.value = 0
  void loadInfo()
  if (page.value === 1) void loadPage(1)
  else page.value = 1
})

onMounted(async () => {
  await loadInfo()
  await loadPage(page.value)
})
</script>

<template>
  <NSpace vertical :size="16">
    <NCard>
      <template #header>
        <NSpace align="center">
          <span>{{ library?.name ?? '文本库' }}</span>
          <NTag v-if="library" size="small" type="info">{{ library.bulletCount }} 条</NTag>
        </NSpace>
      </template>
      <template #header-extra>
        <NButton size="small" @click="router.push({ name: 'libraries' })">返回列表</NButton>
      </template>

      <NAlert v-if="library && library.filename !== ''" type="default" :bordered="false">
        来源文件：{{ library.filename }}
      </NAlert>
    </NCard>

    <NCard title="弹药内容">
      <NSpin :show="loading">
        <NEmpty v-if="bullets.length === 0 && !loading" description="没有内容" />

        <NSpace v-else vertical :size="6">
          <div v-for="bullet in bullets" :key="bullet.seq" class="bullet">
            <NTag size="tiny" :bordered="false">{{ bullet.seq + 1 }}</NTag>
            <span>{{ bullet.content }}</span>
          </div>
        </NSpace>

        <div v-if="total > pageSize" class="pager">
          <NPagination v-model:page="page" :page-size="pageSize" :item-count="total" />
        </div>
      </NSpin>
    </NCard>
  </NSpace>
</template>

<style scoped>
.bullet {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
  line-height: 1.6;
}

.pager {
  display: flex;
  justify-content: center;
  margin-top: 16px;
}
</style>
