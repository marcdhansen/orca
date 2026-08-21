// @vitest-environment happy-dom

/**
 * Parked waiters drain synchronously, so a settle placed before its frame's
 * patch reaches the store re-runs recovery while ptyIdsByTabId is still empty
 * — the pane reads as dead and the duplicate `codex resume` fires anyway.
 * These drive the real handlers because that ordering is the thing under test.
 *
 * The second block pins the other half: this latch releases into replaying a
 * resume, so `unverifiable` must not read as `exited` and settle anything.
 */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type * as WebRuntimeSessionModule from './web-runtime-session'

const mocks = vi.hoisted(() => ({
  createTerminal: vi.fn(),
  recoverSnapshot: vi.fn(),
  runtimeSessionMirrorEnvironmentKey: vi.fn()
}))

vi.mock('./use-runtime-session-mirror-environment-key', () => ({
  useRuntimeSessionMirrorEnvironmentKey: mocks.runtimeSessionMirrorEnvironmentKey
}))

vi.mock('./web-session-terminal-orphan-recovery', () => ({
  recoverWebSessionTerminalOrphansBeforeApply: mocks.recoverSnapshot
}))

vi.mock('./web-runtime-session', async (importOriginal) => {
  const actual = await importOriginal<typeof WebRuntimeSessionModule>()
  return { ...actual, createWebRuntimeSessionTerminal: mocks.createTerminal }
})

import { useAppStore, type AppState } from '@/store'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { resumeSleepingAgentSessionsForWorktree } from '@/lib/resume-sleeping-agent-session'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { resetHostSessionMirrorHydrationForTests } from './host-session-mirror-hydration'
import {
  resetWebSessionTabsSnapshotFreshnessForTests,
  useWebSessionTabsSync
} from './web-session-tabs-sync'

const ENV = 'env-abfee683'
const REPO_ID = 'repo-1'
const WT = `${REPO_ID}::/workspace/feature`
const BG_WT = `${REPO_ID}::/workspace/background`
const REVISION = 101
const MIRROR_KEY = `${ENV}\u0001runtime-a\u00011\u0001${REVISION}`

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const HOST_PARENT_TAB_ID = 'host-tab-1'
const HOST_SURFACE_ID = `${HOST_PARENT_TAB_ID}::${LEAF_ID}`
// The mirror names its local tab after the host PARENT tab, not the surface id.
const MIRROR_TAB_ID = toWebTerminalSurfaceTabId(HOST_PARENT_TAB_ID)
const HOST_PTY_ID = `remote:${ENV}@@terminal-1`

const BG_MIRROR_TAB_ID = toWebTerminalSurfaceTabId('host-tab-2')

// A host tab that is NOT the parked mirror: publishing it retracts MIRROR_TAB_ID,
// which is the host answering "that pane is gone" rather than staying silent.
const OTHER_HOST_PARENT_TAB_ID = 'host-tab-9'
const OTHER_HOST_SURFACE_ID = `${OTHER_HOST_PARENT_TAB_ID}::${LEAF_ID}`

const initialState = useAppStore.getInitialState()

type RuntimeSubscribe = typeof window.api.runtimeEnvironments.subscribe
type RuntimeSubscription = {
  request: Parameters<RuntimeSubscribe>[0]
  callbacks: Parameters<RuntimeSubscribe>[1]
}

const subscriptions: RuntimeSubscription[] = []
// Why: a resolved listAll would settle the mirror on its own and hide the race.
const runtimeCall = vi.fn((_request: { method: string }) => new Promise(() => {}))
const runtimeSubscribe = vi.fn<RuntimeSubscribe>(async (request, callbacks) => {
  subscriptions.push({ request, callbacks })
  return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
})

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function makeWorktree(id: string, path: string): AppState['worktreesByRepo'][string][number] {
  return {
    id,
    repoId: REPO_ID,
    path,
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: path,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    // The workspace is owned by the paired runtime — the incident shape.
    hostId: `runtime:${encodeURIComponent(ENV)}`
  } as never
}

/** A host frame publishing one ready terminal surface backed by a live PTY. */
function makeHostSnapshot(
  worktree: string,
  hostSurfaceId: string,
  parentTabId: string
): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'host-group-1',
    activeTabId: hostSurfaceId,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: hostSurfaceId,
        title: 'Codex',
        parentTabId,
        leafId: LEAF_ID,
        isActive: true,
        launchAgent: 'codex',
        status: 'ready',
        terminal: 'terminal-1'
      }
    ]
  } as never
}

