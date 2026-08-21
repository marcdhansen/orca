import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateWebRuntimeSessionWorktree,
  refreshWebRuntimeSessionTabsSnapshot
} from './web-runtime-session'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import {
  confirmWebAgentSessionHandoffAfterCreate,
  isWebAgentSessionHandoffPostCreateSnapshotConfirmed,
  recordWebAgentSessionHandoff,
  resetWebAgentSessionHandoffsForTests
} from './web-agent-session-handoff'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import type { AppState } from '@/store/types'
import { ENVIRONMENT_ID, WORKTREE_ID, makeSnapshot } from './web-runtime-session-test-harness'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  setState: vi.fn(),
  subscribe: vi.fn(),
  setActiveWorktree: vi.fn(),
  createBrowserTab: vi.fn(),
  closeEmptyGroup: vi.fn(),
  moveUnifiedTabToGroup: vi.fn(),
  setRemoteBrowserPageHandle: vi.fn(),
  focusBrowserTabInWorktree: vi.fn(),
  applyFreshWebSessionTabsSnapshot: vi.fn(),
  acceptReplayedWebSessionTabsSnapshot: vi.fn(),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(),
  trackTerminalPaneSplit: vi.fn(),
  deliverLaunchPromptToAgentTab: vi.fn(),
  seedNativeChatLaunchDraftForAgentTab: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn(),
  hasMaterializedWebRuntimeBrowserPage: vi.fn(),
  listRemoteRuntimeSessionTabsDeduped: vi.fn(),
  listRemoteRuntimeSessionTabsAfterCurrentInFlight: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: mocks.setState,
    subscribe: mocks.subscribe
  }
}))

vi.mock('./web-session-tabs-sync', () => ({
  acceptReplayedWebSessionTabsSnapshot: mocks.acceptReplayedWebSessionTabsSnapshot,
  applyFreshWebSessionTabsSnapshot: mocks.applyFreshWebSessionTabsSnapshot,
  applyWebSessionTabsStorePatch: (buildPatch: (state: unknown) => unknown) =>
    mocks.setState(buildPatch),
  resolveHostSessionTabIdForWebSessionTab: mocks.resolveHostSessionTabIdForWebSessionTab
}))

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: mocks.trackTerminalPaneSplit
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree
}))

vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab: mocks.seedNativeChatLaunchDraftForAgentTab
}))

vi.mock('./web-runtime-browser-materialization', () => ({
  hasMaterializedWebRuntimeBrowserPage: mocks.hasMaterializedWebRuntimeBrowserPage
}))

vi.mock('./remote-runtime-session-tabs-inflight', () => ({
  listRemoteRuntimeSessionTabsDeduped: mocks.listRemoteRuntimeSessionTabsDeduped,
  listRemoteRuntimeSessionTabsAfterCurrentInFlight:
    mocks.listRemoteRuntimeSessionTabsAfterCurrentInFlight
}))

afterEach(() => resetWebSessionCloseIntentForTests())

