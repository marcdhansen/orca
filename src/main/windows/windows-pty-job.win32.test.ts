import { afterEach, describe, expect, it } from 'vitest'
import type { IPty } from 'node-pty'
import {
  isPtyJobOwnershipAvailable,
  listPtyJobProcessIds,
  terminatePtyJob
} from './windows-pty-job'

/**
 * The unit tests pin the contract; this pins the thing the contract is for.
 *
 * A grandchild spawned `detached` leaves the pane's console and reparents, so
 * neither `GetConsoleProcessList` nor a parent-pid walk can see it. That is the
 * process that outlived its pane and held the worktree directory open
 * (#9045, #10475, #10897). Job membership is the only mechanism that finds it,
 * so the assertion below is the whole justification for the node-pty patch.
 *
 * Runs only on win32; skipped elsewhere.
 */
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describeOnWindows('ConPTY job ownership', () => {
  const spawned: IPty[] = []

  afterEach(() => {
    for (const proc of spawned.splice(0)) {
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
    }
  })

  async function spawnShellWithDetachedGrandchild(): Promise<{
    proc: IPty
    grandchildPid: number
  }> {
    const nodePty = await import('node-pty')
    const proc = nodePty.spawn('cmd.exe', [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 30,
      cwd: process.cwd(),
      useConptyDll: true
    })
    spawned.push(proc)

    let grandchildPid: number | null = null
    proc.onData((chunk) => {
      const match = /ORCA_GC=(\d+)/.exec(chunk)
      if (match && grandchildPid === null) {
        grandchildPid = Number(match[1])
      }
    })

    const script = [
      "const{spawn}=require('child_process');",
      "const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],",
      "{detached:true,stdio:'ignore'});",
      "c.unref();console.log('ORCA_GC='+c.pid);"
    ].join('')
    proc.write(`node -e "${script}"\r`)

    for (let attempt = 0; attempt < 80 && grandchildPid === null; attempt += 1) {
      await sleep(250)
    }
    if (grandchildPid === null) {
      throw new Error('grandchild never reported its pid')
    }
    // Let the shell settle so the pid list is not read mid-spawn.
    await sleep(1_000)
    return { proc, grandchildPid }
  }

  it('reports this build as able to own pty trees', () => {
    // A node-pty rebuilt from unpatched sources would silently fall back to the
    // old probe, so every assertion below would pass vacuously.
    expect(isPtyJobOwnershipAvailable()).toBe(true)
  })

  it('counts a detached grandchild as part of the pane tree', async () => {
    const { proc, grandchildPid } = await spawnShellWithDetachedGrandchild()

    const pids = listPtyJobProcessIds(proc)
    expect(pids).not.toBeNull()
    expect(pids).toContain(proc.pid)
    expect(pids).toContain(grandchildPid)
  }, 60_000)

  it('kills the shell and the detached grandchild in one call', async () => {
    const { proc, grandchildPid } = await spawnShellWithDetachedGrandchild()
    expect(isAlive(grandchildPid)).toBe(true)

    expect(terminatePtyJob(proc)).toBe('terminated')
    await sleep(1_500)

    expect(isAlive(proc.pid)).toBe(false)
    expect(isAlive(grandchildPid)).toBe(false)
  }, 60_000)

  it('stops answering once the tree is gone, rather than claiming it is empty', async () => {
    // Measured, not assumed: node-pty drops its handle record and closes the
    // job when the shell exits, so a dead tree is unverifiable here rather than
    // observably empty. Callers must not read null as proof of death -- the
    // verdict vocabulary in docs/reference/ssh-execution-boundary.md applies.
    const { proc } = await spawnShellWithDetachedGrandchild()
    terminatePtyJob(proc)
    await sleep(1_500)

    expect(listPtyJobProcessIds(proc)).toBeNull()
  }, 60_000)
})
