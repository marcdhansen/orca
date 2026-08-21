// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type * as WorktreeRuntimeOwnerModule from '@/lib/worktree-runtime-owner'

const mocks = vi.hoisted(() => ({
  getExplicitRuntimeEnvironmentIdForWorktree: vi.fn(),
  recoverSnapshot: vi.fn(),
  runtimeSessionMirrorEnvironmentKey: vi.fn(),
  observeNotification: vi.fn()
}))

vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: mocks.observeNotification
}))

vi.mock('./use-runtime-session-mirror-environment-key', () => ({
  useRuntimeSessionMirrorEnvironmentKey: mocks.runtimeSessionMirrorEnvironmentKey
}))

vi.mock('@/lib/worktree-runtime-owner', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeRuntimeOwnerModule>()
  return {
    ...actual,
    getExplicitRuntimeEnvironmentIdForWorktree: mocks.getExplicitRuntimeEnvironmentIdForWorktree
  }
})

vi.mock('./web-session-terminal-orphan-recovery', () => ({
  recoverWebSessionTerminalOrphansBeforeApply: mocks.recoverSnapshot
}))

import { useAppStore } from '@/store'
import {
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane,
  resetRendererOwnedAgentStatusPanesForTests
} from '@/components/terminal-pane/renderer-owned-agent-status-registry'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { AppState } from '@/store/types'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import {
  applyFreshWebSessionTabsSnapshots,
  getWebSessionTabsAnswerState,
  resetWebSessionTabsSnapshotFreshnessForTests,
  useWebSessionTabsSync,
  WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS
} from './web-session-tabs-sync'
import { WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS } from './window-visibility-subscription-parking'

const ENV = 'env-a'
const REVISION = 101
const WORKTREE = 'repo-a::worktree-a'
const UNLISTED_WORKTREE = 'repo-a::worktree-b'
const SECOND_WORKTREE = 'repo-a::worktree-c'
/** Named by no frame in any test, so only an inventory can answer for it. */
const NEVER_NAMED_WORKTREE = 'repo-a::worktree-z'
// The sync parses this key: environment, runtime, connection generation, revision.
const MIRROR_KEY = `${ENV}\u0001runtime-a\u00011\u0001${REVISION}`
const initialState = useAppStore.getInitialState()

type RuntimeSubscribe = typeof window.api.runtimeEnvironments.subscribe
type RuntimeSubscription = {
  request: Parameters<RuntimeSubscribe>[0]
  callbacks: Parameters<RuntimeSubscribe>[1]
}

const subscriptions: RuntimeSubscription[] = []
const runtimeCall = vi.fn()
const runtimeSubscribe = vi.fn<RuntimeSubscribe>(async (request, callbacks) => {
  subscriptions.push({ request, callbacks })
  return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
})

function snapshot(worktree = WORKTREE, snapshotVersion = 1): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch: 'epoch-1',
    snapshotVersion,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  }
}

const HOST_TAB_ID = 'host-tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

/** A frame carrying one mirrored pane whose agent is mid-turn. */
function workingSnapshot(
  worktree: string,
  snapshotVersion: number
): RuntimeMobileSessionTabsResult {
  return {
    ...snapshot(worktree, snapshotVersion),
    tabs: [
      {
        type: 'terminal',
        id: `${HOST_TAB_ID}::${LEAF_ID}`,
        title: 'Terminal',
        parentTabId: HOST_TAB_ID,
        leafId: LEAF_ID,
        isActive: true,
        status: 'ready',
        terminal: 'terminal-1',
        agentStatus: {
          state: 'working',
          prompt: 'resumed turn',
          updatedAt: 2_000,
          stateStartedAt: 1_000,
          agentType: 'claude',
          paneKey: makePaneKey(HOST_TAB_ID, LEAF_ID),
          tabId: HOST_TAB_ID,
          worktreeId: worktree,
          stateHistory: []
        }
      }
    ]
  } as unknown as RuntimeMobileSessionTabsResult
}

function listAllReturns(response: unknown): void {
  runtimeCall.mockImplementation(async () => response)
}

type Deferred = {
  promise: Promise<RuntimeMobileSessionTabsResult>
  resolve: (value: RuntimeMobileSessionTabsResult) => void
}

