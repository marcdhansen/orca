import { describe, expect, it } from 'vitest'
import {
  projectCurrentHostWorktreeLineage,
  projectWithCurrentReferencedParents
} from './runtime-worktree-lineage-projection'
import type { WorkspaceLineage } from '../../shared/worktree/lineage-types'
import type { Worktree } from '../../shared/worktree/types'

const child = {
  id: 'target::/child',
  repoId: 'target',
  hostId: 'local',
  instanceId: 'child-instance'
} as Worktree
const parentId = 'source::/deleted-parent'
const ancestry: WorkspaceLineage = {
  childWorkspaceKey: `worktree:${child.id}`,
  childInstanceId: child.instanceId,
  parentWorkspaceKey: `worktree:${parentId}`,
  parentInstanceId: 'stale-parent-instance',
  origin: 'orchestration',
  capture: { source: 'orchestration-context', confidence: 'inferred' },
  createdAt: 1
}

function store() {
  const metadata = {
    [child.id]: { hostId: 'local', instanceId: child.instanceId },
    [parentId]: { hostId: 'local', instanceId: 'stale-parent-instance' }
  }
  return {
    getRepos: () => [
      { id: 'target', path: '/target', executionHostId: 'local' },
      { id: 'source', path: '/source', executionHostId: 'local' }
    ],
    getFolderWorkspaces: () => [],
    getProjectGroups: () => [],
    getWorktreeMeta: (id: string) => metadata[id as keyof typeof metadata],
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({ [ancestry.childWorkspaceKey]: ancestry })
  }
}

describe('current-host worktree lineage projection', () => {
  it('rejects stale parent metadata when the current parent repository scan has no row', () => {
    const [projected] = projectCurrentHostWorktreeLineage({
      worktrees: [child],
      currentFleet: [child],
      store: store() as never,
      executionHostId: 'local'
    })

    expect(projected.workspaceLineage).toBeNull()
  })

  it('accepts ancestry when the current parent repository row proves the same instance', () => {
    const [projected] = projectCurrentHostWorktreeLineage({
      worktrees: [child],
      currentFleet: [
        child,
        {
          id: parentId,
          repoId: 'source',
          hostId: 'local',
          instanceId: 'stale-parent-instance'
        } as Worktree
      ],
      store: store() as never,
      executionHostId: 'local'
    })

    expect(projected.workspaceLineage).toEqual(ancestry)
  })

  it('keeps the child usable and removes stale lineage when the parent scan rejects', async () => {
    const [projected] = await projectWithCurrentReferencedParents({
      worktrees: [child],
      childRepoId: child.repoId,
      executionHostId: 'local',
      store: store() as never,
      scanRepo: async () => {
        throw new Error('parent host unavailable')
      }
    })

    expect(projected.id).toBe(child.id)
    expect(projected.workspaceLineage).toBeNull()
  })
})
