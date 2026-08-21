/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { ConfirmationDialogContext } from '../confirmation-dialog-context'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import {
  acceptReplayedWebSessionTabsSnapshot,
  applyFreshWebSessionTabsSnapshots,
  recordAppliedWebSessionTabsInventory,
  resetWebSessionTabsSnapshotFreshnessForTests
} from '../../runtime/web-session-tabs-sync'
import { RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS } from './restored-terminal-spawn-hold'

// Why a marker: the oracle is which tabs Terminal.tsx actually instantiates a
// pane for. A helper-level assertion would still pass with the wiring deleted.
vi.mock('../terminal-pane/TerminalPane', () => ({
  default: ({ tabId }: { tabId: string }) => <div data-mounted-tab={tabId} />
}))
// The tab strip needs app-level providers and decides nothing about mounting.
vi.mock('../tab-bar/TabBar', () => ({ default: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Terminal reaches for a wide slice of window.api on mount; none of it decides
 *  mounting, so every member answers as an inert callable. */
function inertApi(): unknown {
  return new Proxy(function (): void {}, {
    get: (_target, property) => (typeof property === 'symbol' ? undefined : inertApi()),
    apply: () => inertApi()
  })
}

const WORKTREE_ID = 'wt-paired'
const OTHER_WORKTREE_ID = 'wt-other'
const ENVIRONMENT_ID = 'env-1'
const SPAWNING_TAB_IDS = ['row-1', 'row-2', 'row-3', 'row-4', 'row-5']
/** The mirrored and pty-owning rows attach instead of spawning; the pre-existing
 *  coverage deferral independently decides those, so the oracle is the spawn
 *  class alone — exactly the rows this gate governs. */
/** The seeded workspace has no active tab, so useActiveTerminalRepair selects the
 *  first row — and the visible tab is never withheld. */
const SHOWN_ONLY = ['row-1']

function terminalTab(id: string, worktreeId = WORKTREE_ID): TerminalTab {
  return {
    id,
    worktreeId,
    title: id,
    ptyId: null,
    createdAt: 0,
    sortOrder: 0
  } as unknown as TerminalTab
}

/** The persisted rows of a paired workspace reopened after a restart: five
 *  local-uuid rows with no pty anywhere (the spawn class), one mirrored row and
 *  one row whose layout leaf still owns a remote pty (both attach instead). */
const RESTORED_TABS: TerminalTab[] = [
  ...SPAWNING_TAB_IDS.map((id) => terminalTab(id)),
  terminalTab('web-terminal-mirrored'),
  terminalTab('row-adoptable')
]

function hostSnapshot(
  worktree: string,
  overrides: Partial<RuntimeMobileSessionTabsResult> = {}
): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [],
    ...overrides
  }
}

/** Drives the shipping accept path, so only frames the store really took count. */
function applyHostSnapshots(
  snapshots: readonly RuntimeMobileSessionTabsResult[],
  environmentId = ENVIRONMENT_ID
): void {
  const patch = applyFreshWebSessionTabsSnapshots(
    useAppStore.getState() as never,
    snapshots,
    environmentId
  )
  useAppStore.setState(patch as never)
}

/** One subscribed worktree's frame: it speaks for that worktree and no other. */
function deliverHostFrame(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId = ENVIRONMENT_ID
): void {
  applyHostSnapshots([snapshot], environmentId)
}

/** The listAll/subscribeAll shape: apply, then record the enumeration, in the
 *  order the shipping inventory paths do it. */
function deliverHostInventory(snapshots: readonly RuntimeMobileSessionTabsResult[]): void {
  applyHostSnapshots(snapshots)
  recordAppliedWebSessionTabsInventory(ENVIRONMENT_ID)
}

/** A reconnect can repeat the frame the client already holds; the shipping
 *  stream arms the replay before offering it to the accept path. */
function deliverReplayedHostFrame(snapshot: RuntimeMobileSessionTabsResult): void {
  acceptReplayedWebSessionTabsSnapshot(ENVIRONMENT_ID, snapshot.worktree)
  applyHostSnapshots([snapshot])
}

async function reconnect(connectionGeneration: number): Promise<void> {
  await act(async () => {
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([
        [ENVIRONMENT_ID, { status: { runtimeId: 'rt-1' }, checkedAt: 0, connectionGeneration }]
      ])
    } as never)
  })
}

