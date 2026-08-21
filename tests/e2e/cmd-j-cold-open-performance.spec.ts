import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { PALETTE_INTERACTION_BUDGET } from '../../src/renderer/src/lib/palette-match/palette-match-budget'

const WORKSPACE_COUNT = 800
const {
  openHandlerMs: MAX_OPEN_HANDLER_MS,
  firstVisibleResultsMs: MAX_FIRST_VISIBLE_MS,
  maxFrameGapMs: MAX_FRAME_GAP_MS
} = PALETTE_INTERACTION_BUDGET
const TARGET_QUERY = 'needle 0399'
const TARGET_LOCAL_NAME = 'Needle local 0399'
const TARGET_REMOTE_NAME = 'Needle remote 0399'

type InteractionMetrics = {
  firstVisibleMs: number
  handlerMs: number | null
  maxFrameGapMs: number
  visibleTexts: string[]
}

type CmdJPerformanceProbe = {
  begin: (expectedTexts: string[]) => void
  finish: () => InteractionMetrics | null
  stop: () => void
}

type PerformanceProbeWindow = Window & { __cmdJPerformanceProbe?: CmdJPerformanceProbe }

async function seedAccumulatedWorkspaceCatalog(page: Page): Promise<void> {
  await page.evaluate(
    ({ workspaceCount, targetLocalName, targetRemoteName }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const now = Date.now()
      const sharedRepoId = 'perf-repo'
      const localRepo = {
        id: sharedRepoId,
        path: '/perf/orca',
        displayName: 'acme/orca-local',
        badgeColor: '#64748b',
        addedAt: now,
        kind: 'git' as const,
        executionHostId: 'local' as const
      }
      const remoteRepo = {
        ...localRepo,
        path: '/srv/perf/orca',
        displayName: 'acme/orca-remote',
        connectionId: 'perf-box',
        executionHostId: 'ssh:perf-box' as const
      }
      const longComment =
        'Blocked on the staging relay while the execution host reconnects; review the rollback runbook and deployment evidence before retrying. '.repeat(
          6
        )
      const worktrees = Array.from({ length: workspaceCount }, (_, index) => {
        const pairIndex = Math.floor(index / 2)
        const suffix = String(pairIndex).padStart(4, '0')
        const remote = index % 2 === 1
        const hostId = remote ? ('ssh:perf-box' as const) : ('local' as const)
        const displayName =
          pairIndex === 399
            ? remote
              ? targetRemoteName
              : targetLocalName
            : `Accumulated ${remote ? 'remote' : 'local'} workspace ${suffix}`
        return {
          id: `${sharedRepoId}::/perf/workspace-${suffix}`,
          instanceId: `perf-instance-${index}`,
          repoId: sharedRepoId,
          projectId: 'perf-project',
          hostId,
          projectHostSetupId: remote ? 'perf-ssh-setup' : 'perf-local-setup',
          path: remote ? `/srv/perf/workspace-${suffix}` : `/perf/workspace-${suffix}`,
          head: index.toString(16).padStart(40, 'a'),
          branch: `refs/heads/perf/accumulated-${suffix}-${remote ? 'remote' : 'local'}`,
          isBare: false,
          isMainWorktree: pairIndex === 0,
          displayName,
          comment: `${longComment} Dataset row ${index}.`,
          linkedIssue: 10_000 + index,
          linkedPR: 20_000 + index,
          linkedLinearIssue: `STA-${30_000 + index}`,
          linkedWorkItem: {
            provider: index % 4 === 0 ? ('gitlab' as const) : ('linear' as const),
            type: index % 4 === 0 ? ('mr' as const) : ('issue' as const),
            number: 30_000 + index,
            title: `Rework the palette ranking pipeline for accumulated workspace ${index}`,
            url:
              index % 4 === 0
                ? `https://gitlab.example/acme/orca/-/merge_requests/${30_000 + index}`
                : `https://linear.app/acme/issue/STA-${30_000 + index}`,
            linearIdentifier: index % 4 === 0 ? undefined : `STA-${30_000 + index}`
          },
          automationProvenance: {
            kind: 'created-by-automation' as const,
            automationId: `perf-auto-${index % 8}`,
            automationNameSnapshot: 'Nightly accumulated workspace review',
            automationRunId: `perf-run-${index}`,
            automationRunTitleSnapshot: `Scan daily sweep ${index}`,
            createdAt: now - index * 60_000,
            executionTargetType: remote ? ('ssh' as const) : ('local' as const),
            executionTargetId: remote ? 'perf-box' : sharedRepoId,
            projectId: 'perf-project',
            repoId: sharedRepoId,
            hostId
          },
          isArchived: false,
          isUnread: index % 7 === 0,
          isPinned: index % 19 === 0,
          sortOrder: index,
          lastActivityAt: now - (workspaceCount - index) * 1_000
        }
      })
      const ports = worktrees.map((worktree, index) => ({
        id: `perf-port-${index}`,
        bindHost: '127.0.0.1',
        connectHost: '127.0.0.1',
        port: 3_000 + index,
        pid: 40_000 + index,
        processName: index % 2 === 0 ? 'node' : 'vite',
        protocol: 'http' as const,
        kind: 'workspace' as const,
        owner: {
          worktreeId: worktree.id,
          repoId: worktree.repoId,
          displayName: worktree.displayName,
          path: worktree.path,
          confidence: 'cwd' as const
        }
      }))

      store.setState({
        repos: [localRepo, remoteRepo],
        activeRepoId: sharedRepoId,
        worktreesByRepo: { [sharedRepoId]: worktrees },
        activeWorktreeId: worktrees[0]!.id,
        activeWorkspaceExecutionHostId: 'local',
        tabsByWorktree: {},
        unifiedTabsByWorktree: {},
        browserTabsByWorktree: {},
        browserPagesByWorkspace: {},
        workspacePortScan: {
          key: 'perf-800-workspaces',
          result: { platform: 'darwin', scannedAt: now, ports }
        },
        showSleepingWorkspaces: true,
        hideDefaultBranchWorkspace: false,
        hideAutomationGeneratedWorkspaces: false,
        hideCliCreatedWorkspaces: false,
        hideDetachedHeadWorkspaces: false,
        hideWorkspacesFromOtherDevices: false,
        activeView: 'tasks',
        sidebarOpen: false,
        rightSidebarOpen: false,
        activeModal: undefined
      })
    },
    {
      workspaceCount: WORKSPACE_COUNT,
      targetLocalName: TARGET_LOCAL_NAME,
      targetRemoteName: TARGET_REMOTE_NAME
    }
  )
}

