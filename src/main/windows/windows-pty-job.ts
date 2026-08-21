import type { IPty } from 'node-pty'
import { createRequire } from 'node:module'

/**
 * Job-object ownership for a ConPTY's process tree.
 *
 * Before this, Orca answered "is this tree mine, and how do I kill it?" by
 * scraping the process table, walking parent pids back to itself, and then
 * running `taskkill /T /F` only if the walk said yes. Every step of that is a
 * guess:
 *
 * - a pid walk cannot survive pid reuse, so teardown had to refuse whenever it
 *   was unsure, and a refused kill is an orphaned agent tree holding the
 *   worktree directory open (#9045, #10475, #10087);
 * - a descendant that reparented is invisible to the walk entirely;
 * - the scrape itself could be blocked by policy, which read as "no evidence".
 *
 * A job object replaces the inference with a handle. node-pty puts each shell
 * into its own job at creation, before it can spawn anything, so membership is
 * the kernel's answer rather than ours.
 */

const requireFromMain = createRequire(__filename)

type ConptyNative = {
  terminateJob: (id: number) => boolean
  listJobProcessIds: (id: number) => number[] | null
}

let cachedNative: ConptyNative | null | undefined
let nativeLoader: () => ConptyNative | null = loadConptyNative

function loadConptyNative(): ConptyNative | null {
  if (cachedNative !== undefined) {
    return cachedNative
  }
  if (process.platform !== 'win32') {
    cachedNative = null
    return cachedNative
  }
  try {
    const { loadNativeModule } = requireFromMain('node-pty/lib/utils') as {
      loadNativeModule: (name: string) => { module: unknown }
    }
    const native = loadNativeModule('conpty').module as Partial<ConptyNative>
    // Why feature-detect: a node-pty rebuilt from unpatched sources exports
    // neither symbol, and calling through would throw on every teardown.
    cachedNative =
      typeof native?.terminateJob === 'function' && typeof native?.listJobProcessIds === 'function'
        ? (native as ConptyNative)
        : null
  } catch {
    cachedNative = null
  }
  return cachedNative
}

/**
 * node-pty's per-terminal handle id.
 *
 * Not on the public `IPty` surface, so read defensively: a winpty fallback
 * terminal and every POSIX terminal have none.
 */
function ptyHandleId(proc: IPty): number | null {
  const id = (proc as unknown as { _pty?: unknown })._pty
  return typeof id === 'number' && Number.isInteger(id) ? id : null
}

export type JobTerminationOutcome = 'terminated' | 'unavailable'

/**
 * Kill a PTY's entire process tree.
 *
 * Returns `unavailable` — never a false `terminated` — when the tree has no
 * job. Callers must degrade to the older best-effort path rather than treat
 * that as success, because "we could not tell" is exactly the state that used
 * to be misread as "nothing to kill".
 */
export function terminatePtyJob(proc: IPty): JobTerminationOutcome {
  const id = ptyHandleId(proc)
  const native = nativeLoader()
  if (id === null || !native) {
    return 'unavailable'
  }
  try {
    return native.terminateJob(id) ? 'terminated' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

/**
 * Pids still alive in a PTY's tree, or null when there is no answer.
 *
 * Measured on Windows 11: once the shell exits, node-pty drops its handle
 * record and closes the job, so a terminated tree reports **null**, not `[]`.
 * Null therefore means "unverifiable" in the sense of
 * docs/reference/ssh-execution-boundary.md — this build has no job support,
 * the terminal is not a ConPTY, or it is no longer tracked. It is never
 * evidence that processes died.
 *
 * The value this does add is descendant liveness for a tree that IS still
 * tracked: a pane whose shell is alive can be asked what is running under it,
 * including children that detached from the console.
 */
export function listPtyJobProcessIds(proc: IPty): readonly number[] | null {
  const id = ptyHandleId(proc)
  const native = nativeLoader()
  if (id === null || !native) {
    return null
  }
  try {
    return native.listJobProcessIds(id)
  } catch {
    return null
  }
}

/** Whether this build can own PTY trees with job objects at all. */
export function isPtyJobOwnershipAvailable(): boolean {
  return nativeLoader() !== null
}

/** Test-only: substitute the native module (it is resolved via createRequire). */
export function __setConptyJobNativeForTests(loader?: () => ConptyNative | null): void {
  nativeLoader = loader ?? loadConptyNative
  cachedNative = undefined
}
