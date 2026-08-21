import { useAppStore } from '../store'

/** A reconnect or a new runtime process makes every earlier answer stale, so answers
 *  are stamped with this identity. */
export function webSessionTabsConnectionIdentity(environmentId: string): string {
  if (!environmentId) {
    return ''
  }
  // No status means no identity, so nothing counts as an answer — the fail-open side.
  const status = useAppStore.getState?.()?.runtimeStatusByEnvironmentId?.get(environmentId)
  const runtimeId = status?.status?.runtimeId
  return runtimeId ? `${runtimeId}#${status?.connectionGeneration ?? 0}` : ''
}
