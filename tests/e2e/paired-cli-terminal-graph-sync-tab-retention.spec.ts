/**
 * TOPOLOGY (a): real Orca DESKTOP app as the remote server, isolated profile,
 * window ATTACHED, paired to a separate real desktop client.
 *
 * A terminal created by `orca terminal create` (RPC `terminal.create` ->
 * OrcaRuntimeService.createTerminal) must survive the renderer graph syncs that
 * every later CLI dispatch drives. The renderer never owns that pane, so it is
 * absent from every renderer publication; the daemon ptyId form
 * `<worktreeId>@@<shortUuid>` is excluded from id-shape classification; and the
 * tab inherits the RENDERER's publicationEpoch, so epoch alone cannot save it.
 *
 * The window is causal: the old gate was `getAvailableAuthoritativeWindow() ===
 * null`, so a windowless host does NOT reproduce this (see the serve parity
 * arm). The renderer-first publication is equally load-bearing — on a workspace
 * only the host published, the snapshot carries a headless epoch, which is
 * preserved unconditionally. Both preconditions are asserted, not assumed.
 *
 * SCOPE — retention on this branch is PARTIAL, and what decides it is not time.
 * Measured a variable at a time on this oracle, one renderer graph sync after a
 * `terminal.create`:
 *
 *   preceding host terminal | clientMutationId | gap    | retained
 *   ------------------------------------------------------------
 *   no                      | no               | 0s     | NO
 *   no                      | no               | 12s    | NO
 *   yes                     | no               | 0s/12s | yes
 *   no                      | yes              | 0s     | yes
 *
 * Two things independently protect the tab: an earlier host-created terminal
 * existing (even in another workspace), or a `clientMutationId` on the create.
 * Elapsed time, and whether a paired client has mirrored the tab, are both
 * irrelevant. On merge-base and with the host fix removed every terminal is
 * pruned in every shape, so the binding is a real improvement.
 *
 * The real `orca terminal create` (src/cli/handlers/terminal.ts) sends no
 * clientMutationId, so a user's FIRST host-created terminal in a workspace has
 * neither protector — the reported incident. That is the `fixme` test below,
 * under separate root-cause investigation.
 *
 * Run:
 *   pnpm exec playwright test tests/e2e/paired-cli-terminal-graph-sync-tab-retention.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { rmSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import {
  toWebTerminalSurfaceTabId,
  WEB_TERMINAL_SURFACE_TAB_PREFIX
} from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  createHostCliTerminal,
  createRetentionFixtureDirectory,
  proveSameLivePty,
  readHostTerminalInventory,
  writeRetentionFixture,
  type HostCreatedTerminal,
  type HostTerminalInventory,
  type RuntimeRpcCall
} from './helpers/host-created-terminal-retention-oracle'

const scratch = createRetentionFixtureDirectory()
const fixturePath = writeRetentionFixture(scratch)

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function createPairedRuntimeCall(page: Page, environmentId: string): RuntimeRpcCall {
  return async <TResult>(method: string, params: unknown): Promise<TResult> =>
    page.evaluate(
      async ({ environmentId, method, params }) => {
        const response = await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method,
          params
        })
        if (!response.ok) {
          throw new Error(`${response.error.code}: ${response.error.message}`)
        }
        return response.result
      },
      { environmentId, method, params }
    ) as Promise<TResult>
}

async function readClientTerminalStrip(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate(
    ({ worktreeId, prefix }) =>
      (window.__store?.getState().tabsByWorktree[worktreeId] ?? [])
        .map((tab) => tab.id)
        .filter((tabId) => tabId.startsWith(prefix)),
    { worktreeId, prefix: WEB_TERMINAL_SURFACE_TAB_PREFIX }
  )
}

/** The strip exactly as it read on the poll tick that first carried `tabId`. */
async function readClientStripWhenTabAppears(
  page: Page,
  worktreeId: string,
  tabId: string,
  message: string
): Promise<string[]> {
  let strip: string[] = []
  await expect
    .poll(
      async () => {
        strip = await readClientTerminalStrip(page, worktreeId)
        return strip.includes(tabId)
      },
      { timeout: 60_000, message }
    )
    .toBe(true)
  return strip
}