function seedStore(
  overrides: {
    runtimeStatus?: { status: unknown; checkedAt: number; connectionGeneration?: number } | null
    activeTabId?: string | null
    activeWorktreeId?: string
    pendingStartupByTabId?: Record<string, unknown>
    /** Runtime environment that owns the worktree under test. */
    hostId?: string
    /** Further environments that are paired and live at the same time. */
    alsoLiveEnvironmentIds?: readonly string[]
  } = {}
): void {
  const runtimeStatus =
    overrides.runtimeStatus === undefined
      ? { status: { runtimeId: 'rt-1' }, checkedAt: 0, connectionGeneration: 1 }
      : overrides.runtimeStatus
  const runtimeStatusByEnvironmentId = new Map<string, unknown>(
    runtimeStatus ? [[ENVIRONMENT_ID, runtimeStatus]] : []
  )
  for (const environmentId of overrides.alsoLiveEnvironmentIds ?? []) {
    runtimeStatusByEnvironmentId.set(environmentId, {
      status: { runtimeId: `rt-${environmentId}` },
      checkedAt: 0,
      connectionGeneration: 1
    })
  }
  useAppStore.setState({
    worktreesByRepo: {
      'repo-1': [
        {
          id: WORKTREE_ID,
          repoId: 'repo-1',
          path: '/tmp/wt',
          hostId: overrides.hostId ?? `runtime:${ENVIRONMENT_ID}`
        },
        {
          id: OTHER_WORKTREE_ID,
          repoId: 'repo-1',
          path: '/tmp/wt-other',
          hostId: `runtime:${ENVIRONMENT_ID}`
        }
      ]
    },
    folderWorkspaces: [],
    activeWorktreeId: overrides.activeWorktreeId ?? WORKTREE_ID,
    activeWorkspaceExecutionHostId: null,
    activeView: 'terminal',
    activeTabType: 'terminal',
    activeTabId: overrides.activeTabId === undefined ? null : overrides.activeTabId,
    activeTabIdByWorktree: {},
    tabsByWorktree: { [WORKTREE_ID]: RESTORED_TABS, [OTHER_WORKTREE_ID]: [] },
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    activeGroupIdByWorktree: {},
    terminalLayoutsByTabId: {
      'row-adoptable': {
        ptyIdsByLeafId: { '11111111-1111-4111-8111-111111111111': `remote:${ENVIRONMENT_ID}:pty-9` }
      }
    },
    pendingStartupByTabId: overrides.pendingStartupByTabId ?? {},
    openFiles: [],
    browserTabsByWorktree: {},
    workspaceSessionReady: true,
    hydrationSucceeded: true,
    startupWorktreeRefreshCompleted: true,
    runtimeStatusByEnvironmentId
  } as never)
}

const confirmStub = async (): Promise<boolean> => true

let root: Root | null = null
let host: HTMLDivElement | null = null

async function renderTerminal(): Promise<HTMLDivElement> {
  const { default: Terminal } = await import('@/components/Terminal')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(
      <ConfirmationDialogContext.Provider value={confirmStub}>
        <Terminal />
      </ConfirmationDialogContext.Provider>
    )
  })
  return host
}

function mountedTabIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-mounted-tab]')]
    .map((node) => node.getAttribute('data-mounted-tab') ?? '')
    .sort()
}

/** Mounting one of these issues terminal.create against the paired host. */
function mountedSpawnRows(container: HTMLElement): string[] {
  return mountedTabIds(container).filter((tabId) => SPAWNING_TAB_IDS.includes(tabId))
}

async function advancePastDeadline(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS + 1_000)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  resetWebSessionTabsSnapshotFreshnessForTests()
  ;(window as unknown as { api: unknown }).api = inertApi()
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  vi.useRealTimers()
})