async function installPerformanceProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    let actionStartedAt = 0
    let expectedTexts: string[] = []
    let firstVisibleAt: number | null = null
    let completedMetrics: InteractionMetrics | null = null
    let handlerMs: number | null = null
    let maxFrameGapMs = 0
    let previousFrameAt = performance.now()
    let visibleTexts: string[] = []
    let frameId = 0
    const originalOpenModal = store.getState().openModal

    store.setState({
      openModal: (...args: Parameters<typeof originalOpenModal>) => {
        const startedAt = performance.now()
        originalOpenModal(...args)
        if (args[0] === 'worktree-palette') {
          handlerMs = performance.now() - startedAt
        }
      }
    })

    const sampleFrame = (now: number): void => {
      if (actionStartedAt > 0 && completedMetrics === null) {
        maxFrameGapMs = Math.max(maxFrameGapMs, now - previousFrameAt)
        const items = [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].filter(
          (item) => item.getClientRects().length > 0
        )
        visibleTexts = items.map((item) => item.textContent?.replace(/\s+/g, ' ').trim() ?? '')
        const hasExpectedRows =
          items.length > 0 &&
          expectedTexts.every((expected) => visibleTexts.some((text) => text.includes(expected)))
        if (firstVisibleAt === null && hasExpectedRows) {
          firstVisibleAt = now
          completedMetrics = {
            firstVisibleMs: firstVisibleAt - actionStartedAt,
            handlerMs,
            maxFrameGapMs,
            visibleTexts
          }
        }
      }
      previousFrameAt = now
      frameId = requestAnimationFrame(sampleFrame)
    }
    frameId = requestAnimationFrame(sampleFrame)

    ;(window as PerformanceProbeWindow).__cmdJPerformanceProbe = {
      begin: (nextExpectedTexts) => {
        actionStartedAt = performance.now()
        previousFrameAt = actionStartedAt
        expectedTexts = nextExpectedTexts
        firstVisibleAt = null
        completedMetrics = null
        maxFrameGapMs = 0
        visibleTexts = []
      },
      finish: () => completedMetrics,
      stop: () => {
        cancelAnimationFrame(frameId)
        store.setState({ openModal: originalOpenModal })
      }
    }
  })
}

async function beginProbe(page: Page, expectedTexts: string[]): Promise<void> {
  await page.evaluate(
    (texts) => (window as PerformanceProbeWindow).__cmdJPerformanceProbe?.begin(texts),
    expectedTexts
  )
}

