import type { ElectronApplication, Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { PALETTE_INTERACTION_BUDGET } from '../../src/renderer/src/lib/palette-match/palette-match-budget'

const WORKSPACE_COUNT = 800
const {
  rendererStoreDispatchMs: MAX_STORE_DISPATCH_MS,
  firstVisibleResultsMs: MAX_FIRST_VISIBLE_MS,
  coldIndexReadyMs: MAX_COLD_INDEX_READY_MS,
  coldImmediateQueryResultsMs: MAX_COLD_IMMEDIATE_QUERY_MS,
  maxFrameGapMs: MAX_FRAME_GAP_MS
} = PALETTE_INTERACTION_BUDGET
const TARGET_QUERY = 'needle 0399'
const TARGET_LOCAL_NAME = 'Needle local 0399'
const TARGET_REMOTE_NAME = 'Needle remote 0399'

type InteractionMetrics = {
  firstVisibleMs: number
  indexReadyMs: number
  storeDispatchMs: number | null
  maxFrameGapMs: number
  maxFrameGapStartedMs: number
  longTasks: { durationMs: number; startedMs: number }[]
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
    let expectedVisibleFrameCount = 0
    let firstVisibleAt: number | null = null
    let indexReadyAt: number | null = null
    let completedMetrics: InteractionMetrics | null = null
    let storeDispatchMs: number | null = null
    let maxFrameGapMs = 0
    let maxFrameGapStartedAt = 0
    let previousFrameAt = performance.now()
    let longTasks: { durationMs: number; startedAt: number }[] = []
    let visibleTexts: string[] = []
    let frameId = 0
    const originalOpenModal = store.getState().openModal

    store.setState({
      openModal: (...args: Parameters<typeof originalOpenModal>) => {
        const startedAt = performance.now()
        originalOpenModal(...args)
        if (args[0] === 'worktree-palette') {
          storeDispatchMs = performance.now() - startedAt
        }
      }
    })

    const longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({ durationMs: entry.duration, startedAt: entry.startTime })
      }
    })
    longTaskObserver.observe({ type: 'longtask', buffered: true })

    const sampleFrame = (): void => {
      const now = performance.now()
      if (actionStartedAt > 0 && completedMetrics === null) {
        const frameGapMs = now - previousFrameAt
        if (frameGapMs > maxFrameGapMs) {
          maxFrameGapMs = frameGapMs
          maxFrameGapStartedAt = previousFrameAt
        }
        const items = [
          ...document.querySelectorAll<HTMLElement>(
            '[role="dialog"][data-state="open"] [cmdk-item]'
          )
        ]
        visibleTexts = items.map((item) => item.textContent?.replace(/\s+/g, ' ').trim() ?? '')
        const hasExpectedRows =
          items.length > 0 &&
          expectedTexts.every((expected) => visibleTexts.some((text) => text.includes(expected)))
        const indexReady = document.querySelector('[data-worktree-index-pending="true"]') === null
        if (hasExpectedRows && indexReady) {
          indexReadyAt ??= now
        }
        if (hasExpectedRows) {
          firstVisibleAt ??= now
        }
        if (hasExpectedRows && indexReady) {
          expectedVisibleFrameCount += 1
        } else {
          expectedVisibleFrameCount = 0
        }
        if (firstVisibleAt !== null && expectedVisibleFrameCount >= 3) {
          completedMetrics = {
            firstVisibleMs: firstVisibleAt - actionStartedAt,
            indexReadyMs: (indexReadyAt ?? now) - actionStartedAt,
            storeDispatchMs,
            maxFrameGapMs,
            maxFrameGapStartedMs: maxFrameGapStartedAt - actionStartedAt,
            longTasks: longTasks
              .filter((task) => task.startedAt + task.durationMs >= actionStartedAt)
              .map((task) => ({
                durationMs: task.durationMs,
                startedMs: task.startedAt - actionStartedAt
              })),
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
        expectedTexts = nextExpectedTexts
        expectedVisibleFrameCount = 0
        firstVisibleAt = null
        indexReadyAt = null
        completedMetrics = null
        maxFrameGapMs = 0
        maxFrameGapStartedAt = 0
        longTasks = []
        visibleTexts = []
      },
      finish: () => completedMetrics,
      stop: () => {
        cancelAnimationFrame(frameId)
        longTaskObserver.disconnect()
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

async function waitForStableFrameCadence(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let previousFrameAt = performance.now()
        let stableFrames = 0
        const sample = (): void => {
          const now = performance.now()
          stableFrames = now - previousFrameAt <= 25 ? stableFrames + 1 : 0
          previousFrameAt = now
          if (stableFrames >= 12) {
            resolve()
            return
          }
          requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      })
  )
}

async function expectHostQualifiedNeedleOrder(dialog: Locator): Promise<void> {
  const matchingRows = dialog
    .locator('[cmdk-item]:has([data-slot="palette-worktree-name"])')
    .filter({ hasText: 'Needle' })
  await expect(matchingRows).toHaveCount(2)
  const matchingTexts = (await matchingRows.allTextContents()).map((text) =>
    text.replace(/\s+/g, ' ').trim()
  )
  expect(matchingTexts[0]).toContain(TARGET_REMOTE_NAME)
  expect(matchingTexts[0]).toContain('acme/orca-remote')
  expect(matchingTexts[1]).toContain(TARGET_LOCAL_NAME)
  expect(matchingTexts[1]).toContain('acme/orca-local')
}

async function expectHostSpecificNeedle(
  dialog: Locator,
  query: string,
  expectedName: string,
  expectedRepo: string
): Promise<void> {
  await dialog.getByPlaceholder(/Search chats, terminals, worktrees/).fill(query)
  const matchingRows = dialog
    .locator('[cmdk-item]:has([data-slot="palette-worktree-name"])')
    .filter({ hasText: 'Needle' })
  await expect(matchingRows).toHaveCount(1)
  await expect(matchingRows).toContainText(expectedName)
  await expect(matchingRows).toContainText(expectedRepo)
}

test.describe('Cmd-J cold accumulated-workspace performance @headful', () => {
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
    await waitForStableFrameCadence(orcaPage)

    await beginProbe(orcaPage, [TARGET_REMOTE_NAME, TARGET_LOCAL_NAME])
    await togglePaletteFromMain(electronApp)
    const dialog = orcaPage.getByRole('dialog', { name: 'Jump to...' })
    await expect(dialog).toBeVisible()
    await expect.poll(() => readMetrics(orcaPage), { timeout: 10_000 }).not.toBeNull()
    const coldOpen = await readMetrics(orcaPage)
    expect(coldOpen).not.toBeNull()
    await expectHostQualifiedNeedleOrder(dialog)

    await beginProbe(orcaPage, [
      TARGET_REMOTE_NAME,
      TARGET_LOCAL_NAME,
      `Create worktree "${TARGET_QUERY}"`
    ])
    await dialog.getByPlaceholder(/Search chats, terminals, worktrees/).fill(TARGET_QUERY)
    await expect.poll(() => readMetrics(orcaPage), { timeout: 10_000 }).not.toBeNull()
    const indexedQuery = await readMetrics(orcaPage)
    expect(indexedQuery).not.toBeNull()

    await expectHostQualifiedNeedleOrder(dialog)
    await expectHostSpecificNeedle(
      dialog,
      'accumulated-0399-remote',
      TARGET_REMOTE_NAME,
      'acme/orca-remote'
    )
    await expectHostSpecificNeedle(
      dialog,
      'accumulated-0399-local',
      TARGET_LOCAL_NAME,
      'acme/orca-local'
    )

    await togglePaletteFromMain(electronApp)
    await expect(dialog).toHaveAttribute('data-state', 'closed')
    await beginProbe(orcaPage, [TARGET_REMOTE_NAME, TARGET_LOCAL_NAME])
    await togglePaletteFromMain(electronApp)
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[data-worktree-index-pending]')).toHaveAttribute(
      'data-worktree-index-pending',
      'false'
    )
    await expect.poll(() => readMetrics(orcaPage), { timeout: 10_000 }).not.toBeNull()
    const warmReopen = await readMetrics(orcaPage)
    expect(warmReopen).not.toBeNull()
    await expectHostQualifiedNeedleOrder(dialog)

    const report = {
      startupTiming,
      coldOpen,
      indexedQuery,
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

    expect(coldOpen!.storeDispatchMs).not.toBeNull()
    expect(coldOpen!.storeDispatchMs!).toBeLessThanOrEqual(MAX_STORE_DISPATCH_MS)
    expect(coldOpen!.firstVisibleMs).toBeLessThanOrEqual(MAX_FIRST_VISIBLE_MS)
    expect(coldOpen!.indexReadyMs).toBeLessThanOrEqual(MAX_COLD_INDEX_READY_MS)
    expect(coldOpen!.maxFrameGapMs).toBeLessThanOrEqual(MAX_FRAME_GAP_MS)
    expect(indexedQuery!.firstVisibleMs).toBeLessThanOrEqual(MAX_FIRST_VISIBLE_MS)
    expect(indexedQuery!.maxFrameGapMs).toBeLessThanOrEqual(MAX_FRAME_GAP_MS)
    expect(warmReopen!.firstVisibleMs).toBeLessThanOrEqual(MAX_FIRST_VISIBLE_MS)
    expect(warmReopen!.indexReadyMs).toBe(warmReopen!.firstVisibleMs)
    expect(warmReopen!.maxFrameGapMs).toBeLessThanOrEqual(MAX_FRAME_GAP_MS)

    await orcaPage.evaluate(() => (window as PerformanceProbeWindow).__cmdJPerformanceProbe?.stop())
  })

  test('keeps an immediate cold query complete and frame-safe', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    await seedAccumulatedWorkspaceCatalog(orcaPage)
    await installPerformanceProbe(orcaPage)
    await waitForStableFrameCadence(orcaPage)

    await togglePaletteFromMain(electronApp)
    const dialog = orcaPage.getByRole('dialog', { name: 'Jump to...' })
    await expect(dialog).toBeVisible()
    await beginProbe(orcaPage, [
      TARGET_REMOTE_NAME,
      TARGET_LOCAL_NAME,
      `Create worktree "${TARGET_QUERY}"`
    ])
    await dialog.getByPlaceholder(/Search chats, terminals, worktrees/).fill(TARGET_QUERY)
    await expect.poll(() => readMetrics(orcaPage), { timeout: 10_000 }).not.toBeNull()
    const coldImmediateQuery = await readMetrics(orcaPage)
    expect(coldImmediateQuery).not.toBeNull()
    await expectHostQualifiedNeedleOrder(dialog)

    await testInfo.attach('cmd-j-cold-immediate-query-metrics.json', {
      body: Buffer.from(`${JSON.stringify(coldImmediateQuery, null, 2)}\n`),
      contentType: 'application/json'
    })
    console.log(`[cmd-j-cold-immediate-query] ${JSON.stringify(coldImmediateQuery)}`)

    expect(coldImmediateQuery!.firstVisibleMs).toBeLessThanOrEqual(MAX_COLD_IMMEDIATE_QUERY_MS)
    expect(coldImmediateQuery!.maxFrameGapMs).toBeLessThanOrEqual(MAX_FRAME_GAP_MS)
    await orcaPage.evaluate(() => (window as PerformanceProbeWindow).__cmdJPerformanceProbe?.stop())
  })
})
