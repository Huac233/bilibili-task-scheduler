import type { Platform } from './types.js'

/**
 * The Platform registry.
 *
 * Adapters register themselves here, and everything above the seam — the
 * scheduler, the routes, the UI — asks the registry rather than naming a
 * Platform. Registration happens in `platform/index.ts`, which is the single
 * place that knows the concrete adapters exist, so importing this module never
 * drags an adapter's dependencies in behind it.
 */

const registry = new Map<string, Platform>()

export function registerPlatform(platform: Platform): void {
  registry.set(platform.key, platform)
}

/** `null` rather than a throw: an unknown key means data written by a newer build. */
export function platformFor(key: string): Platform | null {
  return registry.get(key) ?? null
}

/** Every registered Platform, in registration order. */
export function allPlatforms(): Platform[] {
  return [...registry.values()]
}

/** The action catalogue of one Platform, or empty when the key is unknown. */
export function actionsOf(key: string): readonly import('./types.js').ActionDescriptor[] {
  return platformFor(key)?.actions ?? []
}

/** Looks up one action's descriptor across every Platform. */
export function findAction(key: string, actionKey: string): import('./types.js').ActionDescriptor | null {
  return platformFor(key)?.actions.find(action => action.key === actionKey) ?? null
}
