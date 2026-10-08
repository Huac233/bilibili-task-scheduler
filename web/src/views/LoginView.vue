<script setup lang="ts">
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, NSpace, NTabPane, NTabs, useMessage } from 'naive-ui'
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { describeError } from '../api/client.js'
import { useAuthStore } from '../stores/auth.js'

/**
 * Login and registration.
 *
 * Both flows live on one screen behind tabs because they share every field, and
 * the backend returns a session token from either — so a successful submit is
 * handled identically and the redirect target comes from the query string.
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
</template>

<style scoped>
.page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100%;
  padding: 24px;
  background: #f5f6f8;
}

.card {
  width: 100%;
  max-width: 420px;
}
</style>