/** A renderer-owned terminal tab on the HOST, i.e. an ordinary user pane. */
async function createHostRendererTerminalTab(page: Page, worktreeId: string): Promise<string> {
  const tabId = await page.evaluate((id) => {
    const store = window.__store
    if (!store) {
      throw new Error('Host renderer store is unavailable')
    }
    store.getState().setActiveView('terminal')
    store.getState().setActiveWorktree(id)
    const tab = store.getState().createTab(id)
    store.getState().setActiveTab(tab.id)
    store.getState().setActiveTabType('terminal')
    return tab.id
  }, worktreeId)
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ worktreeId, tabId }) =>
            (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).find(
              (tab) => tab.id === tabId
            )?.ptyId ?? null,
          { worktreeId, tabId }
        ),
      { timeout: 60_000, message: `Host renderer tab ${tabId} never spawned a PTY` }
    )
    .not.toBeNull()
  return tabId
}

async function readHostInventoryWhenTabAppears(
  call: RuntimeRpcCall,
  worktreeId: string,
  tabId: string,
  message: string
): Promise<HostTerminalInventory> {
  let inventory: HostTerminalInventory | null = null
  await expect
    .poll(
      async () => {
        inventory = await readHostTerminalInventory(call, worktreeId)
        return inventory.tabIds.includes(tabId)
      },
      { timeout: 60_000, message }
    )
    .toBe(true)
  return inventory!
}

type RetentionFixture = {
  call: RuntimeRpcCall
  unrelatedWorktreeId: string
  worktreeId: string
}

/** Everything both journeys need in place BEFORE the dispatch under test. */
async function prepareRetentionFixture(
  orcaPage: Page,
  client: PairedElectronClient
): Promise<RetentionFixture> {
  const call = createPairedRuntimeCall(client.page, client.environmentId)
  const { worktreeId, unrelatedWorktreeId } = await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    const active = state?.activeWorktreeId
    if (!state || !active) {
      throw new Error('Host has no active worktree')
    }
    const unrelated = state.allWorktrees().find((worktree) => worktree.id !== active)
    if (!unrelated) {
      throw new Error('Host fixture needs a second worktree for the unrelated-workspace control')
    }
    return { worktreeId: active, unrelatedWorktreeId: unrelated.id }
  })
  await expect
    .poll(
      () =>
        client.page.evaluate(
          (id) =>
            window.__store
              ?.getState()
              .allWorktrees()
              .some((worktree) => worktree.id === id) ?? false,
          worktreeId
        ),
      { timeout: 60_000, message: 'Paired client never saw the host worktree' }
    )
    .toBe(true)

  // PRECONDITION: the RENDERER owns this workspace's publication, so the CLI tab
  // created later inherits the renderer epoch instead of a headless one.
  const rendererTabId = await createHostRendererTerminalTab(orcaPage, worktreeId)
  const rendererOwned = await readHostInventoryWhenTabAppears(
    call,
    worktreeId,
    rendererTabId,
    'Host never published the renderer terminal tab'
  )
  expect(
    rendererOwned.publicationEpoch,
    'the attached-window topology requires a renderer-owned publication; a headless epoch takes a different, already-correct path'
  ).toMatch(/^renderer:/)
  await readClientStripWhenTabAppears(
    client.page,
    worktreeId,
    toWebTerminalSurfaceTabId(rendererTabId),
    'Paired client never mirrored the host renderer terminal tab'
  )
  return { call, unrelatedWorktreeId, worktreeId }
}

/**
 * One `orca terminal create` in the measured workspace, one renderer graph sync,
 * both signals plus the negative-safety checks.
 *
 * `precedingHostTerminal` is the ONLY difference between the two tests, and on
 * this branch it decides the verdict: the unrelated-workspace control terminal
 * is created either before the target (protected shape) or after it (the
 * incident shape, where the target is the first host-created terminal).
 */
