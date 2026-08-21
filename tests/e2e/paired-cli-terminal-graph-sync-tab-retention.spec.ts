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
 * null`, so a windowless host does NOT reproduce this. The renderer-first
 * publication is equally load-bearing — on a workspace only the host published,
 * the snapshot carries a headless epoch, which is preserved unconditionally.
 * Both preconditions are asserted, not assumed.
 *
 * SCOPE, measured three ways on this identical oracle — one renderer graph
 * sync after four back-to-back `terminal.create` calls plus a 12s gap:
 *   main@6e25a90085           tabs 1-4 all pruned
 *   branch, host fix removed  tabs 1-4 all pruned
 *   branch                    tab 1 pruned, tabs 2-4 retained
 * The host binding demonstrably improves retention, and something still retires
 * the oldest host-created tab. This spec therefore pins only what the branch
 * actually fixes: a dispatch whose sync follows it directly. The surviving
 * defect is tracked separately, deliberately NOT encoded here as an
 * expectation — a `test.fail` cannot tell a real prune from a setup error.
 *
 * Run:
 *   pnpm exec playwright test tests/e2e/paired-cli-terminal-graph-sync-tab-retention.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { rmSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
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
  client: PairedElectronClient
  rendererTabId: string
  unrelatedWorktreeId: string
  worktreeId: string
}

/** Everything both tests need in place BEFORE the dispatch under test, so no
 *  setup work sits between that dispatch and the graph sync it races. */
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
  return { call, client, rendererTabId, unrelatedWorktreeId, worktreeId }
}

test('keeps a host-created CLI terminal when the next dispatch syncs immediately', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(600_000)
  const client = await launchPairedElectronClient(
    await createRuntimeDesktopPairingOffer(orcaPage),
    testInfo,
    'cli-terminal-graph-sync'
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

    // Control in an unrelated workspace, created FIRST so it cannot lengthen the
    // gap the test under measurement depends on.
    const unrelated = await createHostCliTerminal(
      fixture.call,
      unrelatedWorktreeId,
      fixturePath,
      path.join(scratch, 'unrelated-agent.log')
    )
    createdHandles.push(unrelated.handle)
    const baselineStrip = await readClientTerminalStrip(client.page, worktreeId)

    // `orca terminal create`, then the graph sync a following dispatch drives.
    const cli = await createHostCliTerminal(
      fixture.call,
      worktreeId,
      fixturePath,
      path.join(scratch, 'cli-agent.log')
    )
    createdHandles.push(cli.handle)
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
})