describe('Terminal restored spawn hold (render seam)', () => {
  it('withholds restored pty-less rows on a paired worktree until the host answers', async () => {
    seedStore()
    const container = await renderTerminal()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
  })

  it('always mounts the active tab and any queued startup, even while holding', async () => {
    seedStore({ activeTabId: 'row-1', pendingStartupByTabId: { 'row-2': { command: 'echo hi' } } })
    const container = await renderTerminal()
    // row-1 is visible and row-2 has a startup command with nowhere else to run.
    expect(mountedSpawnRows(container)).toEqual(['row-1', 'row-2'])
  })

  it('mounts the attach-class rows the gate does not govern', async () => {
    seedStore()
    const container = await renderTerminal()
    // Mirrored and pty-owning rows cannot spawn, so holding them buys nothing.
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
    expect(mountedTabIds(container)).toContain('web-terminal-mirrored')
    expect(mountedTabIds(container)).toContain('row-adoptable')
  })

  it('does not blank a paired workspace whose runtime is merely disconnected', async () => {
    // A failed probe stores status null: a reachable id, no liveness. The gate
    // still arms — a probe blip must not spend the only cold pass — but the
    // workspace keeps its visible pane and fails open on its own.
    seedStore({ runtimeStatus: { status: null, checkedAt: 0, connectionGeneration: 1 } })
    const container = await renderTerminal()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SPAWNING_TAB_IDS)
  })

  it('holds when no probe has landed yet and settles once the answer arrives', async () => {
    // Slow start: workspaceSessionReady is true before any status exists.
    seedStore({ runtimeStatus: null })
    const container = await renderTerminal()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
    await reconnect(1)
    deliverHostFrame(hostSnapshot(WORKTREE_ID))
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
  })

  it('waits on the environment that owns the worktree, not any live one', async () => {
    seedStore({ hostId: 'runtime:env-2', alsoLiveEnvironmentIds: ['env-2'] })
    const container = await renderTerminal()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
    // An answer from the other paired environment says nothing about this one.
    deliverHostFrame(hostSnapshot(WORKTREE_ID), ENVIRONMENT_ID)
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SPAWNING_TAB_IDS)
  })

  it('settles on an answer from the environment that owns the worktree', async () => {
    seedStore({ hostId: 'runtime:env-2', alsoLiveEnvironmentIds: ['env-2'] })
    const container = await renderTerminal()
    deliverHostFrame(hostSnapshot(WORKTREE_ID), 'env-2')
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
  })

  it('fails open and mounts held rows when no answer ever arrives', async () => {
    seedStore()
    const container = await renderTerminal()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SPAWNING_TAB_IDS)
  })

  it('keeps rows dark past the deadline once an empty snapshot proves them dead', async () => {
    seedStore()
    const container = await renderTerminal()
    // The answer patches no held row into the store; only a later render sees it.
    deliverHostFrame(hostSnapshot(WORKTREE_ID))
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
  })

  it('settles on a full inventory that covers the worktree', async () => {
    seedStore()
    const container = await renderTerminal()
    deliverHostInventory([hostSnapshot(OTHER_WORKTREE_ID), hostSnapshot(WORKTREE_ID)])
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
  })

  it('settles on a full inventory that omits the worktree', async () => {
    // An inventory enumerates every worktree the host knows, so omission is an
    // answer too: these rows exist on no host session.
    seedStore()
    const container = await renderTerminal()
    deliverHostInventory([hostSnapshot(OTHER_WORKTREE_ID)])
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
  })

  it('does not settle on a single frame published for another worktree', async () => {
    seedStore()
    const container = await renderTerminal()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
    deliverHostFrame(hostSnapshot(OTHER_WORKTREE_ID))
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SPAWNING_TAB_IDS)
  })

  it('settles on a reconnect replay of the frame it already held', async () => {
    // Identity repeats across a reconnect; the receipt does not.
    seedStore()
    deliverHostFrame(hostSnapshot(WORKTREE_ID))
    const container = await renderTerminal()
    await reconnect(2)
    deliverReplayedHostFrame(hostSnapshot(WORKTREE_ID))
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
  })

  it('does not carry an answer from the previous connection into a new hold', async () => {
    seedStore()
    const container = await renderTerminal()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
    // The answer lands with no render in between, then the connection is replaced.
    deliverHostFrame(hostSnapshot(WORKTREE_ID))
    await reconnect(2)
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SPAWNING_TAB_IDS)
  })

  it('settles on evidence this connection already accepted before the hold armed', async () => {
    // Reopening a workspace the host answered for must not run the storm late.
    seedStore()
    deliverHostFrame(hostSnapshot(WORKTREE_ID))
    const container = await renderTerminal()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
  })

  it('never re-holds rows a previous activation already mounted', async () => {
    seedStore()
    const container = await renderTerminal()
    expect(mountedSpawnRows(container)).toEqual(SHOWN_ONLY)
    await advancePastDeadline()
    expect(mountedSpawnRows(container)).toEqual(SPAWNING_TAB_IDS)
    // Reconnect, then leave and re-enter so a fresh activation pass runs.
    await act(async () => {
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([
          [ENVIRONMENT_ID, { status: { runtimeId: 'rt-1' }, checkedAt: 0, connectionGeneration: 2 }]
        ]),
        activeWorktreeId: OTHER_WORKTREE_ID
      } as never)
    })
    await act(async () => {
      useAppStore.setState({ activeWorktreeId: WORKTREE_ID } as never)
    })
    expect(mountedSpawnRows(container)).toEqual(SPAWNING_TAB_IDS)
  })
})
