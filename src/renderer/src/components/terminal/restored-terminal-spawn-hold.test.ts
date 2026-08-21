import { describe, expect, it } from 'vitest'
import { WEB_SESSION_TABS_RPC_TIMEOUT_MS } from '../../runtime/web-session-tabs-sync'
import {
  applyRestoredTerminalSpawnHold,
  planRestoredTerminalSpawnHold,
  RESTORED_TERMINAL_SPAWN_HOLD_MAX_TOTAL_MS,
  RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS,
  willRestoredTabSpawnHostTerminal,
  type RestoredSpawnHoldEntry,
  type RestoredSpawnHoldPaneState,
  type RestoredSpawnHoldTab
} from './restored-terminal-spawn-hold'

const WORKTREE_ID = 'wt-1'
const ENVIRONMENT_ID = 'env-1'
const CONNECTION = 'rt-1#1'
const NEXT_CONNECTION = 'rt-1#2'
const WAITING = { connection: CONNECTION, answered: false }
const ANSWERED = { connection: CONNECTION, answered: true }
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const TABS: RestoredSpawnHoldTab[] = [
  { id: 'row-1', ptyId: null },
  { id: 'row-2', ptyId: null }
]

function plan(
  overrides: Partial<Parameters<typeof planRestoredTerminalSpawnHold>[0]> = {}
): ReturnType<typeof planRestoredTerminalSpawnHold> {
  return planRestoredTerminalSpawnHold({
    holdByWorktreeId: new Map<string, RestoredSpawnHoldEntry>(),
    worktreeId: WORKTREE_ID,
    environmentId: ENVIRONMENT_ID,
    answer: WAITING,
    isColdActivationPass: true,
    nowMs: 1_000,
    allTabs: TABS,
    wouldSpawnHostTerminal: () => true,
    immediateTabIds: new Set<string>(),
    isTabLive: () => false,
    hasMountedTab: () => false,
    ...overrides
  })
}

function paneState(
  overrides: Partial<RestoredSpawnHoldPaneState> = {}
): RestoredSpawnHoldPaneState {
  return {
    terminalLayoutsByTabId: {},
    runtimePaneTitlesByTabId: {},
    ptyIdsByTabId: {},
    ...overrides
  } as RestoredSpawnHoldPaneState
}

describe('willRestoredTabSpawnHostTerminal', () => {
  it('is true only for a row with no pty anywhere', () => {
    expect(willRestoredTabSpawnHostTerminal({ id: 'row-1', ptyId: null }, paneState())).toBe(true)
    expect(willRestoredTabSpawnHostTerminal({ id: 'row-1', ptyId: 'pty-1' }, paneState())).toBe(
      false
    )
    // Mirrored rows route to the host-session mirror, which has no create path.
    expect(
      willRestoredTabSpawnHostTerminal({ id: 'web-terminal-1', ptyId: null }, paneState())
    ).toBe(false)
    expect(
      willRestoredTabSpawnHostTerminal(
        { id: 'row-1', ptyId: null },
        paneState({ ptyIdsByTabId: { 'row-1': ['remote:env-1:pty-2'] } })
      )
    ).toBe(false)
    // A persisted layout leaf that still owns a pty attaches instead of spawning.
    expect(
      willRestoredTabSpawnHostTerminal(
        { id: 'row-1', ptyId: null },
        paneState({
          terminalLayoutsByTabId: {
            'row-1': {
              root: null,
              activeLeafId: LEAF_ID,
              expandedLeafId: null,
              ptyIdsByLeafId: { [LEAF_ID]: 'remote:env-1:pty-3' }
            }
          }
        })
      )
    ).toBe(false)
  })
})

describe('restored spawn hold deadline', () => {
  it('outlasts the session.tabs timeout it waits on', () => {
    // A reply at 12s must not lose to a fail-open at 10s.
    expect(RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS).toBeGreaterThan(WEB_SESSION_TABS_RPC_TIMEOUT_MS)
    expect(RESTORED_TERMINAL_SPAWN_HOLD_MAX_TOTAL_MS).toBeGreaterThanOrEqual(
      RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS
    )
  })
})

