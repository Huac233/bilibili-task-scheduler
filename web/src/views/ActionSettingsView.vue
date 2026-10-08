<script setup lang="ts">
import { NCard, NTag } from 'naive-ui'
import { onMounted } from 'vue'

import ActionSettingsPanel from '../components/ActionSettingsPanel.vue'
import { usePlatformStore } from '../stores/platform.js'

/**
 * Action switches, on their own page.
 *
 * ADR-0002 shipped every action dark, and this is the screen where that decision
 * becomes reversible — so it sits in the main navigation rather than inside the
 * create form. Finding a switch should not require starting a task first.
 */
const catalog = usePlatformStore()

// The header counts come from the same store the panel fills, and the panel's own
// load would otherwise leave the header at "0 / 0" for one render.
onMounted(() => {
  void catalog.ensure()
})
</script>

<template>
  <NCard title="动作开关">
    <template #header-extra>
      <NTag size="small">{{ catalog.enabledCount }} / {{ catalog.actionCount }} 已开启</NTag>
    </template>

    <ActionSettingsPanel />
  </NCard>
</template>