describe('refreshWebRuntimeSessionTabsSnapshot', () => {
  beforeEach(() => {
    mocks.listRemoteRuntimeSessionTabsDeduped.mockImplementation(
      (args: { load: () => Promise<unknown> }) => args.load()
    )
    mocks.listRemoteRuntimeSessionTabsAfterCurrentInFlight.mockImplementation(
      (args: { load: () => Promise<unknown> }) => args.load()
    )
  })

  afterEach(() => {
    resetWebAgentSessionHandoffsForTests()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('snaps connection identity at request time and ignores later mutations', async () => {
    type SnapshotResponse = { id: string; ok: boolean; result: ReturnType<typeof makeSnapshot> }
    let resolveSnapshot!: (value: SnapshotResponse) => void
    const deferredSnapshot = new Promise<SnapshotResponse>((resolve) => {
      resolveSnapshot = resolve
    })
    mocks.setState.mockImplementation((updater: (state: unknown) => unknown) =>
      updater({ state: 'before' })
    )
    const runtimeCall = vi.fn().mockReturnValue(deferredSnapshot)
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })
    mocks.listRemoteRuntimeSessionTabsDeduped.mockImplementation(
      (args: { load: () => Promise<unknown> }) => args.load()
    )
    mocks.applyFreshWebSessionTabsSnapshot.mockImplementation((state) => state)
    mocks.getState.mockReturnValue({
      runtimeStatusByEnvironmentId: new Map([
        [ENVIRONMENT_ID, { status: { runtimeId: 'runtime-a' }, connectionGeneration: 1 }]
      ]) as AppState['runtimeStatusByEnvironmentId']
    })

    const refreshPromise = refreshWebRuntimeSessionTabsSnapshot(ENVIRONMENT_ID, WORKTREE_ID)

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledOnce())

    // Advance connection generation to 2 while the RPC is in-flight.
    const runtimeStatus = new Map([
      [ENVIRONMENT_ID, { status: { runtimeId: 'runtime-a' }, connectionGeneration: 1 }]
    ]) as AppState['runtimeStatusByEnvironmentId']
    runtimeStatus.get(ENVIRONMENT_ID)!.connectionGeneration = 2
    mocks.getState.mockReturnValue({ runtimeStatusByEnvironmentId: runtimeStatus })

    resolveSnapshot({ id: 'list', ok: true, result: makeSnapshot() })
    await refreshPromise

    expect(mocks.applyFreshWebSessionTabsSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      ENVIRONMENT_ID,
      expect.any(Number),
      'runtime-a#1'
    )
  })

  it('dedupes concurrent callers so joiner gets empty identity', async () => {
    const snapshot = makeSnapshot()
    mocks.setState.mockImplementation((updater: (state: unknown) => unknown) =>
      updater({ state: 'before' })
    )

    let resolveRpc!: (value: unknown) => void
    const deferredRpc = new Promise((resolve) => {
      resolveRpc = resolve
    })
    const runtimeCall = vi.fn().mockReturnValue(deferredRpc)
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    const gen1Status = new Map([
      [ENVIRONMENT_ID, { status: { runtimeId: 'runtime-a' }, connectionGeneration: 1 }]
    ]) as AppState['runtimeStatusByEnvironmentId']
    mocks.getState.mockReturnValue({ runtimeStatusByEnvironmentId: gen1Status })

    let resolveApplyDone!: () => void
    const applyDone = new Promise<void>((resolve) => {
      resolveApplyDone = resolve
    })
    let loadCount = 0
    mocks.listRemoteRuntimeSessionTabsDeduped.mockImplementation(
      (args: { load: () => Promise<unknown> }) => {
        loadCount++
        if (loadCount === 1) {
          return args.load()
        }
        return applyDone.then(() => snapshot)
      }
    )
    mocks.applyFreshWebSessionTabsSnapshot.mockImplementation((state) => {
      if (mocks.applyFreshWebSessionTabsSnapshot.mock.calls.length === 1) {
        resolveApplyDone()
      }
      return state
    })

    const caller1 = refreshWebRuntimeSessionTabsSnapshot(ENVIRONMENT_ID, WORKTREE_ID)
    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledOnce())

    const gen2Status = new Map([
      [ENVIRONMENT_ID, { status: { runtimeId: 'runtime-a' }, connectionGeneration: 2 }]
    ]) as AppState['runtimeStatusByEnvironmentId']
    mocks.getState.mockReturnValue({ runtimeStatusByEnvironmentId: gen2Status })

    const caller2 = refreshWebRuntimeSessionTabsSnapshot(ENVIRONMENT_ID, WORKTREE_ID)
    resolveRpc({ id: 'list', ok: true, result: snapshot })

    await Promise.all([caller1, caller2])

    expect(runtimeCall).toHaveBeenCalledOnce()
    expect(mocks.listRemoteRuntimeSessionTabsDeduped).toHaveBeenCalledTimes(2)
    expect(mocks.applyFreshWebSessionTabsSnapshot).toHaveBeenCalledTimes(2)
    expect(mocks.applyFreshWebSessionTabsSnapshot).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.anything(),
      ENVIRONMENT_ID,
      expect.any(Number),
      'runtime-a#1'
    )
    expect(mocks.applyFreshWebSessionTabsSnapshot).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.anything(),
      ENVIRONMENT_ID,
      expect.any(Number),
      ''
    )
  })

  it('confirms only the exact handoff after its post-create list completes', async () => {
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'list',
      ok: true,
      result: makeSnapshot()
    })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })
    mocks.applyFreshWebSessionTabsSnapshot.mockImplementation((state) => state)
    recordWebAgentSessionHandoff({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID,
      provisionalTabId: 'provisional-a',
      hostTabId: 'host-a',
      hostTerminalHandle: 'term_host-a'
    })
    recordWebAgentSessionHandoff({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID,
      provisionalTabId: 'provisional-b',
      hostTabId: 'host-b',
      hostTerminalHandle: 'term_host-b'
    })

    await refreshWebRuntimeSessionTabsSnapshot(ENVIRONMENT_ID, WORKTREE_ID, {
      acceptCurrentSnapshot: true,
      confirmAgentSessionHandoff: {
        provisionalTabId: 'provisional-a',
        hostTabId: 'host-a',
        hostTerminalHandle: 'term_host-a'
      }
    })

    const confirmed = (provisionalTabId: string): boolean =>
      isWebAgentSessionHandoffPostCreateSnapshotConfirmed({
        environmentId: ENVIRONMENT_ID,
        worktreeId: WORKTREE_ID,
        provisionalTabId
      })
    expect(confirmed('provisional-a')).toBe(true)
    expect(confirmed('provisional-b')).toBe(false)
    expect(mocks.acceptReplayedWebSessionTabsSnapshot).toHaveBeenCalledWith(
      ENVIRONMENT_ID,
      WORKTREE_ID
    )

    recordWebAgentSessionHandoff({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID,
      provisionalTabId: 'provisional-a',
      hostTabId: 'host-a',
      hostTerminalHandle: 'term_host-a-replacement'
    })
    confirmWebAgentSessionHandoffAfterCreate({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID,
      provisionalTabId: 'provisional-a',
      hostTabId: 'host-a',
      hostTerminalHandle: 'term_host-a'
    })
    expect(confirmed('provisional-a')).toBe(false)
  })
})

