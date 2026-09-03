import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { RuntimeManagedWorktreeQueries } from './runtime-managed-worktree-queries'
import type { RuntimeStore } from './runtime-store-contract'

const settings = {
  workspaceDir: '/worktrees',
  nestWorkspaces: true,
  refreshLocalBaseRefOnWorktreeCreate: false,
  branchPrefix: 'none',
  branchPrefixCustom: ''
}

function folderRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/workspace/app',
    displayName: 'Local app',
    badgeColor: '#000000',
    addedAt: 1,
    kind: 'folder',
    ...overrides
  }
}

function metadata(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function queries(store: RuntimeStore): RuntimeManagedWorktreeQueries {
  return new RuntimeManagedWorktreeQueries({
    getStore: () => store,
    listResolved: async () => [],
    resolveRepo: async () => store.getRepos()[0]!,
    selectRepos: () => store.getRepos(),
    scanRepo: async () => ({ ok: true, worktrees: [] })
  })
}

describe('RuntimeManagedWorktreeQueries.listDetected', () => {
  it('revalidates a referenced cross-repo parent instead of trusting a warm stale fleet', async () => {
    const childRepo = { ...folderRepo({ id: 'child-repo', path: '/child' }), kind: 'git' as const }
    const parentRepo = {
      ...folderRepo({ id: 'parent-repo', path: '/parent' }),
      kind: 'git' as const
    }
    const childId = 'child-repo::/child/worktree'
    const parentId = 'parent-repo::/parent/deleted'
    const childMeta = metadata({ hostId: 'local', instanceId: 'child-instance' })
    const staleParentMeta = metadata({ hostId: 'local', instanceId: 'parent-instance' })
    const workspaceLineage = {
      childWorkspaceKey: `worktree:${childId}`,
      childInstanceId: 'child-instance',
      parentWorkspaceKey: `worktree:${parentId}`,
      parentInstanceId: 'parent-instance',
      origin: 'orchestration' as const,
      capture: { source: 'orchestration-context' as const, confidence: 'inferred' as const },
      createdAt: 1
    }
    const store = {
      getRepos: () => [childRepo, parentRepo],
      getRepo: (id: string) => (id === parentRepo.id ? parentRepo : childRepo),
      getFolderWorkspaces: () => [],
      getProjectGroups: () => [],
      getAllWorktreeMeta: () => ({ [childId]: childMeta, [parentId]: staleParentMeta }),
      getWorktreeMeta: (id: string) => ({ [childId]: childMeta, [parentId]: staleParentMeta })[id],
      setWorktreeMeta: vi.fn((_id, updates) => metadata(updates)),
      getAllWorktreeLineage: () => ({}),
      getAllWorkspaceLineage: () => ({ [workspaceLineage.childWorkspaceKey]: workspaceLineage }),
      getSettings: () => settings
    } as unknown as RuntimeStore
    const listResolved = vi.fn(
      async () =>
        [
          { id: parentId, repoId: parentRepo.id, hostId: 'local', instanceId: 'parent-instance' }
        ] as never
    )
    let parentScanCacheWarm = true
    const invalidateRepoScan = vi.fn((repoId: string) => {
      if (repoId === parentRepo.id) {
        parentScanCacheWarm = false
      }
    })
    const scanRepo = vi.fn(async (repo: Repo) => ({
      ok: true as const,
      worktrees:
        repo.id === childRepo.id
          ? [
              {
                path: '/child/worktree',
                head: 'abc',
                branch: 'feature',
                isBare: false,
                isMainWorktree: false
              }
            ]
          : parentScanCacheWarm
            ? [
                {
                  path: '/parent/deleted',
                  head: 'stale',
                  branch: 'deleted',
                  isBare: false,
                  isMainWorktree: false
                }
              ]
            : []
    }))
    const subject = new RuntimeManagedWorktreeQueries({
      getStore: () => store,
      listResolved,
      resolveRepo: async () => childRepo,
      selectRepos: () => [childRepo],
      scanRepo,
      invalidateRepoScan
    })

    const result = await subject.listDetected(childRepo)

    expect(
      (result.worktrees[0] as (typeof result.worktrees)[0] & { workspaceLineage: unknown })
        .workspaceLineage
    ).toBeNull()
    expect(scanRepo.mock.calls.map(([repo]) => repo.id)).toEqual(['child-repo', 'parent-repo'])
    expect(invalidateRepoScan).toHaveBeenCalledExactlyOnceWith('parent-repo')
    expect(listResolved).not.toHaveBeenCalled()
  })

  it("does not project another host's folder metadata", async () => {
    const local = folderRepo()
    const remote = folderRepo({ connectionId: 'build-box', displayName: 'Remote app' })
    const rootId = `${local.id}::${local.path}`
    const foreignMeta = metadata({ displayName: 'Wrong host', hostId: 'ssh:build-box' })
    const store = {
      getRepos: () => [local, remote],
      getRepo: () => local,
      getAllWorktreeMeta: () => ({ [rootId]: foreignMeta }),
      getWorktreeMeta: () => foreignMeta,
      setWorktreeMeta: vi.fn(),
      getAllWorktreeLineage: () => ({}),
      getSettings: () => settings
    } as unknown as RuntimeStore

    const result = await queries(store).listDetected(local)

    expect(result.worktrees).toHaveLength(1)
    expect(result.worktrees[0]).toMatchObject({
      id: rootId,
      hostId: 'local',
      displayName: 'Local app'
    })
  })

  it('omits host-owned source defaults for clients that do not support them', async () => {
    const repo = folderRepo({ path: '/source/app' })
    const store = {
      getRepos: () => [repo],
      getRepo: () => repo,
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: vi.fn((_id, updates) => metadata(updates)),
      getAllWorktreeLineage: () => ({}),
      getSettings: () => ({
        ...settings,
        worktreeVisibilityDefaults: {
          external: 'show' as const,
          customSources: [{ id: 'host-source', rootPath: '/source' }],
          sourcePreferences: { custom: { 'host-source': 'show' as const } }
        }
      })
    } as unknown as RuntimeStore

    const current = await queries(store).listDetected(repo, true)
    const legacy = await queries(store).listDetected(repo, false)

    expect(current.worktrees[0]).toMatchObject({
      visibilitySource: { kind: 'custom', id: 'host-source' }
    })
    expect(legacy.worktrees[0]).not.toHaveProperty('visibilitySource')
  })
})
