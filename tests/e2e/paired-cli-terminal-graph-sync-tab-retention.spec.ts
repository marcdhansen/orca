/**
 * A terminal created by `orca terminal create` (runtime RPC `terminal.create` ->
 * OrcaRuntimeService.createTerminal) on a host whose desktop window IS attached
 * must survive the renderer graph syncs that every later CLI dispatch drives.
 *
 * The renderer never owns that pane, so it is absent from every renderer
 * publication; the daemon ptyId form `<worktreeId>@@<shortUuid>` is deliberately
 * excluded from id-shape classification; and the tab inherits the RENDERER's
 * publicationEpoch, so epoch alone cannot save it either. Only the host's own
 * persisted binding + runtimeSessionOwned keep graph sync from pruning it and
 * publishing a retraction that strands every paired client's tab strip.
 *
 * The renderer-first publication in step 2 is load-bearing: on a workspace that
 * only the host ever published, the snapshot carries a headless epoch which is
 * preserved unconditionally, and the defect does not reproduce.
 *
 * Observed before the fix: the host's own snapshot loses the CLI tab on the
 * first renderer graph sync, and the paired client is left holding the frame
 * from before the prune — it never applies the renderer's next publication at
 * all, so its strip keeps a tab the host no longer serves while the renderer's
 * own new tab never arrives. Hence both halves are asserted: presence alone on
 * the client would pass against a frozen mirror.
 *
 * Run:
 *   pnpm exec playwright test tests/e2e/paired-cli-terminal-graph-sync-tab-retention.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  toWebTerminalSurfaceTabId,
  WEB_TERMINAL_SURFACE_TAB_PREFIX
} from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'

const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-cli-terminal-graph-sync-'))
const fixturePath = path.join(scratch, 'cli-agent-terminal.mjs')

// Stands in for the long-running agent a CLI dispatch spawns: it never exits,
// so every prune this spec observes is about classification, not a dead PTY.
writeFileSync(
  fixturePath,
  [
    "process.stdout.write('READY\\r\\n')",
    "process.stdin.setEncoding('utf8')",
    'process.stdin.resume()'
  ].join('\n')
)

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function fixtureCommand(): string {
  const command = [process.execPath, fixturePath]
  return process.platform === 'win32'
    ? command.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ')
    : command.map(shellQuote).join(' ')
}

async function callEnvironment<TResult>(
  page: Page,
  environmentId: string,
  method: string,
  params: unknown
): Promise<TResult> {
  return page.evaluate(
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

/** Top-level tab ids in the host's own published session snapshot. */
async function readHostSnapshotTabIds(
  client: PairedElectronClient,
  worktreeId: string
): Promise<string[]> {
  const snapshot = await callEnvironment<{
    tabs: { id: string; type: string; parentTabId?: string }[]
  }>(client.page, client.environmentId, 'session.tabs.list', { worktree: `id:${worktreeId}` })
  return snapshot.tabs
    .filter((tab) => tab.type === 'terminal')
    .map((tab) => tab.parentTabId ?? tab.id.split(HOST_TERMINAL_SURFACE_SEPARATOR)[0])
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

test('a host-created CLI terminal survives the renderer graph sync a later dispatch drives', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(360_000)
  const client = await launchPairedElectronClient(
    await createRuntimeDesktopPairingOffer(orcaPage),
    testInfo,
    'cli-terminal-graph-sync'
  )
  const createdHandles: string[] = []
  try {
    const worktreeId = await orcaPage.evaluate(() => {
      const id = window.__store?.getState().activeWorktreeId
      if (!id) {
        throw new Error('Host has no active worktree')
      }
      return id
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

    // 2. The RENDERER publishes this workspace first, so the CLI tab created
    //    below inherits the renderer publication epoch.
    const rendererTabId = await createHostRendererTerminalTab(orcaPage, worktreeId)
    const baselineStrip = await readClientStripWhenTabAppears(
      client.page,
      worktreeId,
      toWebTerminalSurfaceTabId(rendererTabId),
      'Paired client never mirrored the host renderer terminal tab'
    )

    // 3. `orca terminal create`: a background host-initiated create against a
    //    host whose desktop window is attached.
    const created = await callEnvironment<{ terminal: { handle: string; tabId?: string } }>(
      client.page,
      client.environmentId,
      'terminal.create',
      {
        worktree: `id:${worktreeId}`,
        clientMutationId: randomUUID(),
        command: fixtureCommand(),
        focus: false,
        activate: false,
        presentation: 'background'
      }
    )
    createdHandles.push(created.terminal.handle)
    const cliTabId = created.terminal.tabId
    if (!cliTabId) {
      throw new Error('Host did not report a tab id for the CLI-created terminal')
    }
    const cliWebTabId = toWebTerminalSurfaceTabId(cliTabId)
    expect(
      await readHostSnapshotTabIds(client, worktreeId),
      'the host never published the CLI-created terminal'
    ).toContain(cliTabId)
    await readClientStripWhenTabAppears(
      client.page,
      worktreeId,
      cliWebTabId,
      'Paired client never mirrored the CLI-created terminal tab'
    )

    // 4. The next dispatch's renderer graph sync: the renderer republishes this
    //    worktree from the panes IT owns, which never include the CLI terminal.
    const secondRendererTabId = await createHostRendererTerminalTab(orcaPage, worktreeId)
    const secondWebTabId = toWebTerminalSurfaceTabId(secondRendererTabId)

    // 5. The republished frame that carries the new renderer tab is the same
    //    frame that would drop the CLI tab, so judge on that single snapshot.
    let hostTabIds: string[] = []
    await expect
      .poll(
        async () => {
          hostTabIds = await readHostSnapshotTabIds(client, worktreeId)
          return hostTabIds.includes(secondRendererTabId)
        },
        { timeout: 60_000, message: 'Host never republished with the second renderer tab' }
      )
      .toBe(true)
    expect(
      hostTabIds,
      'the renderer graph sync pruned the CLI-created terminal out of the host session snapshot'
    ).toContain(cliTabId)

    // 6. And the paired client tracked that same sync — a strip that still shows
    //    the CLI tab but never received the renderer's new one is a stranded
    //    mirror, not a retained tab.
    const strip = await readClientStripWhenTabAppears(
      client.page,
      worktreeId,
      secondWebTabId,
      'Paired client never applied the renderer graph sync that followed the CLI create'
    )
    expect(
      strip,
      'the paired client dropped the CLI-created terminal from its tab strip'
    ).toContain(cliWebTabId)
    // No replacement/resume tab was appended for it either.
    expect([...strip].sort()).toEqual([...baselineStrip, cliWebTabId, secondWebTabId].sort())
  } finally {
    for (const handle of createdHandles) {
      await callEnvironment(client.page, client.environmentId, 'terminal.closeTab', {
        terminal: handle
      }).catch(() => undefined)
    }
    await client.dispose()
  }
})
