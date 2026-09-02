import {
  describeResourceReservationConflict,
  resourceReservationBindingMatchesRequest,
  type ResourceReservationBinding,
  type ResourceReservationRequest
} from '../../shared/resource-reservation-binding'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

export type WorktreeReservationLookup =
  | { outcome: 'unbound' }
  | { outcome: 'replay'; worktreeId: string; binding: ResourceReservationBinding }
  | { outcome: 'conflict'; worktreeId: string; message: string }

/** Durable replay lookup: the binding lives in persisted workspace metadata, so a retry after a
 *  lost reply — or after a host restart — resolves to the same workspace instead of a duplicate. */
export function findWorktreeReservation(
  allMeta: Readonly<Record<string, WorktreeMeta | undefined>> | undefined,
  request: ResourceReservationRequest
): WorktreeReservationLookup {
  for (const [worktreeId, meta] of Object.entries(allMeta ?? {})) {
    const binding = meta?.reservation
    if (!binding || binding.key !== request.key) {
      continue
    }
    return resourceReservationBindingMatchesRequest(binding, request)
      ? { outcome: 'replay', worktreeId, binding }
      : {
          outcome: 'conflict',
          worktreeId,
          message: describeResourceReservationConflict(binding, request, worktreeId)
        }
  }
  return { outcome: 'unbound' }
}