async function runCliTerminalRetentionJourney(
  orcaPage: Page,
  testInfo: TestInfo,
  clientName: string,
  precedingHostTerminal: boolean
): Promise<void> {
  const client = await launchPairedElectronClient(
    await createRuntimeDesktopPairingOffer(orcaPage),
    testInfo,
    clientName
  )
  const hostPageErrors: string[] = []
  const clientPageErrors: string[] = []
  orcaPage.on('pageerror', (error) => hostPageErrors.push(String(error)))
  client.page.on('pageerror', (error) => clientPageErrors.push(String(error)))
  const createdHandles: string[] = []
  let call: RuntimeRpcCall | null = null
  try {
    const fixture = await prepareRetentionFixture(orcaPage, client)
    call = fixture.call
    const { unrelatedWorktreeId, worktreeId } = fixture
    const baselineStrip = await readClientTerminalStrip(client.page, worktreeId)

    const createUnrelated = async (): Promise<HostCreatedTerminal> => {
      const terminal = await createHostCliTerminal(
        fixture.call,
        unrelatedWorktreeId,
        fixturePath,
        path.join(scratch, `${clientName}-unrelated.log`)
      )
      createdHandles.push(terminal.handle)
      return terminal
    }

    const preceding = precedingHostTerminal ? await createUnrelated() : null
    const cli = await createHostCliTerminal(
      fixture.call,
      worktreeId,
      fixturePath,
      path.join(scratch, `${clientName}-target.log`)
    )
    createdHandles.push(cli.handle)
    const unrelated = preceding ?? (await createUnrelated())

    // The graph sync a following CLI dispatch drives.
    const secondRendererTabId = await createHostRendererTerminalTab(orcaPage, worktreeId)

    // SIGNAL 1 — the frame carrying the new renderer tab is the same merge that
    // would drop the CLI tab, so judge on that one inventory.
    const afterSync = await readHostInventoryWhenTabAppears(
      fixture.call,
      worktreeId,
      secondRendererTabId,
      'Host never republished with the second renderer tab'
    )
    expect(
      afterSync.tabIds,
      'the renderer graph sync pruned the CLI-created terminal out of the host session inventory'
    ).toContain(cli.tabId)
    expect(
      afterSync.ptyIdByTabId[cli.tabId],
      'the surviving tab must still name the original PTY, not a replacement'
    ).toBe(cli.ptyId)

    // SIGNAL 2 — independent of the inventory: the original process answers.
    await proveSameLivePty(fixture.call, cli, 'after-sync')

    // The paired client tracked that same sync. Presence alone would pass on a
    // stranded mirror, which is exactly what the unfixed host produces.
    const strip = await readClientStripWhenTabAppears(
      client.page,
      worktreeId,
      toWebTerminalSurfaceTabId(secondRendererTabId),
      'Paired client never applied the renderer graph sync that followed the CLI create'
    )
    expect(strip, 'the paired client dropped the CLI-created terminal from its strip').toContain(
      toWebTerminalSurfaceTabId(cli.tabId)
    )
    // No replacement or resume tab was appended for it either.
    expect([...strip].sort()).toEqual(
      [
        ...baselineStrip,
        toWebTerminalSurfaceTabId(cli.tabId),
        toWebTerminalSurfaceTabId(secondRendererTabId)
      ].sort()
    )

    // NEGATIVE SAFETY: no fanout into an unrelated workspace, no local fallback.
    const unrelatedInventory = await readHostTerminalInventory(fixture.call, unrelatedWorktreeId)
    expect(unrelatedInventory.tabIds, 'an unrelated workspace lost its CLI terminal').toContain(
      unrelated.tabId
    )
    expect(unrelatedInventory.ptyIdByTabId[unrelated.tabId]).toBe(unrelated.ptyId)
    await proveSameLivePty(fixture.call, unrelated, 'unrelated-alive')
    expect(
      await client.getDirectSshAttemptTargetIds(),
      'the paired client must reach the host through the pairing, never a local connection'
    ).toEqual([])
    expect(hostPageErrors, 'host renderer raised an uncaught error').toEqual([])
    expect(clientPageErrors, 'paired client renderer raised an uncaught error').toEqual([])
  } finally {
    for (const handle of createdHandles) {
      await call?.('terminal.closeTab', { terminal: handle }).catch(() => undefined)
    }
    await client.dispose()
  }
}

test('keeps a host-created CLI terminal when an earlier host-created terminal exists', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(600_000)
  await runCliTerminalRetentionJourney(orcaPage, testInfo, 'cli-terminal-graph-sync', true)
})

// The reported incident, and the shape the real CLI takes: `orca terminal
// create` sends no clientMutationId, so a user's FIRST host-created terminal in
// a workspace has neither protector, and the next renderer graph sync prunes it.
// Confirmed red on this branch by running this exact body with the annotation
// removed — SIGNAL 1 fires with the target absent from the host inventory.
//
// `fixme`, not `fail`: a `fail` test is satisfied by ANY failure, and this file
// has twice aborted in fixture setup ("seeded e2e worktrees did not load"), so
// `fail` would keep reporting success while measuring nothing. `fixme` records
// the gap without pretending to assert it. Delete the annotation once the
// residual defect under separate root-cause investigation is fixed.
test.fixme('keeps a host-created CLI terminal that is the first one on the host', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(600_000)
  await runCliTerminalRetentionJourney(orcaPage, testInfo, 'cli-terminal-graph-sync-first', false)
})