function createDeferred(): Deferred {
  let resolve = (_value: RuntimeMobileSessionTabsResult): void => {}
  const promise = new Promise<RuntimeMobileSessionTabsResult>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

async function mountSync(): Promise<ReturnType<typeof renderHook>> {
  const hook = renderHook(() => useWebSessionTabsSync())
  await act(settle)
  return hook
}

/** An inventory is the only thing that answers for a worktree the host never
 *  named, so it must register only where one really landed. */
function inventoryAnswered(): boolean {
  return getWebSessionTabsAnswerState(ENV, NEVER_NAMED_WORKTREE).answered
}

function answered(worktree = WORKTREE): boolean {
  return getWebSessionTabsAnswerState(ENV, worktree).answered
}

/** A reconnect: answers stamped with the old connection stop counting. */
function advanceConnectionGeneration(connectionGeneration: number): void {
  act(() => {
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([
        [ENV, { status: { runtimeId: 'runtime-a' }, connectionGeneration }]
      ]) as AppState['runtimeStatusByEnvironmentId']
    })
  })
}

function newestSubscription(
  method: 'session.tabs.subscribeAll' | 'session.tabs.subscribe'
): RuntimeSubscription {
  const matches = subscriptions.filter(({ request }) => request.method === method)
  const subscription = matches.at(-1)
  if (!subscription) {
    throw new Error(`missing ${method} subscription`)
  }
  return subscription
}

function inventorySubscription(): RuntimeSubscription {
  return newestSubscription('session.tabs.subscribeAll')
}

function worktreeSubscription(): RuntimeSubscription {
  return newestSubscription('session.tabs.subscribe')
}

function setDocumentVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** Parks every mirror and resumes it, which is what arms the unchanged-resume
 *  classification the streamed inventory guard has to respect. */
async function parkAndResume(): Promise<void> {
  act(() => {
    setDocumentVisibility('hidden')
    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
  })
  act(() => setDocumentVisibility('visible'))
  act(() => vi.advanceTimersByTime(WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS))
  await act(settle)
}

async function publish(subscription: RuntimeSubscription, result: unknown): Promise<void> {
  await act(async () => {
    subscription.callbacks.onResponse({
      id: 'event',
      ok: true,
      result,
      _meta: { runtimeId: 'runtime-a' }
    } as never)
    await settle()
  })
}

beforeEach(() => {
  subscriptions.length = 0
  runtimeCall.mockReset()
  listAllReturns({ id: 'list-all', ok: false, error: { message: 'unreachable' } })
  runtimeSubscribe.mockClear()
  mocks.recoverSnapshot.mockReset().mockImplementation(async (_state, frame) => frame)
  mocks.observeNotification.mockReset()
  resetRendererOwnedAgentStatusPanesForTests()
  mocks.getExplicitRuntimeEnvironmentIdForWorktree.mockReset().mockReturnValue(ENV)
  mocks.runtimeSessionMirrorEnvironmentKey.mockReset().mockReturnValue(MIRROR_KEY)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
  })
  resetWebSessionTabsSnapshotFreshnessForTests()
  const runtimeEnvironments = [
    { id: ENV, createdAt: 100, pairingRevision: REVISION }
  ] as PublicKnownRuntimeEnvironment[]
  replaceRuntimeEnvironmentRevisions(runtimeEnvironments)
  useAppStore.setState(
    {
      ...initialState,
      activeWorktreeId: WORKTREE,
      workspaceSessionReady: true,
      runtimeEnvironments,
      runtimeStatusByEnvironmentId: new Map([
        [ENV, { status: { runtimeId: 'runtime-a' }, connectionGeneration: 1 }]
      ]) as AppState['runtimeStatusByEnvironmentId']
    },
    true
  )
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  replaceRuntimeEnvironmentRevisions([])
  resetWebSessionTabsSnapshotFreshnessForTests()
  vi.restoreAllMocks()
})

