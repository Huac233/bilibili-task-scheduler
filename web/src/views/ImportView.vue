<script setup lang="ts">
import {
  NAlert,
  NButton,
  NCard,
  NCollapse,
  NCollapseItem,
  NDivider,
  NDynamicInput,
  NFormItem,
  NGrid,
  NGridItem,
  NInput,
  NInputNumber,
  NSpace,
  NStatistic,
  NSwitch,
  NTag,
  useMessage
} from 'naive-ui'
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { describeError } from '../api/client.js'
import { libraryApi, replacementApi } from '../api/endpoints.js'
import { usePlatformStore } from '../stores/platform.js'
import { type PreviewResult, type ReplacementRule, TaskAction } from '../types/api.js'

/**
 * Text import with live segmentation preview.
 *
 * Every segmentation knob is exposed and previewable before committing: a 6 MB
 * novel produces ~148k bullets, and the only sane way to pick delimiters and
 * length limits is to look at what they actually produce on a sample. The
 * preview runs server-side against the same code path the import uses, so what
 * is shown is what will be stored.
 */

const router = useRouter()
const message = useMessage()
const catalog = usePlatformStore()

const text = ref('')
const filename = ref('')
const name = ref('')

// Segmentation parameters. Defaults mirror the server's.
const delimiters = ref<string[]>(['。', '！', '？', '；', '…', '!', '?', ';'])
const softDelimiters = ref<string[]>(['，', '、', '：', ' ', '—', ',', ':'])
const splitOnNewline = ref(true)
const minLength = ref(2)
const maxLength = ref(20)
const dedupe = ref(true)
const replacements = ref<ReplacementRule[]>([])

const previewing = ref(false)
const importing = ref(false)
const preview = ref<PreviewResult | null>(null)
const error = ref('')

const textChars = computed(() => text.value.length)
const textLines = computed(() => (text.value === '' ? 0 : text.value.split('\n').length))

/**
 * One length hint per Platform, from its Send action's declared cap.
 *
 * The cap is a property of the Action — each Platform declares its own, and the adapter is the only
 * thing that knows it — so the buttons are built from the catalogue rather than from remembered
 * numbers. A Platform whose Send action declares no cap contributes nothing.
 */
const capsByPlatform = computed(() => {
  const hints: { label: string; length: number }[] = []
  for (const platform of catalog.platforms) {
    const send = platform.actions.find(action => action.action === TaskAction.Send && action.maxMessageLength > 0)
    if (send === undefined) continue
    hints.push({ label: platform.label, length: send.maxMessageLength })
  }
  return hints
})

/**
 * The longest bullet any supported Platform would accept, in characters.
 *
 * **This is the route's own rule too**, which is why the two length boxes take their bound from here
 * rather than from a number written into this file: `server/src/routes/libraries.ts` bounds
 * `minLength`/`maxLength` at "the largest real cap rather than a round number", and the largest real cap
 * is exactly this — the biggest `maxMessageLength` a Send action declares. It is the same rule the
 * interval box follows, so a value this form allows is a value the route accepts; the `100` that used to
 * sit on both boxes was neither, and 71–100 came back as the route's 400 verbatim.
 *
 * `null` until the catalogue lands: the control claims no cap of its own in that state, and the page then
 * has no per-Platform hint buttons and no 「当前：」 figures either.
 */
const longestBulletCap = computed<number | null>(() => {
  const caps = capsByPlatform.value.map(hint => hint.length)
  return caps.length === 0 ? null : Math.max(...caps)
})

/**
 * The route's storage ceiling, mirrored — `MAX_BULLET_LENGTH` in `server/src/routes/libraries.ts`.
 *
 * A mirror because the two packages cannot share a value, and it is the *upper* bound of both boxes:
 * whatever a catalogue declares, a length over this one is a value the route answers with a 400.
 */
const ROUTE_BULLET_CEILING = 70

/**
 * What the two length boxes are bounded by: the smaller of the catalogue's cap and the route's ceiling.
 *
 * **The fallback is the route's ceiling, not no bound at all.** This code used to hand `NInputNumber` an
 * `Infinity` while the catalogue had not landed, on the reading that "no bound known" is the honest thing
 * to say — but a control that accepts 1000 is not saying nothing, it is offering a value the route
 * refuses, and it was *wider* than the hardcoded `100` it replaced. Which bound is unknown in that state
 * is the *Platform's* cap; the route's ceiling is known, and it is the one that decides whether a 400
 * comes back.
 *
 * The `Math.min` is the same point in the other direction: a catalogue that declares more than the route
 * stores is the signal that the route's number has to move, and until it does, offering the catalogue's
 * number would re-open exactly the window this bound exists to close. The form refuses the value rather
 * than passing a 400 on to a person who cannot see why.
 */