function mirrorTabRow(tabId: string, worktreeId: string): unknown {
  return { id: tabId, title: 'Codex', ptyId: null, worktreeId }
}

function seedState(): void {
  const runtimeEnvironments = [
    { id: ENV, createdAt: 100, pairingRevision: REVISION }
  ] as PublicKnownRuntimeEnvironment[]
  replaceRuntimeEnvironmentRevisions(runtimeEnvironments)
  const worktrees = [
    makeWorktree(WT, '/workspace/feature'),
    makeWorktree(BG_WT, '/workspace/background')
  ]
  useAppStore.setState(
    {
      ...initialState,
      repos: [
        {
          id: REPO_ID,
          path: '/workspace/repo',
          displayName: 'repo',
          badgeColor: '#000',
          addedAt: 0
        }
      ],
      worktreesByRepo: { [REPO_ID]: worktrees },
      activeRepoId: REPO_ID,
      activeWorktreeId: WT,
      activeView: 'terminal',
      workspaceSessionReady: true,
      runtimeEnvironments,
      runtimeStatusByEnvironmentId: new Map([
        [ENV, { status: { runtimeId: 'runtime-a' }, connectionGeneration: 1 }]
      ]) as AppState['runtimeStatusByEnvironmentId'],
      // Mirror rows the host published before the app restarted; no live PTY
      // handles yet, which is precisely why liveness is unknowable right now.
      tabsByWorktree: {
        [WT]: [mirrorTabRow(MIRROR_TAB_ID, WT)],
        [BG_WT]: [mirrorTabRow(BG_MIRROR_TAB_ID, BG_WT)]
      },
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {
        [MIRROR_TAB_ID]: {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          ptyIdsByLeafId: { [LEAF_ID]: 'pty-host-old-1' }
        },
        [BG_MIRROR_TAB_ID]: {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          ptyIdsByLeafId: { [LEAF_ID]: 'pty-host-old-2' }
        }
      },
      settings: { agentCmdOverrides: {}, setupScriptLaunchMode: 'new-tab' }
    } as never,
    true
  )
}

function seedSleepingRecord(tabId: string, worktreeId: string, sessionId: string): string {
  const paneKey = makePaneKey(tabId, LEAF_ID)
  useAppStore.setState((s) => ({
    sleepingAgentSessionsByPaneKey: {
      ...s.sleepingAgentSessionsByPaneKey,
      [paneKey]: {
        paneKey,
        tabId,
        worktreeId,
        agent: 'codex' as const,
        providerSession: { key: 'session_id' as const, id: sessionId },
        prompt: 'keep working',
        state: 'working' as const,
        origin: 'live' as const,
        capturedAt: 1000,
        updatedAt: 1000,
        terminalTitle: 'Codex'
      }
    }
  }))
  return paneKey
}

function findSubscription(method: string): RuntimeSubscription {
  const subscription = subscriptions.find(({ request }) => request.method === method)
  if (!subscription) {
    throw new Error(`Missing ${method} subscription`)
  }
  return subscription
}

async function publish(subscription: RuntimeSubscription, result: unknown): Promise<void> {
  await act(async () => {
    subscription.callbacks.onResponse({
      id: 'subscription-event',
      ok: true as const,
      result,
      _meta: { runtimeId: 'runtime-a' }
    } as never)
    await settle()
  })
}

