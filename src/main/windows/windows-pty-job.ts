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
 *
 * The job is not kill-on-close: it makes an explicit teardown exact, and
 * deliberately does not change what a clean shell exit means for anything the
 * user backgrounded.
 */

const requireFromMain = createRequire(__filename)

type ConptyNative = {
  terminateJob: (id: number, shellPid: number) => boolean
  listJobProcessIds: (id: number, shellPid: number) => number[] | null
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
 * node-pty's per-terminal handle id, paired with the shell pid that proves it.
 *
 * Neither is on the public `IPty` surface, so read defensively. The pid is not
 * belt-and-braces: the winpty backend mints `pty` ids from its own counter and
 * the JS layer stores both in the same field, so an id alone can name a
 * different, live ConPTY pane. The native side refuses on a pid mismatch.
 */
function ptyJobTarget(proc: IPty): { id: number; shellPid: number } | null {
  const id = (proc as unknown as { _pty?: unknown })._pty
  const shellPid = proc.pid
  if (!Number.isInteger(id) || !Number.isInteger(shellPid) || (shellPid as number) <= 0) {
    return null
  }
  return { id: id as number, shellPid: shellPid as number }
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
  const target = ptyJobTarget(proc)
  const native = nativeLoader()
  if (!target || !native) {
    return 'unavailable'
  }
  try {
    return native.terminateJob(target.id, target.shellPid) ? 'terminated' : 'unavailable'
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
  const target = ptyJobTarget(proc)
  const native = nativeLoader()
  if (!target || !native) {
    return null
  }
  try {
    return native.listJobProcessIds(target.id, target.shellPid)
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