describe('activateWebRuntimeSessionWorktree', () => {
  beforeEach(() => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    mocks.getState.mockReturnValue({
      settings: {
        activeRuntimeEnvironmentId: ENVIRONMENT_ID
      },
      runtimeStatusByEnvironmentId: new Map([
        [ENVIRONMENT_ID, { status: { runtimeId: 'runtime-a' }, connectionGeneration: 1 }]
      ]) as AppState['runtimeStatusByEnvironmentId']
    })
    mocks.setState.mockImplementation((updater: (state: unknown) => unknown) =>
      updater({ state: 'before' })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    clearRuntimeCompatibilityCacheForTests()
    vi.clearAllMocks()
  })

  it('activates caller-owned session surfaces without steering host or clients', async () => {
    const snapshot = makeSnapshot()
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'activate',
        ok: true,
        result: { repoId: 'repo', worktreeId: WORKTREE_ID, activated: true }
      })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: snapshot })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })
    mocks.listRemoteRuntimeSessionTabsDeduped.mockImplementation(
      (args: { load: () => Promise<unknown> }) => args.load()
    )

    await expect(
      activateWebRuntimeSessionWorktree({
        worktreeId: WORKTREE_ID
      })
    ).resolves.toBe(true)

    expect(runtimeCall).toHaveBeenNthCalledWith(1, {
      selector: ENVIRONMENT_ID,
      method: 'worktree.activate',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        notifyClients: false,
        navigation: 'caller'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).toHaveBeenNthCalledWith(2, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.list',
      params: { worktree: `id:${WORKTREE_ID}` },
      timeoutMs: 15_000
    })
    expect(mocks.applyFreshWebSessionTabsSnapshot).toHaveBeenCalledWith(
      { state: 'before' },
      snapshot,
      ENVIRONMENT_ID,
      expect.any(Number),
      'runtime-a#1'
    )
    expect(mocks.acceptReplayedWebSessionTabsSnapshot).toHaveBeenCalledWith(
      ENVIRONMENT_ID,
      WORKTREE_ID
    )
  })
})