function tabIds(worktreeId: string): string[] {
  return (useAppStore.getState().tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
}

/** A drained waiter has to land a claiming replacement tab; a replay that only
 *  consumed the record launched nothing. */
function expectReplayedResume(paneKey: string, worktreeId: string, sessionId: string): void {
  const state = useAppStore.getState()
  expect(state.sleepingAgentSessionsByPaneKey[paneKey]).toBeUndefined()
  const claimedTabIds = Object.keys(state.automaticAgentResumeClaimsByTabId)
  expect(claimedTabIds).toHaveLength(1)
  const replacementTabId = claimedTabIds[0]!
  expect(replacementTabId).not.toBe(MIRROR_TAB_ID)
  expect(tabIds(worktreeId)).toContain(replacementTabId)
  expect(state.automaticAgentResumeClaimsByTabId[replacementTabId]).toMatchObject({
    launchAgent: 'codex',
    providerSession: { key: 'session_id', id: sessionId }
  })
}

describe('mirrored-pane resume deferral against real stream frames', () => {
  beforeEach(() => {
    subscriptions.length = 0
    runtimeCall.mockClear().mockImplementation(() => new Promise(() => {}))
    runtimeSubscribe.mockClear()
    mocks.createTerminal.mockReset().mockResolvedValue(undefined)
    mocks.recoverSnapshot.mockReset().mockImplementation(async (_state, snapshot) => snapshot)
    mocks.runtimeSessionMirrorEnvironmentKey.mockReset().mockReturnValue(MIRROR_KEY)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetHostSessionMirrorHydrationForTests()
    seedState()
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    replaceRuntimeEnvironmentRevisions([])
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetHostSessionMirrorHydrationForTests()
  })

  it('does not relaunch when a stream frame is the first hydration signal', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-ordering-1')

    // Nothing has hydrated yet, so the sweep must park rather than relaunch.
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)
    expect(tabIds(WT)).toEqual([MIRROR_TAB_ID])

    // The host answers on the stream, before listAll ever resolves. The frame
    // says this pane's PTY is alive; the replay must see that, not the empty
    // handle map that existed when the frame arrived.
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshots',
      snapshots: [makeHostSnapshot(WT, HOST_SURFACE_ID, 'host-tab-1')]
    })

    expect(useAppStore.getState().ptyIdsByTabId[MIRROR_TAB_ID]).toEqual([HOST_PTY_ID])
    // RED before the ordering fix: the drain ran while ptyIdsByTabId was still
    // empty, so a second `codex resume` tab was appended here.
    expect(tabIds(WT)).toEqual([MIRROR_TAB_ID])
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(Object.keys(useAppStore.getState().automaticAgentResumeClaimsByTabId)).toHaveLength(0)
  })

  it('a single-worktree frame does not release panes parked on another worktree', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const backgroundPaneKey = seedSleepingRecord(BG_MIRROR_TAB_ID, BG_WT, 'codex-session-bg-1')

    expect(resumeSleepingAgentSessionsForWorktree(BG_WT)).toBe(0)

    // The active worktree's scoped mirror answers. It says nothing whatsoever
    // about the background workspace, so that pane must stay parked.
    await publish(findSubscription('session.tabs.subscribe'), {
      type: 'snapshot',
      ...makeHostSnapshot(WT, HOST_SURFACE_ID, 'host-tab-1')
    })

    expect(tabIds(BG_WT)).toEqual([BG_MIRROR_TAB_ID])
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[backgroundPaneKey]).toBeDefined()

    // A full inventory DOES speak for every worktree, including by omission.
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshots',
      snapshots: [makeHostSnapshot(WT, HOST_SURFACE_ID, 'host-tab-1')]
    })

    // The background mirror tab was retracted by the inventory, so recovery is
    // finally justified: the record is consumed INTO a replacement tab that
    // claims the session. Asserting only the record would pass for a replay
    // that cleared it and launched nothing.
    const replayed = useAppStore.getState()
    expect(replayed.sleepingAgentSessionsByPaneKey[backgroundPaneKey]).toBeUndefined()
    const backgroundTabIds = tabIds(BG_WT)
    expect(backgroundTabIds).toHaveLength(1)
    expect(backgroundTabIds[0]).not.toBe(BG_MIRROR_TAB_ID)
    expect(replayed.automaticAgentResumeClaimsByTabId[backgroundTabIds[0]!]).toMatchObject({
      launchAgent: 'codex',
      providerSession: { key: 'session_id', id: 'codex-session-bg-1' }
    })
  })

  // The three tests below pin the remaining release sites one frame at a time:
  // each delivers ONLY its own path's frame, so a release that stops happening
  // there cannot be covered for by another handler.
  it('the initial listAll releases the pane it parked', async () => {
    let resolveListAll: (response: unknown) => void = () => {}
    runtimeCall.mockImplementation((request: { method: string }) =>
      request.method === 'session.tabs.listAll'
        ? new Promise((resolve) => {
            resolveListAll = resolve
          })
        : new Promise(() => {})
    )
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-listall-release')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)

    // The inventory retracts the mirror tab, so the host HAS spoken: this pane
    // is gone and the resume it parked is finally justified.
    await act(async () => {
      resolveListAll({
        id: 'listall',
        ok: true as const,
        result: {
          snapshots: [makeHostSnapshot(WT, OTHER_HOST_SURFACE_ID, OTHER_HOST_PARENT_TAB_ID)]
        },
        _meta: { runtimeId: 'runtime-a' }
      })
      await settle()
    })

    expect(tabIds(WT)).not.toContain(MIRROR_TAB_ID)
    expectReplayedResume(paneKey, WT, 'codex-session-listall-release')
  })

  it('a single frame on the global stream releases the pane it parked', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-global-frame')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)

    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshot',
      ...makeHostSnapshot(WT, OTHER_HOST_SURFACE_ID, OTHER_HOST_PARENT_TAB_ID)
    })

    expect(tabIds(WT)).not.toContain(MIRROR_TAB_ID)
    expectReplayedResume(paneKey, WT, 'codex-session-global-frame')
  })

  it('the active-worktree scoped frame releases the pane it parked', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-scoped-frame')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)

    await publish(findSubscription('session.tabs.subscribe'), {
      type: 'snapshot',
      ...makeHostSnapshot(WT, OTHER_HOST_SURFACE_ID, OTHER_HOST_PARENT_TAB_ID)
    })

    expect(tabIds(WT)).not.toContain(MIRROR_TAB_ID)
    expectReplayedResume(paneKey, WT, 'codex-session-scoped-frame')
  })
})

