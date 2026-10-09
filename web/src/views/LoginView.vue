<script setup lang="ts">
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, NSpace, NTabPane, NTabs, useMessage } from 'naive-ui'
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { describeError } from '../api/client.js'
import AppFooter from '../components/AppFooter.vue'
import { useAuthStore } from '../stores/auth.js'

/**
 * Login and registration.
 *
 * Both flows live on one screen behind tabs because they share every field, and
 * the backend returns a session token from either — so a successful submit is
 * handled identically and the redirect target comes from the query string.
 *
 * This page is the one screen outside `AppShell`, which is why it mounts the
 * footer itself: it is a route of its own rather than a child of the shell.
 */
const auth = useAuthStore()
const router = useRouter()
const route = useRoute()
const message = useMessage()

const tab = ref<'login' | 'register'>('login')
const username = ref('')
const password = ref('')
const confirm = ref('')
const error = ref('')

const canSubmit = computed(() => {
  if (username.value.trim() === '' || password.value === '') return false
  if (tab.value === 'register' && password.value !== confirm.value) return false
  return !auth.loading
})

const mismatch = computed(() => tab.value === 'register' && confirm.value !== '' && password.value !== confirm.value)

async function submit(): Promise<void> {
  if (!canSubmit.value) return
  error.value = ''

  try {
    if (tab.value === 'login') {
      await auth.login(username.value.trim(), password.value)
      message.success('登录成功')
    } else {
      await auth.register(username.value.trim(), password.value)
      message.success('注册成功')
    }

    const redirect = typeof route.query['redirect'] === 'string' ? route.query['redirect'] : '/'
    await router.replace(redirect)
  } catch (cause: unknown) {
    error.value = describeError(cause)
  }
}
</script>

<template>
  <div class="page">
    <!--
      The card lives in its own growing element and the footer is the page's last child, which is the
      arrangement that puts the card in the middle of a tall window instead of at the top of it — the
      same one `AppShell` uses for this footer on every other page, so the two cannot drift apart.
    -->
    <div class="main">
      <NCard class="card" title="直播定时任务">
        <NTabs v-model:value="tab" type="segment" animated>
          <NTabPane name="login" tab="登录">
            <NSpace vertical :size="16">
              <NAlert v-if="error !== ''" type="error" :show-icon="true">{{ error }}</NAlert>

              <NForm @submit.prevent="submit">
                <NFormItem label="用户名">
                  <NInput v-model:value="username" placeholder="请输入用户名" @keyup.enter="submit" />
                </NFormItem>
                <NFormItem label="密码">
                  <NInput
                    v-model:value="password"
                    type="password"
                    show-password-on="click"
                    placeholder="请输入密码"
                    @keyup.enter="submit"
                  />
                </NFormItem>
              </NForm>

              <NButton type="primary" block :loading="auth.loading" :disabled="!canSubmit" @click="submit">
                登录
              </NButton>
            </NSpace>
          </NTabPane>

          <NTabPane name="register" tab="注册">
            <NSpace vertical :size="16">
              <NAlert v-if="error !== ''" type="error" :show-icon="true">{{ error }}</NAlert>

              <NForm @submit.prevent="submit">
                <NFormItem label="用户名">
                  <NInput v-model:value="username" placeholder="3-24 位中文、字母、数字或下划线" />
                </NFormItem>
                <NFormItem label="密码">
                  <NInput
                    v-model:value="password"
                    type="password"
                    show-password-on="click"
                    placeholder="至少 8 位"
                  />
                </NFormItem>
                <NFormItem label="确认密码" v-bind="mismatch ? { 'validation-status': 'error' } : {}">
                  <NInput
                    v-model:value="confirm"
                    type="password"
                    show-password-on="click"
                    placeholder="再输入一次"
                    @keyup.enter="submit"
                  />
                </NFormItem>
              </NForm>

              <NButton type="primary" block :loading="auth.loading" :disabled="!canSubmit" @click="submit">
                注册并登录
              </NButton>
            </NSpace>
          </NTabPane>
        </NTabs>
      </NCard>
    </div>

    <AppFooter />
  </div>
</template>

<style scoped>
/*
 * The page is a column with two anchors: the card in the middle, the footer at the end.
 *
 * `min-height: 100%` used to be here and was inert. `.page`'s parent is Naive UI's
 * `.n-config-provider`, whose height is `auto`, so the percentage had nothing to be a percentage
 * of — measured in Chrome, this page came out 406.8px tall inside an 865px window, with the card at
 * the top and 458px of empty viewport under it. `dvh` is a length the viewport itself answers, which
 * is why the floor now means something; the unit is the one `AppShell.vue` uses for its own mobile
 * layout, and for the same reason: `vh` is the viewport height with the address bar *hidden*, so
 * with the bar showing a page floored at `100vh` is taller than what a person can see and its bottom
 * — the footer, now — sits under the browser chrome. `dvh` is the height visible at this moment, so
 * the footer is on screen with the bar showing and the floor grows back when the bar collapses.
 *
 * `min-height` rather than `height`, deliberately: this is a floor, not a box. When the card cannot
 * fit — a short screen, or the on-screen keyboard — the page grows past the viewport and the
 * document scrolls. A fixed height would centre the card inside a box smaller than itself and put
 * the top of the form above the scroll origin, which is the one place a field can never be reached.
 */
.page {
  display: flex;
  flex-direction: column;
  /*
   * Without this the floor above misses the padding: `min-height` sizes the content box by default,
   * so a 100dvh floor plus 48px of padding made the page 913px tall in an 865px window, scrolled it
   * by 48px, and left the footer's last line — the repository link — below the bottom edge.
   */
  box-sizing: border-box;
  min-height: 100dvh;
  padding: 24px;
  /* The footer is the last thing here, so it clears a phone's home indicator. */
  padding-bottom: calc(24px + env(safe-area-inset-bottom));
  background: #f5f6f8;
}

/*
 * The height the card does not use, and the shell's own recipe rather than a second one for the same
 * footer: `flex: 1 0 auto` grows this element into the leftover space and refuses to shrink it, so
 * the card is centred in the space above the footer on a tall window and simply follows the top of
 * the page on one too short to hold it — exactly as `AppShell.vue`'s `.shell-main` does for every
 * other page. The `flex-shrink: 0` half is what keeps the card at its own height when the viewport
 * cannot hold it, instead of compressing a form until its fields overlap.
 */
.main {
  flex: 1 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
}

.card {
  width: 100%;
  max-width: 420px;
}
</style>