describe('planRestoredTerminalSpawnHold', () => {
  it('arms only on the activation pass', () => {
    expect([...plan().heldTabIds]).toEqual(['row-1', 'row-2'])
    expect([...plan({ isColdActivationPass: false }).heldTabIds]).toEqual([])
  })

  it('never holds a carve-out row', () => {
    expect([...plan({ immediateTabIds: new Set(['row-1']) }).heldTabIds]).toEqual(['row-2'])
    expect([...plan({ isTabLive: (tabId) => tabId === 'row-1' }).heldTabIds]).toEqual(['row-2'])
    expect([...plan({ hasMountedTab: (tabId) => tabId === 'row-1' }).heldTabIds]).toEqual(['row-2'])
    expect([...plan({ wouldSpawnHostTerminal: (tab) => tab.id !== 'row-1' }).heldTabIds]).toEqual([
      'row-2'
    ])
  })

  it('holds nothing on a local, ssh or folder workspace', () => {
    // Those resolve no runtime environment, so the hold can never scope itself.
    const holdByWorktreeId = new Map<string, RestoredSpawnHoldEntry>()
    const result = plan({ holdByWorktreeId, environmentId: null })
    expect(result.heldTabIds.size).toBe(0)
    expect(holdByWorktreeId.size).toBe(0)
  })

  it('arms before any probe has landed and settles when the answer arrives', () => {
    // Slow startup: workspaceSessionReady is true while runtimeStatus is absent.
    const holdByWorktreeId = new Map<string, RestoredSpawnHoldEntry>()
    const armed = plan({ holdByWorktreeId, answer: { connection: '', answered: false } })
    expect([...armed.heldTabIds]).toEqual(['row-1', 'row-2'])
    plan({ holdByWorktreeId, answer: ANSWERED, isColdActivationPass: false, nowMs: 2_000 })
    expect(holdByWorktreeId.get(WORKTREE_ID)?.settled).toBe(true)
  })

  it('survives a probe blip instead of releasing the rows it holds', () => {
    const holdByWorktreeId = new Map<string, RestoredSpawnHoldEntry>()
    plan({ holdByWorktreeId })
    const blipped = plan({
      holdByWorktreeId,
      answer: { connection: '', answered: false },
      isColdActivationPass: false,
      nowMs: 2_000
    })
    expect([...blipped.heldTabIds]).toEqual(['row-1', 'row-2'])
    // The lost connection does not restart the clock, so silence still fails open.
    const timedOut = plan({
      holdByWorktreeId,
      answer: { connection: '', answered: false },
      isColdActivationPass: false,
      nowMs: 1_000 + RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS
    })
    expect([...timedOut.heldTabIds]).toEqual([])
  })

  it('settles at once on evidence already accepted for this connection', () => {
    // Reactivating a worktree the host answered for must not run the storm late.
    const holdByWorktreeId = new Map<string, RestoredSpawnHoldEntry>()
    plan({ holdByWorktreeId, answer: ANSWERED })
    expect(holdByWorktreeId.get(WORKTREE_ID)?.settled).toBe(true)
    const later = plan({
      holdByWorktreeId,
      answer: ANSWERED,
      isColdActivationPass: false,
      nowMs: 1_000_000
    })
    expect([...later.heldTabIds]).toEqual(['row-1', 'row-2'])
  })

  it('ignores evidence stamped with a previous connection', () => {
    const holdByWorktreeId = new Map<string, RestoredSpawnHoldEntry>()
    // answered:false is what the sync reports once the generation moved on.
    plan({ holdByWorktreeId, answer: { connection: NEXT_CONNECTION, answered: false } })
    expect(holdByWorktreeId.get(WORKTREE_ID)?.settled).toBe(false)
    const timedOut = plan({
      holdByWorktreeId,
      answer: { connection: NEXT_CONNECTION, answered: false },
      isColdActivationPass: false,
      nowMs: 1_000 + RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS
    })
    expect([...timedOut.heldTabIds]).toEqual([])
  })

  it('releases and reports the rows it let go when the workspace stops being paired', () => {
    const holdByWorktreeId = new Map<string, RestoredSpawnHoldEntry>()
    plan({ holdByWorktreeId })
    const released = plan({ holdByWorktreeId, environmentId: null })
    expect([...released.releasedTabIds]).toEqual(['row-1', 'row-2'])
    expect(holdByWorktreeId.has(WORKTREE_ID)).toBe(false)
  })

  it('fails open when no answer arrives before the deadline', () => {
    const holdByWorktreeId = new Map<string, RestoredSpawnHoldEntry>()
    plan({ holdByWorktreeId })
    const timedOut = plan({
      holdByWorktreeId,
      isColdActivationPass: false,
      nowMs: 1_000 + RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS
    })
    expect([...timedOut.heldTabIds]).toEqual([])
    expect([...timedOut.releasedTabIds]).toEqual(['row-1', 'row-2'])
  })

  it('gives a reconnect a fresh window but never waits past the ceiling', () => {
    const holdByWorktreeId = new Map<string, RestoredSpawnHoldEntry>()
    plan({ holdByWorktreeId })
    // A flapping runtime reconnects faster than the window ever expires, so only
    // the ceiling can end this hold.
    const step = RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS / 2
    const flap = (generation: number): ReturnType<typeof plan> =>
      plan({
        holdByWorktreeId,
        answer: { connection: `rt-1#${generation}`, answered: false },
        isColdActivationPass: false,
        nowMs: 1_000 + step * (generation - 1)
      })
    expect([...flap(2).heldTabIds]).toEqual(['row-1', 'row-2'])
    expect(holdByWorktreeId.get(WORKTREE_ID)?.windowStartedAtMs).toBe(1_000 + step)
    for (let generation = 3; generation <= 6; generation++) {
      expect([...flap(generation).heldTabIds]).toEqual(['row-1', 'row-2'])
    }
    expect([...flap(7).heldTabIds]).toEqual([])
  })

  it('carries a settled verdict across a reconnect', () => {
    // A local row the host never knew about cannot become host-owned on reconnect.
    const holdByWorktreeId = new Map<string, RestoredSpawnHoldEntry>()
    plan({ holdByWorktreeId, answer: ANSWERED })
    const afterReconnect = plan({
      holdByWorktreeId,
      answer: { connection: NEXT_CONNECTION, answered: false },
      isColdActivationPass: false,
      nowMs: 1_000_000
    })
    expect([...afterReconnect.heldTabIds]).toEqual(['row-1', 'row-2'])
  })
})

