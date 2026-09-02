import type { ResourceReservationRequest } from '../../../../shared/resource-reservation-binding'
import type { RuntimeWorktreeCreateResult } from '../../../../shared/runtime-types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { ResourceReservationConflictError } from '../../resource-reservation-conflict'

/** Returns the workspace an earlier create already bound to this key, or null when the key is
 *  unused. Throws on a reused key whose binding disagrees — a conflict is never a silent replay. */
export async function replayReservedManagedWorktree(
  runtime: Pick<OrcaRuntimeService, 'findManagedWorktreeReservation' | 'showManagedWorktree'>,
  request: ResourceReservationRequest
): Promise<RuntimeWorktreeCreateResult | null> {
  const lookup = runtime.findManagedWorktreeReservation(request)
  if (lookup.outcome === 'conflict') {
    throw new ResourceReservationConflictError(lookup.message, {
      resourceKind: 'worktree',
      resourceId: lookup.worktreeId
    })
  }
  if (lookup.outcome === 'unbound') {
    return null
  }
  const worktree = await runtime.showManagedWorktree(`id:${lookup.worktreeId}`)
  return {
    worktree,
    lineage: worktree.lineage ?? null,
    ...(worktree.workspaceLineage !== undefined
      ? { workspaceLineage: worktree.workspaceLineage }
      : {}),
    warnings: []
  }
}
