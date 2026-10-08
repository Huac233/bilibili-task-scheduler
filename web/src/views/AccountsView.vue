<script setup lang="ts">
import {
  NAlert,
  NAvatar,
  NButton,
  NCard,
  NEmpty,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NPopconfirm,
  NSpace,
  NSpin,
  NTag,
  useMessage
} from 'naive-ui'
import QRCode from 'qrcode'
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { describeError, httpStatusOf } from '../api/client.js'
import { accountApi, bindSpecOf, credentialBindApi, qrBindApi } from '../api/endpoints.js'
import { usePlatformStore } from '../stores/platform.js'
import type { Account } from '../types/api.js'

/**
 * Bound accounts, grouped by Platform.
 *
 * The grouping is the point: an Account is one person's binding to one Platform,
 * and the credential handshake differs per Platform, so the row that offers it
 * has to be the Platform's own. Every group comes from `GET /api/platforms`, and
 * the bind entry point for a group is chosen by the bind method the API layer
 * records for it — this view never tests a Platform key.
 *
 * A Platform with no accounts still gets its heading and its bind button: that is
 * where a person starts.
 */
const message = useMessage()
const catalog = usePlatformStore()

const loading = ref(true)
const accounts = ref<Account[]>([])
const error = ref('')

/**
 * Accounts whose avatar image failed to load, by id.
 *
 * `NAvatar` renders a plain `<img>` and, with no `fallback` slot in use, leaves a broken
 * image icon in the row when the request fails. A cross-origin image can fail for
 * reasons this app does not control — a CDN referrer rule, a hotlink block, a URL the
 * Platform has since retired — so the row keeps a state that always says something.
 */
const brokenAvatars = ref(new Set<number>())

/**
 * Which avatar to draw: the Platform's image when there is one that loaded, otherwise the
 * first character of the name.
 *
 * The failure is tracked per account rather than globally so one dead URL does not
 * quietly disable every avatar on the page.
 */
function avatarOf(account: Account): 'image' | 'initial' {
  if (account.avatar === '' || brokenAvatars.value.has(account.id)) return 'initial'
  return 'image'
}

/**
 * Everything the row's avatar needs.
 *
 * `referrerPolicy: 'no-referrer'` is the load-bearing part, not a privacy nicety.
 * Bilibili's image CDN answers **403** to an avatar request that carries a Referer from
 * any other site — measured against the `i1.hdslb.com/bfs/face/…` URL this app has
 * stored — and a browser sends the page's own origin as the Referer on an `<img>` by
 * default. The stored URL is correct: fetched without that header it answers `200
 * image/gif`, and the account's avatar really is a GIF, which an `<img>` draws. So the
 * app asks for the image the one way the CDN accepts, with the same attribute for every
 * Platform, since only a cross-origin hotlink-protected URL can be affected by it.
 */
function avatarImgProps(account: Account): { referrerPolicy: 'no-referrer'; onError: () => void } {
  return {
    referrerPolicy: 'no-referrer',
    onError: () => {
      brokenAvatars.value = new Set([...brokenAvatars.value, account.id])
    }
  }
}

/** One Platform's group: its heading, its accounts, and how to add one. */
interface AccountGroup {
  readonly key: string
  readonly label: string
  readonly method: 'qrcode' | 'credential' | 'none'
  /** Non-empty when this Platform also offers the paste entry point as a backup. */
  readonly credentialPath: string
  readonly accounts: readonly Account[]
}

/**
 * Builds the groups.
 *
 * Catalogue order first, so the page is stable regardless of what is bound, then
 * one extra group per Platform that has accounts but no catalogue entry — a row
 * written by a newer build must stay visible and unbindable rather than vanish.
 */
const groups = computed<AccountGroup[]>(() => {
  const known = new Set(catalog.platforms.map(platform => platform.key))
  const build = (key: string, label: string): AccountGroup => {
    const spec = bindSpecOf(key)
    return {
      key,
      label,
      method: spec.method,
      credentialPath: spec.credentialPath,
      accounts: accounts.value.filter(account => account.platform === key)
    }
  }

  const fromCatalogue = catalog.platforms.map(platform => build(platform.key, platform.label))
  const orphans = [...new Set(accounts.value.map(account => account.platform))]
    .filter(key => !known.has(key))
    .map(key => build(key, key))

  return [...fromCatalogue, ...orphans]
})

/* ------------------------------- loading ------------------------------- */

