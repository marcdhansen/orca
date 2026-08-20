import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'

/**
 * Tracks whether a paired runtime's session-tab mirror has concluded a
 * hydration pass, so client-side recovery can tell "the host reported no PTY"
 * apart from "the host has not answered yet".
 *
 * Why: mirrored `web-terminal-*` panes carry no local PTY handle until the host
 * snapshot lands, and treating that gap as pane death relaunched agents the
 * host was still running (codex `-32600 already has an active writer`).
 */

type ParkedMirrorWaiter = { environmentId: string; run: () => void }

const hydratedGenerationByEnvironment = new Map<string, number>()
const parkedWaitersByKey = new Map<string, ParkedMirrorWaiter>()

function waiterKey(environmentId: string, key: string): string {
  return `${environmentId}\0${key}`
}

/** Why: a host restart bumps the connection generation, so a verdict from the
 *  previous connection says nothing about the PTYs of the new one. */
export function hasHostSessionMirrorHydrated(environmentId: string): boolean {
  const hydratedGeneration = hydratedGenerationByEnvironment.get(environmentId)
  return (
    hydratedGeneration !== undefined &&
    hydratedGeneration === getRuntimeEnvironmentConnectionGeneration(environmentId)
  )
}

/** Call on every conclusion of a hydration attempt — applied snapshots, an
 *  empty inventory, a host error, or a transport failure — or deferred work
 *  parks forever. */
export function markHostSessionMirrorHydrated(environmentId: string): void {
  hydratedGenerationByEnvironment.set(
    environmentId,
    getRuntimeEnvironmentConnectionGeneration(environmentId)
  )
  const dueKeys: string[] = []
  for (const [key, waiter] of parkedWaitersByKey) {
    if (waiter.environmentId === environmentId) {
      dueKeys.push(key)
    }
  }
  // Why: drain from a snapshot — a replay can re-park itself, and that new
  // waiter belongs to the next hydration, not this one.
  for (const key of dueKeys) {
    const waiter = parkedWaitersByKey.get(key)
    if (waiter) {
      parkedWaitersByKey.delete(key)
      waiter.run()
    }
  }
}

/** Why: waiters survive this reset — a re-pair or effect restart replaces the
 *  verdict, it does not cancel the recovery the client still owes. */
export function clearHostSessionMirrorHydration(environmentId: string): void {
  hydratedGenerationByEnvironment.delete(environmentId)
}

export function parkUntilHostSessionMirrorHydrates(
  environmentId: string,
  key: string,
  run: () => void
): void {
  parkedWaitersByKey.set(waiterKey(environmentId, key), { environmentId, run })
}

export function resetHostSessionMirrorHydrationForTests(): void {
  hydratedGenerationByEnvironment.clear()
  parkedWaitersByKey.clear()
}