const bulletCapBound = computed<number>(() => {
  const declared = longestBulletCap.value ?? ROUTE_BULLET_CEILING
  return Math.min(declared, ROUTE_BULLET_CEILING)
})

/**
 * The two length boxes are one rule in two fields, so the pair is checked as a pair.
 *
 * `server/src/routes/libraries.ts` refuses `minLength > maxLength`, which is why bounding each box
 * separately is not enough: 50 and 20 are both legal lengths and the pair is not. A form that let the pair
 * through would be handing a person a 400 for a rule it can see, and one composed of two values it drew
 * itself.
 *
 * **A cleared box is read as `unknown` rather than as a number, because `NInputNumber` hands one back as
 * `null` and the refs' annotation cannot say so.** A guard that trusted the annotation would let a blank
 * through, and the route refuses one of those as well — `lengthOption` requires an integer — which is the
 * same defect as the pair, one field up.
 */
const lengthsInOrder = computed(() => {
  const min: unknown = minLength.value
  const max: unknown = maxLength.value
  return typeof min === 'number' && typeof max === 'number' && min <= max
})

/** What is wrong with the pair, or `''` when nothing is. Drawn under the two boxes it is about. */
const lengthOrderNote = computed(() => {
  if (lengthsInOrder.value) return ''
  const min: unknown = minLength.value
  const max: unknown = maxLength.value
  if (typeof min !== 'number' || typeof max !== 'number') {
    return '两个长度都要填上：空着的话服务端会拒绝。'
  }
  return `最短长度（${String(min)}）不能大于单条弹幕最长长度（${String(max)}），这个组合服务端会拒绝。`
})

onMounted(() => {
  // The length hints come from the catalogue, so make sure it is loaded even when
  // this is the first page the session opens.
  void catalog.ensure()
})

function currentParams(): {
  delimiters: string[]
  softDelimiters: string[]
  splitOnNewline: boolean
  minLength: number
  maxLength: number
  dedupe: boolean
  replacements: ReplacementRule[]
} {
  return {
    delimiters: delimiters.value,
    softDelimiters: softDelimiters.value,
    splitOnNewline: splitOnNewline.value,
    minLength: minLength.value,
    maxLength: maxLength.value,
    dedupe: dedupe.value,
    replacements: replacements.value.filter(rule => rule.pattern !== '')
  }
}