describe('mirror latch verdicts against real stream failures', () => {
  beforeEach(() => {
    subscriptions.length = 0
    runtimeCall.mockClear().mockImplementation(() => new Promise(() => {}))
    runtimeSubscribe.mockClear()
    mocks.createTerminal.mockReset().mockResolvedValue(undefined)
    mocks.recoverSnapshot.mockReset().mockImplementation(async (_state, snapshot) => snapshot)
    mocks.runtimeSessionMirrorEnvironmentKey.mockReset().mockReturnValue(MIRROR_KEY)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetHostSessionMirrorHydrationForTests()
    seedState()
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    replaceRuntimeEnvironmentRevisions([])
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetHostSessionMirrorHydrationForTests()
  })

  it('a rejected inventory keeps a parked pane parked', async () => {
    let rejectListAll: (error: Error) => void = () => {}
    runtimeCall.mockImplementation((request: { method: string }) =>
      request.method === 'session.tabs.listAll'
        ? new Promise((_resolve, reject) => {
            rejectListAll = reject
          })
        : new Promise(() => {})
    )
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-listall-reject')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)

    // Contact is lost AFTER the pane parked. That is `unverifiable`, not proof
    // the host-owned PTY exited, so nothing may drain on it.
    await act(async () => {
      rejectListAll(new Error('relay disconnected'))
      await settle()
    })

    expect(tabIds(WT)).toEqual([MIRROR_TAB_ID])
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(Object.keys(useAppStore.getState().automaticAgentResumeClaimsByTabId)).toHaveLength(0)
  })

  it('a scoped stream error settles neither its own worktree nor another', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const activePaneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-active-error')
    const backgroundPaneKey = seedSleepingRecord(BG_MIRROR_TAB_ID, BG_WT, 'codex-session-bg-error')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)
    expect(resumeSleepingAgentSessionsForWorktree(BG_WT)).toBe(0)

    await act(async () => {
      findSubscription('session.tabs.subscribe').callbacks.onError?.({
        message: 'stream closed'
      } as never)
      await settle()
    })

    const state = useAppStore.getState()
    expect(tabIds(WT)).toEqual([MIRROR_TAB_ID])
    expect(state.sleepingAgentSessionsByPaneKey[activePaneKey]).toBeDefined()
    expect(tabIds(BG_WT)).toEqual([BG_MIRROR_TAB_ID])
    expect(state.sleepingAgentSessionsByPaneKey[backgroundPaneKey]).toBeDefined()
    expect(Object.keys(state.automaticAgentResumeClaimsByTabId)).toHaveLength(0)
  })

  it('an inventory whose recovery drops a worktree settles only the applied ones', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const backgroundPaneKey = seedSleepingRecord(BG_MIRROR_TAB_ID, BG_WT, 'codex-session-bg-drop')
    expect(resumeSleepingAgentSessionsForWorktree(BG_WT)).toBe(0)

    // The background snapshot never reaches the store, so the pane it would
    // have published a PTY for is still unaccounted for.
    mocks.recoverSnapshot.mockImplementation(
      async (_state: unknown, snapshot: RuntimeMobileSessionTabsResult) =>
        snapshot.worktree === BG_WT ? null : snapshot
    )
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshots',
      snapshots: [
        makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID),
        makeHostSnapshot(BG_WT, `host-tab-2::${LEAF_ID}`, 'host-tab-2')
      ]
    })

    expect(useAppStore.getState().ptyIdsByTabId[MIRROR_TAB_ID]).toEqual([HOST_PTY_ID])
    expect(tabIds(BG_WT)).toEqual([BG_MIRROR_TAB_ID])
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[backgroundPaneKey]).toBeDefined()
  })
})
