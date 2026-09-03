import { filterLineageForHost } from '../ipc/worktrees/metadata/workspace-lineage-filtering'
import type { Store } from '../persistence'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { projectResolvedWorktreeLineage } from '../../shared/resolved-worktree-lineage'
import { worktreeWorkspaceKey } from '../../shared/workspace-scope'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'
import { readWorktreeMetaForHost } from '../persistence/host-qualified-worktree-meta'

/** Scan only cross-repository parents referenced by these children, bypassing warm fleet caches. */
export async function scanCurrentReferencedParentWorktrees(args: {
  children: readonly Worktree[]
  childRepoId: string
  executionHostId: ExecutionHostId
  store: RuntimeStore
  scanRepo(repo: Repo): Promise<RuntimeWorktreeScanResult>
  invalidateRepoScan?(repoId: string): void
}): Promise<Worktree[]> {
  const lineage = args.store.getAllWorkspaceLineage?.() ?? {}
  const parentRepoIds = new Set<string>()
  for (const child of args.children) {
    const parent = parseWorkspaceKey(
      lineage[worktreeWorkspaceKey(child.id)]?.parentWorkspaceKey ?? ''
    )
    if (parent?.type !== 'worktree') {
      continue
    }
    const parentId = splitWorktreeIdForFilesystem(parent.worktreeId)
    if (parentId?.repoId && parentId.repoId !== args.childRepoId) {
      parentRepoIds.add(parentId.repoId)
    }
  }
  const parents = args.store
    .getRepos()
    .filter(
      (repo) =>
        parentRepoIds.has(repo.id) &&
        repo.id !== args.childRepoId &&
        getRepoExecutionHostId(repo) === args.executionHostId
    )
  const scanned = await Promise.all(
    parents.map(async (repo) => {
      args.invalidateRepoScan?.(repo.id)
      try {
        return { repo, scan: await args.scanRepo(repo) }
      } catch {
        return { repo, scan: { ok: false as const, worktrees: [] } }
      }
    })
  )
  return scanned.flatMap(({ repo, scan }) =>
    scan.ok
      ? scan.worktrees.map((worktree) => {
          const id = `${repo.id}::${worktree.path}`
          const meta = readWorktreeMetaForHost(
            args.store as unknown as Store,
            id,
            args.executionHostId
          )
          return {
            id,
            repoId: repo.id,
            hostId: args.executionHostId,
            instanceId: meta?.instanceId
          } as Worktree
        })
      : []
  )
}

/** Revalidate referenced parents and project lineage as one authoritative query operation. */
export async function projectWithCurrentReferencedParents<T extends Worktree>(args: {
  worktrees: readonly T[]
  childRepoId: string
  executionHostId: ExecutionHostId
  store: RuntimeStore
  scanRepo(repo: Repo): Promise<RuntimeWorktreeScanResult>
  invalidateRepoScan?(repoId: string): void
}) {
  const parents = await scanCurrentReferencedParentWorktrees({
    children: args.worktrees,
    childRepoId: args.childRepoId,
    executionHostId: args.executionHostId,
    store: args.store,
    scanRepo: args.scanRepo,
    invalidateRepoScan: args.invalidateRepoScan
  })
  return projectCurrentHostWorktreeLineage({
    worktrees: args.worktrees,
    currentFleet: [...args.worktrees, ...parents],
    store: args.store,
    executionHostId: args.executionHostId
  })
}

/** Project lineage using host-owned edges and live scan rows, never stale metadata instances. */
export function projectCurrentHostWorktreeLineage<T extends Worktree>(args: {
  worktrees: readonly T[]
  currentFleet: readonly Worktree[]
  store: RuntimeStore
  executionHostId: ExecutionHostId
}) {
  const filterStore = args.store as unknown as Store
  const lineage =
    typeof filterStore.getFolderWorkspaces === 'function' &&
    typeof filterStore.getProjectGroups === 'function'
      ? filterLineageForHost(filterStore, args.executionHostId)
      : {
          worktreeLineageById: args.store.getAllWorktreeLineage?.() ?? {},
          workspaceLineageByChildKey: args.store.getAllWorkspaceLineage?.() ?? {}
        }
  if (!lineage) {
    return projectResolvedWorktreeLineage(args.worktrees, {}, {})
  }
  const currentInstances = args.currentFleet.reduce<Record<string, (string | undefined)[]>>(
    (instances, worktree) => {
      if (worktree.hostId === args.executionHostId) {
        ;(instances[worktreeWorkspaceKey(worktree.id)] ??= []).push(worktree.instanceId)
      }
      return instances
    },
    {}
  )
  return projectResolvedWorktreeLineage(
    args.worktrees,
    lineage.worktreeLineageById,
    lineage.workspaceLineageByChildKey,
    currentInstances
  )
}
