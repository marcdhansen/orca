/**
 * GUARD TESTS — deliberately NOT red-first for this diff. They pass with the
 * host-session-binding fix reverted, and that is the point: they pin the
 * invariant that fix DEPENDS on, not the fix itself. Do not delete them as
 * vacuous.
 *
 * The invariant: creating a host-initiated terminal must not arm its repo's
 * topology fence. An armed fence makes rebaseWorkspaceSessionTerminalMembership
 * treat every later renderer close as a stale replay and restore the row,
 * leaving the durable de-persist to ride the PTY exit — which is asynchronous
 * and can fail outright. A close whose kill never lands would then stay
 * persisted forever: a session-level twin of the closed-tab resurrection
 * STA-4593 fixed at the snapshot layer.
 *
 * Safety is one guard away — advanceTopologyFence's
 * `currentRevision <= 0 && !establishesSplitAuthority` early return
 * (persistence/loading-store/store.ts:3284-3293). If anyone arms the fence from
 * the create path (passes expectedSourceBinding, or relaxes that guard), these
 * fail immediately and that scenario becomes real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { createStore, testState } from '../persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testStateDirRef.dir, getName: () => 'orca', getVersion: () => '0.0.0' },
  BrowserWindow: { fromId: () => null, getAllWindows: () => [] },
  webContents: { fromId: () => null },
  ipcMain: { on: () => {}, handle: () => {}, removeListener: () => {} },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const testStateDirRef = vi.hoisted(() => ({ dir: '' }))

const REPO_ID = 'repo-1'
const WT = `${REPO_ID}::/tmp/wt-cli`
const TAB = 'cli-tab-1'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PTY = `${WT}@@a1b2c3d4`

function rendererWriteWithout(session: WorkspaceSessionState, tabId: string): WorkspaceSessionState {
  // A renderer session write after closing `tabId`: the row is gone, and the
  // renderer never writes the host-private topology fence.
  const next: WorkspaceSessionState = {
    ...session,
    tabsByWorktree: {
      ...session.tabsByWorktree,
      [WT]: (session.tabsByWorktree?.[WT] ?? []).filter((tab) => tab.id !== tabId)
    }
  }
  delete (next as { terminalTopologyRevisionByRepoId?: unknown }).terminalTopologyRevisionByRepoId
  return next
}

async function makeStore() {
  return await createStore()
}

describe('host-created terminal close durability', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-close-durability-'))
    testStateDirRef.dir = testState.dir
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('a host-created terminal does NOT push a fresh repo into host-authoritative membership', async () => {
    const store = await makeStore()
    store.persistPtyBinding({ worktreeId: WT, tabId: TAB, leafId: LEAF, ptyId: PTY })
    const session = store.getWorkspaceSession()
    expect(session.tabsByWorktree?.[WT]?.map((t) => t.id)).toContain(TAB)
    // advanceTopologyFence (store.ts:3284) deliberately declines to arm the
    // fence while currentRevision <= 0 and no split authority is established.
    // That is what keeps a renderer close authoritative for this repo.
    expect(session.terminalTopologyRevisionByRepoId?.[REPO_ID] ?? 0).toBe(0)
  })

  it('a renderer close write durably removes the row it persisted', async () => {
    const store = await makeStore()
    store.persistPtyBinding({ worktreeId: WT, tabId: TAB, leafId: LEAF, ptyId: PTY })
    store.setWorkspaceSession(rendererWriteWithout(store.getWorkspaceSession(), TAB))
    expect(store.getWorkspaceSession().tabsByWorktree?.[WT] ?? []).toEqual([])
  })

  it('stays removed with the PTY still connected and no exit ever delivered', async () => {
    const store = await makeStore()
    store.persistPtyBinding({ worktreeId: WT, tabId: TAB, leafId: LEAF, ptyId: PTY })
    store.setWorkspaceSession(rendererWriteWithout(store.getWorkspaceSession(), TAB))
    // Kill-failure shape: no retirement, no exit, just more renderer writes.
    for (let i = 0; i < 3; i += 1) {
      store.setWorkspaceSession({ ...store.getWorkspaceSession() })
    }
    expect(store.getWorkspaceSession().tabsByWorktree?.[WT] ?? []).toEqual([])
  })

  it('pre-existing host-authoritative membership rebases the close away (not ours)', async () => {
    const store = await makeStore()
    // A serve/SSH host arms the fence long before any CLI terminal exists.
    store.setWorkspaceSession({
      ...store.getWorkspaceSession(),
      terminalTopologyRevisionByRepoId: { [REPO_ID]: 1 }
    })
    store.persistPtyBinding({ worktreeId: WT, tabId: TAB, leafId: LEAF, ptyId: PTY })
    store.setWorkspaceSession(rendererWriteWithout(store.getWorkspaceSession(), TAB))
    // Documents PRE-EXISTING behavior: with the fence already armed, a renderer
    // write that omits a row is treated as a stale replay and the row survives
    // until an exit-driven retirement advances the fence. This is independent of
    // host-created terminals — it applies to every tab in such a repo.
    expect(store.getWorkspaceSession().tabsByWorktree?.[WT]?.map((t) => t.id)).toContain(TAB)
  })
})

/**
 * Census. The safety of a host-created terminal's persisted row rests on ONE
 * fact: creating it must not arm the repo's topology fence, because an armed
 * fence makes rebaseWorkspaceSessionTerminalMembership treat every later
 * renderer close as a stale replay and restore the row until an exit-driven
 * retirement advances the fence. If the kill never lands, that is permanent.
 *
 * These pin the seam itself rather than spot-checking callers, so adding a new
 * fence-advancing path (or arming it from the create path) fails here.
 */
describe('topology fence census', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-fence-census-'))
    testStateDirRef.dir = testState.dir
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('no host-create binding shape arms a fresh repo fence', async () => {
    for (const [index, extra] of [
      {},
      { incarnationId: '33333333-3333-4333-8333-333333333333' },
      { startupCwd: '/tmp/wt-cli' }
    ].entries()) {
      const store = await makeStore()
      store.persistPtyBinding({
        worktreeId: WT,
        tabId: `${TAB}-${index}`,
        leafId: LEAF,
        ptyId: `${PTY}-${index}`,
        ...extra
      })
      expect(store.getWorkspaceSession().terminalTopologyRevisionByRepoId?.[REPO_ID] ?? 0).toBe(0)
    }
  })

  it('a second pane in the same tab still does not arm the fence', async () => {
    const store = await makeStore()
    store.persistPtyBinding({ worktreeId: WT, tabId: TAB, leafId: LEAF, ptyId: PTY })
    store.persistPtyBinding({
      worktreeId: WT,
      tabId: TAB,
      leafId: '22222222-2222-4222-8222-222222222222',
      ptyId: `${PTY}-b`
    })
    expect(store.getWorkspaceSession().terminalTopologyRevisionByRepoId?.[REPO_ID] ?? 0).toBe(0)
  })

  it('an armed fence keeps climbing, so exit-driven retirement still outranks replays', async () => {
    const store = await makeStore()
    store.setWorkspaceSession({
      ...store.getWorkspaceSession(),
      terminalTopologyRevisionByRepoId: { [REPO_ID]: 1 }
    })
    store.persistPtyBinding({ worktreeId: WT, tabId: TAB, leafId: LEAF, ptyId: PTY })
    expect(
      store.getWorkspaceSession().terminalTopologyRevisionByRepoId?.[REPO_ID] ?? 0
    ).toBeGreaterThan(1)
  })
})