describe('applyRestoredTerminalSpawnHold', () => {
  it('removes held rows from the allowed set and lists them as deferred', () => {
    const restrictions = new Map<string, ReadonlySet<string>>()
    const deferredMountTabIdsByWorktree = new Map<string, ReadonlySet<string>>()
    applyRestoredTerminalSpawnHold({
      restrictions,
      deferredMountTabIdsByWorktree,
      worktreeId: WORKTREE_ID,
      allTabIds: ['row-1', 'row-2'],
      plan: { heldTabIds: new Set(['row-2']), releasedTabIds: new Set() }
    })
    expect([...(restrictions.get(WORKTREE_ID) ?? [])]).toEqual(['row-1'])
    expect([...(deferredMountTabIdsByWorktree.get(WORKTREE_ID) ?? [])]).toEqual(['row-2'])
  })

  it('puts released rows back and drops the restriction once nothing is deferred', () => {
    const restrictions = new Map<string, ReadonlySet<string>>([[WORKTREE_ID, new Set(['row-1'])]])
    const deferredMountTabIdsByWorktree = new Map<string, ReadonlySet<string>>([
      [WORKTREE_ID, new Set(['row-2'])]
    ])
    applyRestoredTerminalSpawnHold({
      restrictions,
      deferredMountTabIdsByWorktree,
      worktreeId: WORKTREE_ID,
      allTabIds: ['row-1', 'row-2'],
      plan: { heldTabIds: new Set(), releasedTabIds: new Set(['row-2']) }
    })
    expect(restrictions.has(WORKTREE_ID)).toBe(false)
    expect(deferredMountTabIdsByWorktree.has(WORKTREE_ID)).toBe(false)
  })

  it('leaves an unrelated restriction untouched when nothing is held or released', () => {
    const restrictions = new Map<string, ReadonlySet<string>>([[WORKTREE_ID, new Set(['row-1'])]])
    applyRestoredTerminalSpawnHold({
      restrictions,
      deferredMountTabIdsByWorktree: new Map(),
      worktreeId: WORKTREE_ID,
      allTabIds: ['row-1', 'row-2'],
      plan: { heldTabIds: new Set(), releasedTabIds: new Set() }
    })
    expect([...(restrictions.get(WORKTREE_ID) ?? [])]).toEqual(['row-1'])
  })
})