async function loadAccounts(): Promise<void> {
  try {
    accounts.value = await accountApi.list()
    error.value = ''
  } catch (cause: unknown) {
    error.value = describeError(cause)
  } finally {
    loading.value = false
  }
}

async function unbind(id: number): Promise<void> {
  try {
    await accountApi.remove(id)
    message.success('已解绑')
    await loadAccounts()
  } catch (cause: unknown) {
    message.error(describeError(cause))
  }
}

/**
 * The account's name as it should be read.
 *
 * Empty when this Platform gave the account no name, which is a real state and not a
 * formatting problem: the row then says it is showing an id. A Platform that cannot
 * supply a nickname without a call nobody has verified leaves `display_name` empty, and
 * the id is the honest fallback — on the line that says it is an id, rather than in the
 * name's own place where it reads as a name.
 */
function accountName(account: Account): string {
  return account.displayName
}

/* ------------------------------ QR binding ------------------------------ */

const showBind = ref(false)
/** The Platform being bound, as a key and a label: the catalogue entry itself is not needed. */
const bindPlatform = ref<BindTarget | null>(null)
const qrDataUrl = ref('')
/**
 * The handshake's state, including the two ways it used to keep quiet about stopping.
 *
 * `failed` and `unstarted` are different facts and used to share one state and one sentence: `failed` is
 * a poll that died *after* a code was rendered — the person may well have scanned it, so 「扫码结果没读到」
 * is about them — while `unstarted` is the code itself never arriving, where nothing was scanned and there
 * is no result to read. Both are states of the handshake rather than of the QR image, and without them the
 * dialog went on saying 「请用 X 客户端扫码」 over a handshake that had already stopped.
 */
const qrState = ref<'pending' | 'scanned' | 'success' | 'expired' | 'failed' | 'unstarted'>('pending')
const binding = ref(false)
/** Why the handshake stopped, shown inside the dialog: the page's own error bar is behind it. */
const bindError = ref('')

/** Which Platform a bind dialog is for. The pair travels together so a label is never derived from a key. */
interface BindTarget {
  readonly key: string
  readonly label: string
}

let pollTimer: ReturnType<typeof setInterval> | null = null

const stateLabel = computed(() => {
  const platform = bindPlatform.value?.label ?? ''
  switch (qrState.value) {
    case 'pending':
      return `请用 ${platform} 客户端扫码`
    case 'scanned':
      return '已扫码，请在手机上确认'
    case 'expired':
      return '二维码已过期，请重新生成'
    case 'failed':
      return '扫码结果没读到，这次握手已经停下'
    case 'unstarted':
      return '二维码没取到，这次握手还没有开始'
    default:
      return '绑定成功'
  }
})

/**
 * Whether the handshake has stopped, which is where the way out belongs.
 *
 * Three states rather than two, and the dialog is the whole screen while it is open: the button used to
 * be drawn for `expired` and `failed` alone, so a handshake that never started had no retry on it at all
 * — the one state whose remedy is exactly the button.
 */
const handshakeStopped = computed(
  () => qrState.value === 'expired' || qrState.value === 'failed' || qrState.value === 'unstarted'
)

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

/**
 * Starts the scan handshake.
 *
 * Three steps: request a code, render the returned URL as a QR image, then poll
 * until a terminal state. Polling stops on every terminal state (success,
 * expiry, error, unmount) — a leaked interval would keep hitting an endpoint long
 * after the user moved on.
 */
async function startBind(target: BindTarget): Promise<void> {
  bindPlatform.value = target
  binding.value = true
  error.value = ''
  bindError.value = ''
  qrDataUrl.value = ''
  qrState.value = 'pending'

  try {
    const { url, key } = await qrBindApi.start(target.key)

    // Rendered locally: the backend returns a URL for the platform's app to scan,
    // not an image, so the browser draws it.
    qrDataUrl.value = await QRCode.toDataURL(url, { width: 240, margin: 1 })

    stopPolling()
    pollTimer = setInterval(() => {
      void (async (): Promise<void> => {
        try {
          const result = await qrBindApi.poll(target.key, key)
          qrState.value = result.state === 'success' ? 'success' : (result.state as typeof qrState.value)

          if (result.state === 'success') {
            stopPolling()
            message.success('绑定成功')
            // The bind response is not modelled: the accounts list is re-read
            // instead, so every Platform's successful bind lands the same way.
            await loadAccounts()
            setTimeout(() => {
              showBind.value = false
            }, 800)
          } else if (result.state === 'expired') {
            stopPolling()
          }
        } catch (cause: unknown) {
          // The handshake is over, and the dialog has to say so: one failed poll stops the timer, and
          // a server that restarted or let the session expire answers 404 on the very next one. The
          // reason goes in a ref of its own because the page-level error bar is *behind* the modal.
          stopPolling()
          qrState.value = 'failed'
          bindError.value = describeError(cause)
          error.value = bindError.value
        }
      })()
    }, 2000)
  } catch (cause: unknown) {
    // No code, so no handshake: the scan never started, which is its own sentence rather than the dead
    // poll's — and the way out is drawn for it, because this is where a person is standing.
    qrState.value = 'unstarted'
    bindError.value = describeError(cause)
    error.value = bindError.value
  } finally {
    binding.value = false
  }
}

