import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'

/**
 * Tracks whether a paired runtime's session-tab mirror has concluded a
 * hydration pass, so client-side recovery can tell "the host reported no PTY"
 * apart from "the host has not answered yet".
 *
 * Why: mirrored `web-terminal-*` panes carry no local PTY handle until the host
 * snapshot lands, and treating that gap as pane death relaunched agents the
 * host was still running (codex `-32600 already has an active writer`).
 *
 * Evidence arrives at two granularities and they are NOT interchangeable. A
 * full inventory (listAll, or the global stream's `snapshots` frame) speaks for
 * every worktree, because absence from it is itself a verdict. A single-worktree
 * frame speaks only for its own worktree, so it must not release panes parked on
 * a background workspace whose snapshot has not arrived.
 */

type ParkedMirrorWaiter = { environmentId: string; worktreeId: string; run: () => void }

const hydratedGenerationByEnvironment = new Map<string, number>()
const hydratedGenerationByWorktree = new Map<string, number>()
const parkedWaitersByWorktree = new Map<string, ParkedMirrorWaiter>()

function worktreeKey(environmentId: string, worktreeId: string): string {
  return `${environmentId}\0${worktreeId}`
}

/** Why: a host restart bumps the connection generation, so a verdict from the
 *  previous connection says nothing about the PTYs of the new one. */
function isCurrentGeneration(environmentId: string, generation: number | undefined): boolean {
  return (
    generation !== undefined &&
    generation === getRuntimeEnvironmentConnectionGeneration(environmentId)
  )
}

export function hasHostSessionMirrorHydrated(environmentId: string, worktreeId: string): boolean {
  return (
    isCurrentGeneration(environmentId, hydratedGenerationByEnvironment.get(environmentId)) ||
    isCurrentGeneration(
      environmentId,
      hydratedGenerationByWorktree.get(worktreeKey(environmentId, worktreeId))
    )
  )
}

function drainParkedWaiters(matches: (waiter: ParkedMirrorWaiter) => boolean): void {
  const dueKeys: string[] = []
  for (const [key, waiter] of parkedWaitersByWorktree) {
    if (matches(waiter)) {
      dueKeys.push(key)
    }
  }
  // Why: drain from a snapshot — a replay can re-park itself, and that new
  // waiter belongs to the next hydration, not this one.
  for (const key of dueKeys) {
    const waiter = parkedWaitersByWorktree.get(key)
    if (waiter) {
      parkedWaitersByWorktree.delete(key)
      waiter.run()
    }
  }
}

/**
 * Settles the whole environment. Call only for a conclusion that speaks for
 * every worktree: a full inventory that has ALREADY been applied to the store,
 * or a failure that proves no inventory is coming (a host error, a transport
 * failure, a closed stream). Waiters drain synchronously, so calling this
 * before the frame's store patch lands would re-run recovery against state the
 * frame has not populated yet — which is the bug this whole module exists to
 * prevent.
 */
export function markHostSessionMirrorHydrated(environmentId: string): void {
  hydratedGenerationByEnvironment.set(
    environmentId,
    getRuntimeEnvironmentConnectionGeneration(environmentId)
  )
  drainParkedWaiters((waiter) => waiter.environmentId === environmentId)
}

/** Settles one worktree, for a single-worktree frame already applied to the
 *  store. Never releases panes parked on this environment's other worktrees. */
export function markHostSessionMirrorWorktreeHydrated(
  environmentId: string,
  worktreeId: string
): void {
  hydratedGenerationByWorktree.set(
    worktreeKey(environmentId, worktreeId),
    getRuntimeEnvironmentConnectionGeneration(environmentId)
  )
  drainParkedWaiters(
    (waiter) => waiter.environmentId === environmentId && waiter.worktreeId === worktreeId
  )
}

/** Why: waiters survive this reset — a re-pair or effect restart replaces the
 *  verdict, it does not cancel the recovery the client still owes. */
export function clearHostSessionMirrorHydration(environmentId: string): void {
  hydratedGenerationByEnvironment.delete(environmentId)
  const prefix = `${environmentId}\0`
  for (const key of hydratedGenerationByWorktree.keys()) {
    if (key.startsWith(prefix)) {
      hydratedGenerationByWorktree.delete(key)
    }
  }
}

export function parkUntilHostSessionMirrorHydrates(
  environmentId: string,
  worktreeId: string,
  run: () => void
): void {
  parkedWaitersByWorktree.set(worktreeKey(environmentId, worktreeId), {
    environmentId,
    worktreeId,
    run
  })
}

export function resetHostSessionMirrorHydrationForTests(): void {
  hydratedGenerationByEnvironment.clear()
  hydratedGenerationByWorktree.clear()
  parkedWaitersByWorktree.clear()
}
