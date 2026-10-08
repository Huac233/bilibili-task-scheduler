import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { describeError } from '../api/client.js'
import { actionSettingApi, platformApi } from '../api/endpoints.js'
import type { ActionDescriptor, ActionSetting, Platform } from '../types/api.js'

/**
 * The Platform catalogue and the action switchboard.
 *
 * Loaded once per page load and shared by every view that needs it — the create
 * form, the task list, the task detail, the accounts view and the switches panel
 * all ask the same questions of the same two endpoints. That is also why this
 * store is the only module in the app that reads `GET /api/platforms`: a view
 * that answered "what Platforms exist" any other way would be wrong the moment a
 * third adapter was registered.
 *
 * Nothing below names a Platform. Keys arrive from the server, labels come out of
 * the catalogue, and every lookup falls back to the key itself so a row written
 * by a newer build still renders instead of disappearing.
 */
/**
 * One catalogue action paired with its switch, and one Platform's worth of them.
 *
 * Exported because they are the store's answer rather than its internals: a component that renders
 * the catalogue is handed exactly this shape by `catalogue`, and typing its own copy of it is how
 * the two drift.
 */
export interface ActionSwitch {
  readonly descriptor: ActionDescriptor
  readonly enabled: boolean
}

export interface PlatformCatalogue {
  readonly key: string
  readonly label: string
  readonly actions: readonly ActionSwitch[]
}

export const usePlatformStore = defineStore('platform', () => {
  const platforms = ref<Platform[]>([])
  const settings = ref<ActionSetting[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref('')

  /**
   * Loads the catalogue and the switches together.
   *
   * They are always shown together — a switch with no descriptor has no label,
   * and a descriptor with no switch state is indistinguishable from "off" except
   * by accident — so one call, one error slot, one loading flag.
   */
  async function load(): Promise<void> {
    loading.value = true
    try {
      const [catalogue, switches] = await Promise.all([platformApi.list(), actionSettingApi.list()])
      platforms.value = catalogue
      settings.value = switches
      loaded.value = true
      error.value = ''
    } catch (cause: unknown) {
      error.value = describeError(cause)
    } finally {
      loading.value = false
    }
  }

  /** Loads on first use and reuses the result afterwards. */
  async function ensure(): Promise<void> {
    if (loaded.value) return
    await load()
  }

  function platformOf(key: string): Platform | null {
    return platforms.value.find(platform => platform.key === key) ?? null
  }

  /** The Platform's own display name, falling back to its key for an unknown one. */
  function labelOf(key: string): string {
    return platformOf(key)?.label ?? key
  }

  function descriptorOf(platformKey: string, actionKey: string): ActionDescriptor | null {
    return platformOf(platformKey)?.actions.find(action => action.key === actionKey) ?? null
  }

  /**
   * An action's name as the catalogue gives it.
   *
   * Falls back to the raw key only when the catalogue has no such action — a task
   * left behind by a build whose adapter declared it — because showing an empty
   * cell there would hide the task rather than explain it.
   */
  function actionLabel(platformKey: string, actionKey: string): string {
    return descriptorOf(platformKey, actionKey)?.label ?? actionKey
  }

  /** Off unless a row says otherwise: absence means off, server-side. */
  function isEnabled(platformKey: string, actionKey: string): boolean {
    return settingOf(platformKey, actionKey)?.enabled ?? false
  }

  function settingOf(platformKey: string, actionKey: string): ActionSetting | null {
    return settings.value.find(item => item.platform === platformKey && item.actionKey === actionKey) ?? null
  }

  /**
   * The switch on one action, or `null` when the catalogue cannot answer for it.
   *
   * One action rather than "the Platform's enabled set", because a reconcile Task runs exactly the
   * action its own row names: asking whether *that* action may run is the only question a Task's
   * day turns on, and a list of the Platform's other switched-on actions has no bearing on it.
   *
   * **`null` means the question cannot be answered yet**: the catalogue has not loaded, or it does
   * not know this Platform's key (a task written by a newer build). Returning `false` there would be
   * indistinguishable from "the switch is off" — a real state, and a different one — so the two are
   * kept apart and the caller shows no verdict.
   */
  function switchOf(platformKey: string, actionKey: string): boolean | null {
    if (platformOf(platformKey) === null) return null
    return isEnabled(platformKey, actionKey)
  }

  /** Flips one switch and keeps the cached list in step with the server's answer. */
  async function setEnabled(platformKey: string, actionKey: string, enabled: boolean): Promise<void> {
    cacheSetting(await actionSettingApi.set(platformKey, actionKey, enabled))
  }

  /**
   * Writes one action's parameters, leaving its switch as it is.
   *
   * The switch's own value is sent rather than omitted, because the route takes one action at a
   * time and has no "options only" body: sending the value it already has is what makes this a
   * parameters write rather than a flip. It is read here rather than taken from the caller — this
   * store holds the server's answer, and a caller that passed the wrong value would turn a save
   * into an accidental toggle, which on a costly action is the dangerous direction.
   *
   * The answer is cached, which is the whole reason a caller uses this instead of the API layer:
   * the parameter form is destroyed and rebuilt every time it is closed, and it opens on what this
   * store says is stored. A write that skipped the cache would show the previous value next open.
   */
  async function setOptions(platformKey: string, actionKey: string, options: unknown): Promise<void> {
    cacheSetting(await actionSettingApi.set(platformKey, actionKey, isEnabled(platformKey, actionKey), options))
  }

  /** Replaces one row of the cached list with what the server answered. */
  function cacheSetting(updated: ActionSetting): void {
    settings.value = [
      ...settings.value.filter(item => !(item.platform === updated.platform && item.actionKey === updated.actionKey)),
      updated
    ]
  }

  /** The catalogue with every action's switch state, in registration order. */
  const catalogue = computed<PlatformCatalogue[]>(() =>
    platforms.value.map(platform => ({
      key: platform.key,
      label: platform.label,
      actions: platform.actions.map(descriptor => ({
        descriptor,
        enabled: isEnabled(platform.key, descriptor.key)
      }))
    }))
  )

  /** How many actions are switched on, for the panel's summary line. */
  const enabledCount = computed<number>(() =>
    catalogue.value.reduce((total, platform) => total + platform.actions.filter(a => a.enabled).length, 0)
  )

  /** How many actions exist, so "0 / 8" can be shown without recounting. */
  const actionCount = computed<number>(() =>
    platforms.value.reduce((total, platform) => total + platform.actions.length, 0)
  )

  return {
    platforms,
    settings,
    loading,
    loaded,
    error,
    catalogue,
    enabledCount,
    actionCount,
    load,
    ensure,
    platformOf,
    labelOf,
    descriptorOf,
    actionLabel,
    isEnabled,
    settingOf,
    switchOf,
    setEnabled,
    setOptions
  }
})