function openQrcodeBind(target: BindTarget): void {
  showBind.value = true
  void startBind(target)
}

/** Re-runs the handshake for the Platform the dialog is already showing. */
function restartBind(): void {
  if (bindPlatform.value !== null) void startBind(bindPlatform.value)
}

/* --------------------------- credential binding --------------------------- */

const showPaste = ref(false)
const pastePlatform = ref<BindTarget | null>(null)
const pasteToken = ref('')
const pasteDid = ref('')
const pasteCookies = ref('')
const pasting = ref(false)
const pasteError = ref('')

/**
 * True once the server has answered 404 or 405 to the bind call.
 *
 * The route is per-Platform and may not exist in the deployed build. Detected
 * rather than assumed, so the form starts working the moment the route ships —
 * and the note below says exactly which call is missing rather than reporting a
 * bad token for a request that was never routed.
 */
const pasteEndpointMissing = ref(false)

const canPaste = computed(
  () => pasteToken.value.trim() !== '' && pasteDid.value.trim() !== '' && !pasting.value && !pasteEndpointMissing.value
)

function openPasteBind(target: BindTarget): void {
  pastePlatform.value = target
  pasteToken.value = ''
  pasteDid.value = ''
  pasteCookies.value = ''
  pasteError.value = ''
  pasteEndpointMissing.value = false
  showPaste.value = true
}

async function submitPaste(): Promise<void> {
  const platform = pastePlatform.value
  if (platform === null || !canPaste.value) return

  pasting.value = true
  pasteError.value = ''

  try {
    await credentialBindApi.bind(platform.key, {
      token: pasteToken.value.trim(),
      did: pasteDid.value.trim(),
      // Sent only when typed: an empty cookie header is not the same as none.
      ...(pasteCookies.value.trim() === '' ? {} : { webCookies: pasteCookies.value.trim() })
    })
    message.success('绑定成功')
    showPaste.value = false
    await loadAccounts()
  } catch (cause: unknown) {
    const status = httpStatusOf(cause)
    if (status === 404 || status === 405) pasteEndpointMissing.value = true
    else pasteError.value = describeError(cause)
  } finally {
    pasting.value = false
  }
}

onMounted(async () => {
  // The catalogue is what gives the groups their names and their bind methods, so
  // it is waited for before the page is declared loaded.
  await catalog.ensure()
  await loadAccounts()
})

onUnmounted(() => {
  stopPolling()
})
</script>