describe('applied session-tabs answers', () => {
  it('records nothing when the initial inventory never loads', async () => {
    await mountSync()
    expect(inventoryAnswered()).toBe(false)
  })

  it('records the initial inventory once it reaches the store', async () => {
    listAllReturns({ id: 'list-all', ok: true, result: { snapshots: [snapshot()] } })
    await mountSync()
    expect(inventoryAnswered()).toBe(true)
  })

  it('records nothing when orphan recovery fails before the store apply', async () => {
    listAllReturns({ id: 'list-all', ok: true, result: { snapshots: [snapshot()] } })
    mocks.recoverSnapshot.mockRejectedValue(new Error('recovery failed'))
    await mountSync()
    expect(inventoryAnswered()).toBe(false)
  })

  it('records nothing when recovery drops one snapshot of the inventory', async () => {
    listAllReturns({
      id: 'list-all',
      ok: true,
      result: { snapshots: [snapshot(), snapshot(UNLISTED_WORKTREE)] }
    })
    mocks.recoverSnapshot.mockImplementation(
      async (_state, frame: RuntimeMobileSessionTabsResult) =>
        frame.worktree === WORKTREE ? null : frame
    )
    await mountSync()
    expect(inventoryAnswered()).toBe(false)
    // The frame that survived still answers for its own worktree.
    expect(answered(UNLISTED_WORKTREE)).toBe(true)
  })

  it('records nothing when recovery drops a frame whose worktree the store already holds', async () => {
    // Store data for that worktree must not make a dropped frame read as merely
    // superseded: the host's word for it never reached the store at all.
    act(() => {
      useAppStore.setState(
        applyFreshWebSessionTabsSnapshots(
          useAppStore.getState() as never,
          [snapshot(WORKTREE, 2)],
          ENV
        ) as never
      )
    })
    listAllReturns({
      id: 'list-all',
      ok: true,
      result: { snapshots: [snapshot(WORKTREE, 1), snapshot(UNLISTED_WORKTREE)] }
    })
    mocks.recoverSnapshot.mockImplementation(
      async (_state, frame: RuntimeMobileSessionTabsResult) =>
        frame.worktree === WORKTREE ? null : frame
    )
    await mountSync()
    expect(inventoryAnswered()).toBe(false)
  })

  it('records a streamed inventory and keeps it distinct from a single frame', async () => {
    const hook = await mountSync()
    await publish(worktreeSubscription(), { type: 'updated', ...snapshot() })
    // One frame names one worktree, so it answers for that worktree alone.
    expect(answered()).toBe(true)
    expect(answered(UNLISTED_WORKTREE)).toBe(false)
    expect(inventoryAnswered()).toBe(false)
    await publish(inventorySubscription(), {
      type: 'snapshots',
      snapshots: [snapshot(WORKTREE, 2)]
    })
    expect(inventoryAnswered()).toBe(true)
    hook.unmount()
  })

  it('records no streamed inventory when a newer frame supersedes one of its snapshots', async () => {
    const hook = await mountSync()
    const deferred = createDeferred()
    mocks.recoverSnapshot.mockImplementation(
      async (_state, frame: RuntimeMobileSessionTabsResult) =>
        frame.snapshotVersion === 1 ? deferred.promise : frame
    )
    await publish(inventorySubscription(), { type: 'snapshots', snapshots: [snapshot()] })
    // The worktree publishes again while the inventory is still recovering, so
    // its frame is stale by the time the guards see it.
    await publish(worktreeSubscription(), { type: 'updated', ...snapshot(WORKTREE, 2) })
    await act(async () => {
      deferred.resolve(snapshot())
      await settle()
    })

    expect(answered()).toBe(true)
    expect(inventoryAnswered()).toBe(false)
    hook.unmount()
  })

  it('does not let a reconnect-interrupted initial inventory answer the new connection', async () => {
    const deferred = createDeferred()
    mocks.recoverSnapshot.mockImplementation(
      async (_state, frame: RuntimeMobileSessionTabsResult) =>
        frame.worktree === WORKTREE ? deferred.promise : frame
    )
    listAllReturns({ id: 'list-all', ok: true, result: { snapshots: [snapshot()] } })
    await mountSync()
    // One act: the reconnect lands and the parked generation-1 recovery resolves
    // before any effect cleanup can retire the old continuation.
    await act(async () => {
      advanceConnectionGeneration(2)
      deferred.resolve(snapshot())
      await settle()
    })
    // Evidence from the old connection cannot settle the new one's hold.
    expect(answered()).toBe(false)
    expect(inventoryAnswered()).toBe(false)
  })

  it('does not let a reconnect-interrupted streamed inventory answer the new connection', async () => {
    const hook = await mountSync()
    const deferred = createDeferred()
    mocks.recoverSnapshot.mockImplementation(
      async (_state, frame: RuntimeMobileSessionTabsResult) =>
        frame.worktree === WORKTREE && frame.snapshotVersion === 1 ? deferred.promise : frame
    )
    await publish(inventorySubscription(), { type: 'snapshots', snapshots: [snapshot()] })
    await act(async () => {
      advanceConnectionGeneration(2)
      deferred.resolve(snapshot())
      await settle()
    })
    expect(answered()).toBe(false)
    expect(inventoryAnswered()).toBe(false)
    // The gate is not wedged: a frame from the new connection still answers.
    await publish(worktreeSubscription(), { type: 'updated', ...snapshot(WORKTREE, 2) })
    expect(answered()).toBe(true)
    hook.unmount()
  })

  it('does not let a reconnect-interrupted active-stream frame answer the new connection', async () => {
    const hook = await mountSync()
    const deferred = createDeferred()
    mocks.recoverSnapshot.mockImplementation(
      async (_state, frame: RuntimeMobileSessionTabsResult) =>
        frame.worktree === WORKTREE && frame.snapshotVersion === 1 ? deferred.promise : frame
    )
    await publish(worktreeSubscription(), { type: 'updated', ...snapshot() })
    // Why: mutate gen in-place so isCurrent stays true but receipt-time
    // identity (gen 1) mismatches record-time (gen 2) → answered false.
    const { runtimeStatusByEnvironmentId } = useAppStore.getState() as AppState
    runtimeStatusByEnvironmentId.get(ENV)!.connectionGeneration = 2
    await act(async () => {
      deferred.resolve(snapshot())
      await settle()
    })
    expect(answered()).toBe(false)
    // A real reconnect establishes a new subscription; a gen-2 frame answers.
    advanceConnectionGeneration(2)
    await publish(worktreeSubscription(), { type: 'updated', ...snapshot(WORKTREE, 2) })
    expect(answered()).toBe(true)
    hook.unmount()
  })

  it('keeps the new-connection answer when an older parked recovery lands afterwards', async () => {
    // The parked generation-1 enumeration carries a version the store still has to
    // take, so its late apply reaches the answer recorder: only the stale-stamp
    // guard stops it from clobbering the generation-2 answer.
    const deferred = createDeferred()
    mocks.recoverSnapshot.mockImplementation(
      async (_state, frame: RuntimeMobileSessionTabsResult) =>
        frame.worktree === WORKTREE && frame.snapshotVersion === 3 ? deferred.promise : frame
    )
    listAllReturns({ id: 'list-all', ok: true, result: { snapshots: [snapshot(WORKTREE, 3)] } })
    await mountSync()
    advanceConnectionGeneration(2)
    await publish(worktreeSubscription(), { type: 'updated', ...snapshot(WORKTREE, 2) })
    expect(answered()).toBe(true)
    await act(async () => {
      deferred.resolve(snapshot(WORKTREE, 3))
      await settle()
    })
    expect(answered()).toBe(true)
  })

  it('records an initial inventory whose frame the store already superseded', async () => {
    act(() => {
      useAppStore.setState(
        applyFreshWebSessionTabsSnapshots(
          useAppStore.getState() as never,
          [snapshot(WORKTREE, 2)],
          ENV
        ) as never
      )
    })
    expect(answered()).toBe(true)
    listAllReturns({ id: 'list-all', ok: true, result: { snapshots: [snapshot(WORKTREE, 1)] } })
    await mountSync()

    // The store keeps its newer version, so nothing of the frame is applied — but
    // that worktree's evidence already reached the store, so the enumeration of
    // the worktrees it omits still holds.
    expect(inventoryAnswered()).toBe(true)
  })

  it('records a streamed inventory whose frame the store already superseded', async () => {
    const hook = await mountSync()
    await publish(worktreeSubscription(), { type: 'updated', ...snapshot(WORKTREE, 2) })
    expect(answered()).toBe(true)
    await publish(inventorySubscription(), {
      type: 'snapshots',
      snapshots: [snapshot(WORKTREE, 1)]
    })

    expect(inventoryAnswered()).toBe(true)
    hook.unmount()
  })

  it('records an inventory carrying the floating workspace the store never takes', async () => {
    // The floating frame is refused by design, not for want of evidence, so it
    // must not suppress the enumeration's answer for every omitted worktree.
    listAllReturns({
      id: 'list-all',
      ok: true,
      result: { snapshots: [snapshot(), snapshot(FLOATING_TERMINAL_WORKTREE_ID)] }
    })
    await mountSync()
    expect(inventoryAnswered()).toBe(true)
  })

  it('records a streamed inventory carrying the floating workspace', async () => {
    const hook = await mountSync()
    await publish(inventorySubscription(), {
      type: 'snapshots',
      snapshots: [snapshot(), snapshot(FLOATING_TERMINAL_WORKTREE_ID)]
    })
    expect(inventoryAnswered()).toBe(true)
    hook.unmount()
  })

  it('never lets a lone floating frame answer for the floating workspace', async () => {
    // Counting toward an enumeration is not the same as being answered for.
    const hook = await mountSync()
    await publish(worktreeSubscription(), {
      type: 'updated',
      ...snapshot(FLOATING_TERMINAL_WORKTREE_ID)
    })
    expect(answered(FLOATING_TERMINAL_WORKTREE_ID)).toBe(false)
    hook.unmount()
  })

  it('records an empty initial inventory', async () => {
    // The host holds no session at all: an answer for every worktree.
    listAllReturns({ id: 'list-all', ok: true, result: { snapshots: [] } })
    await mountSync()
    expect(inventoryAnswered()).toBe(true)
  })

  it('records an empty streamed inventory', async () => {
    const hook = await mountSync()
    await publish(inventorySubscription(), { type: 'snapshots', snapshots: [] })
    expect(inventoryAnswered()).toBe(true)
    hook.unmount()
  })

  it('records a resume inventory whose frames all repeat what the client holds', async () => {
    // The resume path skips recovery and the store apply for an unchanged frame and
    // treats it as accepted; the enumeration is still the host's current answer.
    vi.useFakeTimers()
    try {
      const hook = await mountSync()
      await publish(inventorySubscription(), {
        type: 'snapshots',
        snapshots: [snapshot(), snapshot(SECOND_WORKTREE)]
      })
      expect(inventoryAnswered()).toBe(true)
      await parkAndResume()
      // A reconnect retires that answer, so only the resume can restore it.
      advanceConnectionGeneration(2)
      expect(inventoryAnswered()).toBe(false)
      await publish(inventorySubscription(), {
        type: 'snapshots',
        snapshots: [snapshot(), snapshot(SECOND_WORKTREE)]
      })
      expect(inventoryAnswered()).toBe(true)
      hook.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('records no resume inventory whose unchanged frame is superseded mid-flight', async () => {
    vi.useFakeTimers()
    try {
      const hook = await mountSync()
      await publish(inventorySubscription(), {
        type: 'snapshots',
        snapshots: [snapshot(), snapshot(SECOND_WORKTREE)]
      })
      expect(inventoryAnswered()).toBe(true)
      await parkAndResume()
      advanceConnectionGeneration(2)

      const deferred = createDeferred()
      mocks.recoverSnapshot.mockImplementation(
        async (_state, frame: RuntimeMobileSessionTabsResult) =>
          frame.worktree === SECOND_WORKTREE ? deferred.promise : frame
      )
      // The first frame is unchanged, so the resume skips its recovery entirely;
      // the second is newer, so the whole inventory waits on it.
      await publish(inventorySubscription(), {
        type: 'snapshots',
        snapshots: [snapshot(), snapshot(SECOND_WORKTREE, 2)]
      })
      await publish(worktreeSubscription(), { type: 'updated', ...snapshot(WORKTREE, 2) })
      await act(async () => {
        deferred.resolve(snapshot(SECOND_WORKTREE, 2))
        await settle()
      })

      // The unchanged frame is stale now, so the enumeration no longer holds.
      expect(inventoryAnswered()).toBe(false)
      hook.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('still reports a client-owned working turn from a frame the store discards', async () => {
    // The store judges the enumeration; notifications keep the wider scope, or a
    // resumed agent whose frame lost the version race is never announced.
    const paneKey = makePaneKey(toWebTerminalSurfaceTabId(HOST_TAB_ID), LEAF_ID)
    const release = registerRendererOwnedAgentStatusPane(paneKey, ENV)
    markRendererOwnedAgentStatusWrite(paneKey)
    act(() => {
      useAppStore.setState(
        applyFreshWebSessionTabsSnapshots(
          useAppStore.getState() as never,
          [snapshot(WORKTREE, 2)],
          ENV
        ) as never
      )
    })
    listAllReturns({
      id: 'list-all',
      ok: true,
      result: { snapshots: [workingSnapshot(WORKTREE, 1)] }
    })
    await mountSync()

    // The frame is stale, so nothing of it patches the store, yet the working
    // turn it carries is still announced.
    expect(mocks.observeNotification).toHaveBeenCalledWith(
      expect.objectContaining({ paneKey, worktreeId: WORKTREE })
    )
    release()
  })

  it('counts an authoritative removal as this worktree answering', async () => {
    const hook = await mountSync()
    await publish(worktreeSubscription(), { type: 'updated', ...snapshot(), removed: true })
    // The removal tears tracking down; the answer must outlive it.
    expect(answered()).toBe(true)
    expect(inventoryAnswered()).toBe(false)
    hook.unmount()
  })
})
