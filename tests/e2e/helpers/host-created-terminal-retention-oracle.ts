/**
 * Shared oracle for "a host-created terminal stays the live terminal".
 *
 * Both retention specs (attached-window desktop host, windowless `orca serve`)
 * import this file unchanged, so the two topologies are judged by identical
 * code and neither can be claimed to prove the other by accident.
 *
 * Two independent signals per claim:
 *   1. the host's own session inventory still lists the tab and its ptyId;
 *   2. a byte written to that handle reaches the SAME fixture process — proven
 *      by its pid and by the sink holding exactly one READY line, so a
 *      respawned replacement cannot pass as a survivor.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect } from '@stablyai/playwright-test'

export type RuntimeRpcCall = <TResult>(method: string, params: unknown) => Promise<TResult>

export type HostCreatedTerminal = {
  handle: string
  tabId: string
  ptyId: string
  pid: string
  sinkPath: string
}

export type HostTerminalInventory = {
  publicationEpoch: string
  tabIds: string[]
  ptyIdByTabId: Record<string, string | null>
}

type SessionTabsListResult = {
  publicationEpoch: string
  tabs: {
    id: string
    type: string
    parentTabId?: string
    ptyId?: string | null
  }[]
}

const HOST_TERMINAL_SURFACE_SEPARATOR = '::'

/** Daemon session id form. Deliberately excluded from id-shape classification,
 *  which is why a host-created tab needs its own binding to be preserved —
 *  a `serve-`/`ssh-` shaped id would take an already-correct path instead. */
function isDaemonShapedPtyId(ptyId: string, worktreeId: string): boolean {
  return (
    ptyId.startsWith(`${worktreeId}@@`) &&
    !ptyId.startsWith('serve-') &&
    !ptyId.startsWith('ssh-') &&
    ptyId.slice(`${worktreeId}@@`.length).length > 0
  )
}

export function createRetentionFixtureDirectory(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'orca-host-terminal-retention-'))
}

/** Long-lived stand-in for the agent a CLI dispatch spawns: it never exits, so
 *  a pruned tab is never explained away by a dead PTY. */
export function writeRetentionFixture(directory: string): string {
  const fixturePath = path.join(directory, 'host-created-agent-terminal.mjs')
  writeFileSync(
    fixturePath,
    [
      "import { appendFileSync } from 'node:fs'",
      'const sink = process.argv[2]',
      'const record = (line) => appendFileSync(sink, `${line}\\n`)',
      'record(`READY:${process.pid}`)',
      'process.stdout.write(`READY:${process.pid}\\r\\n`)',
      "process.stdin.setEncoding('utf8')",
      "let pending = ''",
      "process.stdin.on('data', (data) => {",
      '  pending += data',
      '  const lines = pending.split(/\\r\\n|\\r|\\n/)',
      "  pending = lines.pop() ?? ''",
      '  for (const line of lines) {',
      '    record(`LINE:${line}`)',
      '    process.stdout.write(`LINE:${line}\\r\\n`)',
      '  }',
      '})',
      'process.stdin.resume()'
    ].join('\n')
  )
  return fixturePath
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function retentionFixtureCommand(fixturePath: string, sinkPath: string): string {
  const command = [process.execPath, fixturePath, sinkPath]
  return process.platform === 'win32'
    ? command.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ')
    : command.map(shellQuote).join(' ')
}

export function readSink(sinkPath: string): string {
  try {
    return readFileSync(sinkPath, 'utf8')
  } catch {
    return ''
  }
}

function readySignatures(sinkPath: string): string[] {
  return readSink(sinkPath)
    .split(/\r?\n/)
    .filter((line) => line.startsWith('READY:'))
}

/**
 * `orca terminal create`: the host-initiated background create. Sibling paths
 * are deliberately NOT used — `session.tabs.createTerminal` routes through
 * createRuntimeOwnedMobileSessionTerminal, which persists its binding on every
 * revision and would pass without exercising this seam at all.
 */
export async function createHostCliTerminal(
  call: RuntimeRpcCall,
  worktreeId: string,
  fixturePath: string,
  sinkPath: string
): Promise<HostCreatedTerminal> {
  const created = await call<{
    terminal: { handle: string; tabId?: string; ptyId?: string | null }
  }>('terminal.create', {
    worktree: `id:${worktreeId}`,
    command: retentionFixtureCommand(fixturePath, sinkPath),
    focus: false,
    activate: false,
    presentation: 'background'
  })
  const { handle, tabId } = created.terminal
  if (!tabId) {
    throw new Error('Host did not report a tab id for the CLI-created terminal')
  }
  const ptyId =
    created.terminal.ptyId ??
    (await call<{ terminal: { ptyId: string | null } }>('terminal.show', { terminal: handle }))
      .terminal.ptyId
  if (!ptyId) {
    throw new Error('Host did not report a PTY for the CLI-created terminal')
  }
  expect(
    isDaemonShapedPtyId(ptyId, worktreeId),
    `CLI terminal ${ptyId} must carry the daemon id shape this seam excludes from classification`
  ).toBe(true)
  await expect
    .poll(() => readySignatures(sinkPath).length, {
      timeout: 30_000,
      message: 'CLI-created terminal never started its fixture process'
    })
    .toBe(1)
  return {
    handle,
    tabId,
    ptyId,
    pid: readySignatures(sinkPath)[0]!.slice('READY:'.length),
    sinkPath
  }
}

export async function readHostTerminalInventory(
  call: RuntimeRpcCall,
  worktreeId: string
): Promise<HostTerminalInventory> {
  const snapshot = await call<SessionTabsListResult>('session.tabs.list', {
    worktree: `id:${worktreeId}`
  })
  const terminals = snapshot.tabs.filter((tab) => tab.type === 'terminal')
  const ptyIdByTabId: Record<string, string | null> = {}
  for (const tab of terminals) {
    const parentTabId = tab.parentTabId ?? tab.id.split(HOST_TERMINAL_SURFACE_SEPARATOR)[0]!
    ptyIdByTabId[parentTabId] = tab.ptyId ?? null
  }
  return {
    publicationEpoch: snapshot.publicationEpoch,
    tabIds: Object.keys(ptyIdByTabId),
    ptyIdByTabId
  }
}

/**
 * Signal 2. Writes through the handle and requires the ORIGINAL process to
 * answer: same pid, still exactly one READY line. A replacement PTY would
 * satisfy "a terminal is there" and fail here.
 */
export async function proveSameLivePty(
  call: RuntimeRpcCall,
  terminal: HostCreatedTerminal,
  marker: string
): Promise<void> {
  await call('terminal.send', { terminal: terminal.handle, text: marker, enter: true })
  await expect
    .poll(() => readSink(terminal.sinkPath), {
      timeout: 30_000,
      message: `CLI terminal ${terminal.ptyId} did not deliver ${marker} to its original process`
    })
    .toContain(`LINE:${marker}`)
  expect(
    readySignatures(terminal.sinkPath),
    'the surviving terminal must be the original process, not a respawned replacement'
  ).toEqual([`READY:${terminal.pid}`])
}
