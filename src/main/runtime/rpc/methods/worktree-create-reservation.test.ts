import { describe, expect, it, vi } from 'vitest'
import { buildResourceReservationBinding } from '../../../../shared/resource-reservation-binding'
import type { ResourceReservationRequest } from '../../../../shared/resource-reservation-binding'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WorktreeCreate } from './worktree-create-schemas'
import { replayReservedManagedWorktree } from './worktree-create-reservation'

const REQUEST: ResourceReservationRequest = {
  key: 'key-1',
  reservationId: 'res-1',
  sessionId: 'session-1',
  resourceKind: 'worktree',
  ownershipGeneration: 2
}

const BINDING = buildResourceReservationBinding(REQUEST, { boundAt: 5 })

function runtimeWith(
  lookup: ReturnType<OrcaRuntimeService['findManagedWorktreeReservation']>,
  worktree: unknown = { id: 'repo-1::/tmp/wt', reservation: BINDING, lineage: null }
) {
  return {
    findManagedWorktreeReservation: vi.fn(() => lookup),
    showReservedManagedWorktree: vi.fn(async () => worktree)
  } as unknown as Pick<
    OrcaRuntimeService,
    'findManagedWorktreeReservation' | 'showReservedManagedWorktree'
  >
}

describe('worktree.create reservation replay', () => {
  it('lets an unused key fall through to a real create', async () => {
    const runtime = runtimeWith({ outcome: 'unbound' })

    await expect(replayReservedManagedWorktree(runtime, REQUEST)).resolves.toBeNull()
    expect(runtime.showReservedManagedWorktree).not.toHaveBeenCalled()
  })

  it('returns the already-bound workspace instead of creating a second one', async () => {
    const runtime = runtimeWith({
      outcome: 'replay',
      worktreeId: 'repo-1::/tmp/wt',
      hostId: 'local',
      instanceId: 'instance-1',
      binding: BINDING
    })

    const result = await replayReservedManagedWorktree(runtime, REQUEST)

    expect(runtime.showReservedManagedWorktree).toHaveBeenCalledWith(
      'repo-1::/tmp/wt',
      'local',
      'instance-1'
    )
    expect(result?.worktree.reservation).toEqual(BINDING)
    expect(result?.warnings).toEqual([])
  })

  it('refuses a reused key whose binding disagrees rather than replaying it', async () => {
    const runtime = runtimeWith({
      outcome: 'conflict',
      worktreeId: 'repo-1::/tmp/wt',
      message: 'Reservation key "key-1" is already bound'
    })

    await expect(replayReservedManagedWorktree(runtime, REQUEST)).rejects.toMatchObject({
      code: 'reservation_conflict',
      data: { resourceKind: 'worktree', resourceId: 'repo-1::/tmp/wt' }
    })
    expect(runtime.showReservedManagedWorktree).not.toHaveBeenCalled()
  })
})

describe('worktree.create reservation schema', () => {
  it('refuses a terminal reservation aimed at the workspace create surface', () => {
    const parsed = WorktreeCreate.safeParse({
      repo: 'id:repo-1',
      name: 'child',
      reservation: { ...REQUEST, resourceKind: 'terminal' }
    })

    expect(parsed.success).toBe(false)
  })

  it('accepts a workspace reservation', () => {
    const parsed = WorktreeCreate.safeParse({
      repo: 'id:repo-1',
      name: 'child',
      reservation: REQUEST
    })

    expect(parsed.success).toBe(true)
  })

  it('refuses a reservation missing its ledger fields', () => {
    const parsed = WorktreeCreate.safeParse({
      repo: 'id:repo-1',
      name: 'child',
      reservation: { key: 'key-1', resourceKind: 'worktree', ownershipGeneration: 1 }
    })

    expect(parsed.success).toBe(false)
  })
})