async function readMetrics(page: Page): Promise<InteractionMetrics | null> {
  return page.evaluate(
    () => (window as PerformanceProbeWindow).__cmdJPerformanceProbe?.finish() ?? null
  )
}

async function togglePaletteFromMain(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const mainWindow = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())
    if (!mainWindow) {
      throw new Error('Orca main window is not available')
    }
    mainWindow.webContents.send('ui:toggleWorktreePalette')
  })
}

test.describe('Cmd-J cold accumulated-workspace performance', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('paints complete host-qualified results without dropping a frame', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    const startupTiming = await orcaPage.evaluate(() => ({
      rendererReadyMs: performance.now(),
      firstContentfulPaintMs:
        performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null
    }))
    await seedAccumulatedWorkspaceCatalog(orcaPage)
    await installPerformanceProbe(orcaPage)
    await orcaPage.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )

    await beginProbe(orcaPage, [])
    await togglePaletteFromMain(electronApp)
    const dialog = orcaPage.getByRole('dialog', { name: 'Jump to...' })
    await expect(dialog).toBeVisible()
    await expect.poll(() => readMetrics(orcaPage), { timeout: 10_000 }).not.toBeNull()
    const coldOpen = await readMetrics(orcaPage)
    expect(coldOpen).not.toBeNull()

    await beginProbe(orcaPage, [
      TARGET_REMOTE_NAME,
      TARGET_LOCAL_NAME,
      `Create worktree "${TARGET_QUERY}"`
    ])
    await dialog.getByPlaceholder(/Search chats, terminals, worktrees/).fill(TARGET_QUERY)
    await expect.poll(() => readMetrics(orcaPage), { timeout: 10_000 }).not.toBeNull()
    const immediateQuery = await readMetrics(orcaPage)
    expect(immediateQuery).not.toBeNull()

    const matchingRows = dialog
      .locator('[cmdk-item]:has([data-slot="palette-worktree-name"])')
      .filter({ hasText: 'Needle' })
    await expect(matchingRows).toHaveCount(2)
    const matchingTexts = (await matchingRows.allTextContents()).map((text) =>
      text.replace(/\s+/g, ' ').trim()
    )
    expect(matchingTexts[0]).toContain(TARGET_REMOTE_NAME)
    expect(matchingTexts[1]).toContain(TARGET_LOCAL_NAME)

    await togglePaletteFromMain(electronApp)
    await expect(dialog).not.toBeVisible()
    await orcaPage.waitForTimeout(400)
    await beginProbe(orcaPage, ['Accumulated remote workspace 0398'])
    await togglePaletteFromMain(electronApp)
    await expect(dialog).toBeVisible()
    await expect.poll(() => readMetrics(orcaPage), { timeout: 10_000 }).not.toBeNull()
    const warmReopen = await readMetrics(orcaPage)
    expect(warmReopen).not.toBeNull()

    const report = {
      startupTiming,
      coldOpen,
      immediateQuery,
      warmReopen,
      workspaceCount: WORKSPACE_COUNT
    }
    await testInfo.attach('cmd-j-cold-open-metrics.json', {
      body: Buffer.from(`${JSON.stringify(report, null, 2)}\n`),
      contentType: 'application/json'
    })
    await testInfo.attach('cmd-j-cold-open-visible.png', {
      body: await orcaPage.screenshot(),
      contentType: 'image/png'
    })
    console.log(`[cmd-j-cold-open] ${JSON.stringify(report)}`)

    expect(coldOpen!.handlerMs).not.toBeNull()
    expect(coldOpen!.handlerMs!).toBeLessThanOrEqual(MAX_OPEN_HANDLER_MS)
    expect(coldOpen!.firstVisibleMs).toBeLessThanOrEqual(MAX_FIRST_VISIBLE_MS)
    expect(coldOpen!.maxFrameGapMs).toBeLessThanOrEqual(MAX_FRAME_GAP_MS)
    expect(immediateQuery!.firstVisibleMs).toBeLessThanOrEqual(MAX_FIRST_VISIBLE_MS)
    expect(immediateQuery!.maxFrameGapMs).toBeLessThanOrEqual(MAX_FRAME_GAP_MS)
    expect(warmReopen!.firstVisibleMs).toBeLessThanOrEqual(MAX_FIRST_VISIBLE_MS)
    expect(warmReopen!.maxFrameGapMs).toBeLessThanOrEqual(MAX_FRAME_GAP_MS)

    await orcaPage.evaluate(() => (window as PerformanceProbeWindow).__cmdJPerformanceProbe?.stop())
  })
})