<template>
  <NSpace vertical :size="16">
    <NAlert v-if="error !== ''" type="error">{{ error }}</NAlert>

    <NCard v-for="group in groups" :key="group.key">
      <template #header>
        <NSpace align="center">
          <span>{{ group.label }}</span>
          <NTag size="tiny" :bordered="false">{{ group.accounts.length }} 个账号</NTag>
        </NSpace>
      </template>

      <template #header-extra>
        <NSpace>
          <NButton
            v-if="group.method === 'qrcode'"
            type="primary"
            size="small"
            @click="openQrcodeBind({ key: group.key, label: group.label })"
          >
            扫码绑定
          </NButton>
          <NButton
            v-if="group.method === 'credential' || group.credentialPath !== ''"
            size="small"
            @click="openPasteBind({ key: group.key, label: group.label })"
          >
            粘贴凭据绑定
          </NButton>
          <NTag v-if="group.method === 'none' && group.credentialPath === ''" size="small" :bordered="false">
            暂不支持在界面绑定
          </NTag>
        </NSpace>
      </template>

      <NSpin :show="loading">
        <!-- Claimed only when the accounts read succeeded: an empty group and an unread list are
             different facts, and the error bar above is where the second one is said. -->
        <NEmpty v-if="group.accounts.length === 0 && error === ''" description="还没有绑定这个平台的账号" />

        <NSpace v-else vertical :size="12">
          <div v-for="account in group.accounts" :key="account.id" class="row">
            <NAvatar
              v-if="avatarOf(account) === 'image'"
              round
              :size="40"
              :src="account.avatar"
              :img-props="avatarImgProps(account)"
            />
            <NAvatar v-else round :size="40">{{ accountName(account).slice(0, 1) || '#' }}</NAvatar>
            <div class="info">
              <div class="name">{{ accountName(account) !== '' ? accountName(account) : '账号 ID（该平台没有提供昵称）' }}</div>
              <div class="uid">ID {{ account.externalId }}</div>
            </div>
            <NTag size="small" type="success">已绑定</NTag>
            <NPopconfirm @positive-click="() => void unbind(account.id)">
              <template #trigger>
                <NButton size="small" quaternary type="error">解绑</NButton>
              </template>
              解绑会同时删除该账号下的所有任务，确定吗？
            </NPopconfirm>
          </div>
        </NSpace>
      </NSpin>
    </NCard>

    <NModal v-model:show="showBind" preset="card" :title="`${bindPlatform?.label ?? ''} 扫码绑定`" style="max-width: 360px">
      <div class="qr">
        <img v-if="qrDataUrl !== ''" :src="qrDataUrl" alt="登录二维码" width="240" height="240" />
        <!-- Only while the code is on its way. A handshake that never started is not loading, and a
             spinner over it is the same untrue claim as 「请用 X 客户端扫码」 was. -->
        <NSpin v-else-if="qrState === 'pending'" size="large" />
      </div>
      <div class="qr-hint">{{ stateLabel }}</div>
      <div v-if="bindError !== ''" class="qr-error">{{ bindError }}</div>
      <!-- The way out is offered wherever the handshake stopped, not only where the code expired: the
           dialog is the whole screen while it is open, so a failed poll — and a code that never arrived —
           had no retry on it. -->
      <NButton v-if="handshakeStopped" block :loading="binding" @click="restartBind">重新生成</NButton>
    </NModal>

    <NModal v-model:show="showPaste" preset="card" :title="`${pastePlatform?.label ?? ''} 粘贴凭据绑定`" style="max-width: 480px">
      <NAlert v-if="pasteEndpointMissing" type="warning" class="mb">
        服务端还没有绑定接口：<code>{{ credentialBindApi.pathOf(pastePlatform?.key ?? '') }}</code> 返回 404。
        凭据格式可以先记下来（复合 token + 设备 ID），等接口上线后再提交，这里不会替你猜一个别的地址。
      </NAlert>
      <NAlert v-else type="info" :bordered="false" class="mb">
        扫码是推荐方式，这里是备用入口：扫码走不通时，手动填一份凭据。需要两样东西：复合 token（形如
        <code>uid_biz_stk_ct_ltkid</code>）和登录时用的设备 ID。
      </NAlert>
      <NAlert v-if="pasteError !== ''" type="error" class="mb">{{ pasteError }}</NAlert>

      <NForm label-placement="top">
        <NFormItem label="复合 token">
          <NInput v-model:value="pasteToken" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" placeholder="uid_biz_stk_ct_ltkid" />
        </NFormItem>
        <NFormItem label="设备 ID">
          <NInput v-model:value="pasteDid" placeholder="客户端登录时的 did" />
        </NFormItem>
        <NFormItem label="网页 Cookie（可留空）">
          <NInput v-model:value="pasteCookies" type="textarea" :autosize="{ minRows: 1, maxRows: 3 }" placeholder="可选，一般不需要" />
        </NFormItem>
      </NForm>

      <template #footer>
        <NSpace justify="end">
          <NButton @click="showPaste = false">取消</NButton>
          <NButton type="primary" :disabled="!canPaste" :loading="pasting" @click="submitPaste">绑定</NButton>
        </NSpace>
      </template>
    </NModal>
  </NSpace>
</template>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid #f0f0f0;
}

.info {
  flex: 1;
  min-width: 0;
}

.name {
  font-weight: 500;
}

.uid {
  color: #888;
  font-size: 13px;
}

.qr {
  display: flex;
  justify-content: center;
  padding: 8px 0 16px;
}

.qr-hint {
  text-align: center;
  color: #666;
  margin-bottom: 12px;
}

.qr-error {
  color: #d03050;
  font-size: 13px;
  text-align: center;
  margin-bottom: 12px;
}

.mb {
  margin-bottom: 12px;
}
</style>