async function onFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file === undefined) return

  try {
    text.value = await file.text()
    filename.value = file.name
    if (name.value.trim() === '') name.value = file.name.replace(/\.[^.]+$/, '')
    preview.value = null
    message.success(`已读取 ${file.name}`)
  } catch (cause: unknown) {
    message.error(`读取文件失败：${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/**
 * Pulls the user's enabled rules from the library into this form.
 *
 * Merged by pattern rather than appended: clicking twice would otherwise stack
 * duplicates, and a rule already edited here should keep the local edits.
 */
async function loadStoredRules(): Promise<void> {
  try {
    const result = await replacementApi.list()
    const enabled = result.rules.filter(rule => rule.enabled)

    if (enabled.length === 0) {
      message.info('规则库里没有启用的规则')
      return
    }

    const merged = new Map<string, ReplacementRule>(replacements.value.map(rule => [rule.pattern, rule]))
    for (const rule of enabled) {
      merged.set(rule.pattern, {
        pattern: rule.pattern,
        replacement: rule.replacement,
        isRegex: rule.isRegex
      })
    }
    replacements.value = [...merged.values()]
    message.success(`已载入 ${String(enabled.length)} 条规则`)
  } catch (cause: unknown) {
    message.error(describeError(cause))
  }
}

async function runPreview(): Promise<void> {
  if (text.value.trim() === '') {
    message.warning('请先粘贴文本或选择文件')
    return
  }
  if (!lengthsInOrder.value) {
    message.warning(lengthOrderNote.value)
    return
  }

  previewing.value = true
  error.value = ''
  try {
    preview.value = await libraryApi.preview(text.value, currentParams())
  } catch (cause: unknown) {
    error.value = describeError(cause)
    preview.value = null
  } finally {
    previewing.value = false
  }
}

async function doImport(): Promise<void> {
  if (text.value.trim() === '') {
    message.warning('请先粘贴文本或选择文件')
    return
  }
  if (!lengthsInOrder.value) {
    message.warning(lengthOrderNote.value)
    return
  }

  importing.value = true
  error.value = ''
  try {
    const result = await libraryApi.create({
      name: name.value.trim(),
      filename: filename.value,
      text: text.value,
      params: currentParams()
    })
    message.success(`导入成功，共 ${String(result.library.bulletCount)} 条弹药`)
    // Said out loud after an import too, because importing does not require a preview: a rule the
    // guard skipped would otherwise be a change that silently did not take effect.
    if (result.stats.unsafeRulesSkipped > 0) {
      message.warning(`有 ${String(result.stats.unsafeRulesSkipped)} 条正则规则被安全守卫跳过，没有生效`)
    }
    await router.push({ name: 'library-detail', params: { id: result.library.id } })
  } catch (cause: unknown) {
    error.value = describeError(cause)
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <NSpace vertical :size="16">
    <NAlert v-if="error !== ''" type="error">{{ error }}</NAlert>

    <NCard title="1. 选择文本">
      <NSpace vertical :size="12">
        <NSpace align="center">
          <input type="file" accept=".txt,.md,text/plain" @change="onFile" />
          <NTag v-if="filename !== ''" size="small" type="info">{{ filename }}</NTag>
        </NSpace>

        <NInput
          v-model:value="text"
          type="textarea"
          placeholder="也可以直接粘贴文本到这里"
          :autosize="{ minRows: 8, maxRows: 18 }"
        />

        <NSpace>
          <NStatistic label="字符数" :value="textChars" />
          <NStatistic label="行数" :value="textLines" />
        </NSpace>

        <NAlert type="info" :bordered="false">
          建议先删掉版权页和目录再导入——它们同样会被切成弹药发出去。
        </NAlert>
      </NSpace>
    </NCard>

    <NCard title="2. 分割参数">
      <NGrid :cols="2" :x-gap="24" :y-gap="8">
        <NGridItem>
          <NFormItem label="句末分隔符">
            <NSpace>
              <NTag
                v-for="mark in delimiters"
                :key="mark"
                closable
                size="small"
                @close="delimiters = delimiters.filter(item => item !== mark)"
              >
                {{ mark === '\n' ? '\\n' : mark }}
              </NTag>
              <NInput
                size="small"
                style="width: 60px"
                placeholder="+"
                @keyup.enter="
                  event => {
                    const value = (event.target as HTMLInputElement).value
                    if (value !== '' && !delimiters.includes(value)) delimiters = [...delimiters, value]
                    ;(event.target as HTMLInputElement).value = ''
                  }
                "
              />
            </NSpace>
          </NFormItem>

          <NAlert
            v-if="delimiters.length === 0"
            type="info"
            :bordered="false"
            style="margin-bottom: 12px"
          >
            没有设置分隔符，将完全按字符长度切分。
          </NAlert>

          <NFormItem label="软分隔符（长句优先在此断开）">
            <NSpace>
              <NTag
                v-for="mark in softDelimiters"
                :key="mark"
                closable
                size="small"
                @close="softDelimiters = softDelimiters.filter(item => item !== mark)"
              >
                {{ mark }}
              </NTag>
            </NSpace>
          </NFormItem>

          <NFormItem label="按换行切分">
            <NSwitch v-model:value="splitOnNewline" />
          </NFormItem>

          <NFormItem label="自动去重">
            <NSwitch v-model:value="dedupe" />
          </NFormItem>
        </NGridItem>

        <NGridItem>
          <NFormItem label="最短长度">
            <NInputNumber v-model:value="minLength" :min="1" :max="bulletCapBound" style="width: 160px" />
          </NFormItem>

          <NFormItem label="单条弹幕最长长度">
            <NSpace align="center">
              <NInputNumber v-model:value="maxLength" :min="1" :max="bulletCapBound" style="width: 140px" />
              <NButton
                v-for="hint in capsByPlatform"
                :key="hint.label"
                size="tiny"
                @click="maxLength = hint.length"
              >
                {{ hint.label }} {{ hint.length }}
              </NButton>
            </NSpace>
          </NFormItem>

          <!-- The pair, under the two boxes it is about. Both moves that would send it are unavailable
               while this is drawn: the route refuses the combination, so the form must not offer it. -->
          <NAlert v-if="lengthOrderNote !== ''" type="error" :bordered="false" style="margin-top: 8px">
            {{ lengthOrderNote }}
          </NAlert>

          <NAlert type="warning" :bordered="false" style="margin-top: 8px">
            这就是每条弹幕的字符数上限，来自各个平台发送动作自己的声明<template v-if="capsByPlatform.length > 0"
              >（当前：<template v-for="(hint, index) in capsByPlatform" :key="hint.label"
                >{{ index === 0 ? '' : '、' }}{{ hint.label }} {{ hint.length }} 字</template
              >）</template
            >。比上限长的一条会被切成多条，切出来短于「最短长度」的尾段会丢掉——上限本身不会让整条被拒。
            如果任务开了加盐，装得下的那几条还会随机插入 2 个字符（多数字符是标点，也可能是空格），所以内容要再留 2 个字符余量。
          </NAlert>
        </NGridItem>
      </NGrid>

      <NDivider />

      <NCollapse>
        <NCollapseItem title="反和谐 / 替换规则" name="replacements">
          <NSpace align="center" class="rule-actions">
            <NButton size="small" @click="loadStoredRules">从规则库载入</NButton>
            <span class="hint">载入「替换规则」里启用的规则，可以在此基础上临时改动</span>
          </NSpace>
          <NDynamicInput v-model:value="replacements" :on-create="() => ({ pattern: '', replacement: '', isRegex: false })">
            <template #default="{ value }">
              <NSpace align="center">
                <NInput v-model:value="value.pattern" placeholder="要匹配的内容" style="width: 200px" />
                <span>→</span>
                <NInput v-model:value="value.replacement" placeholder="替换为" style="width: 200px" />
                <NSwitch v-model:value="value.isRegex">
                  <template #checked>正则</template>
                  <template #unchecked>文本</template>
                </NSwitch>
              </NSpace>
            </template>
          </NDynamicInput>
        </NCollapseItem>
      </NCollapse>
    </NCard>

    <NCard title="3. 预览与导入">
      <!--
        Two children, each in a fixed key, for the reason `task-create.test.ts` records: `NSpace` wraps
        every child it is given in `<div key={1}>` (naive-ui `es/space/src/Space.mjs`), so a slot whose
        child set changes is a keyed fragment with duplicate keys and Vue reconciles the wrong nodes.
        The second child here appears when a preview lands, which is exactly that change.
      -->
      <NSpace vertical :size="12">
        <div :key="'import-actions'">
          <NSpace>
            <NButton type="primary" secondary :loading="previewing" :disabled="!lengthsInOrder" @click="runPreview">
              预览分割结果
            </NButton>
            <NInput v-model:value="name" placeholder="文本库名称（可留空自动生成）" style="width: 280px" />
            <NButton type="primary" :loading="importing" :disabled="!lengthsInOrder" @click="doImport">导入</NButton>
          </NSpace>
        </div>

        <div :key="'import-preview'">
          <template v-if="preview !== null">
            <NDivider />
            <NSpace>
              <NStatistic label="弹药条数" :value="preview.summary.count" />
              <NStatistic label="平均长度" :value="(preview.summary.totalChars / Math.max(1, preview.summary.count)).toFixed(1)" />
              <NStatistic label="最短 / 最长" :value="`${preview.summary.minChars} / ${preview.summary.maxChars}`" />
              <NStatistic label="去重丢弃" :value="preview.stats.deduped" />
              <NStatistic label="过短丢弃" :value="preview.stats.droppedTooShort" />
              <NStatistic label="规则被跳过" :value="preview.stats.unsafeRulesSkipped" />
            </NSpace>

            <!--
              The rules the guard refused, named and counted.

              The guard rejects any pattern the matching engine could take exponential time on, and it
              deliberately over-refuses, so a person will meet this — and without a sentence here the
              only visible sign of it is their own rule quietly missing from the result. 「几条」 and
              「为什么」 are both here because either alone leaves them guessing.
            -->
            <NAlert v-if="preview.stats.unsafeRulesSkipped > 0" type="warning" :bordered="false">
              这次有 {{ preview.stats.unsafeRulesSkipped }} 条正则规则没生效：安全守卫把它们跳过了，因为它们在匹配失败时可能让耗时指数增长。
              守卫宁可多拒绝也不冒这个险，所以要去掉规则里的嵌套量词（例如 (a?)+ 这种写法），或者把它改成文本替换。
            </NAlert>

            <NAlert v-if="preview.truncated" type="warning" :bordered="false">
              样本过长，仅预览了前 {{ preview.sampleChars }} 个字符；实际导入会处理全文。
            </NAlert>

            <NCard size="small" title="前几条效果">
              <NSpace vertical :size="4">
                <div v-for="(bullet, index) in preview.bullets" :key="index" class="bullet">
                  <NTag size="tiny">{{ bullet.length }}</NTag>
                  <span>{{ bullet }}</span>
                </div>
              </NSpace>
            </NCard>
          </template>
        </div>
      </NSpace>
    </NCard>
  </NSpace>
</template>

<style scoped>
.bullet {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
}

.rule-actions {
  margin-bottom: 12px;
}

.hint {
  color: #888;
  font-size: 13px;
}
</style>
