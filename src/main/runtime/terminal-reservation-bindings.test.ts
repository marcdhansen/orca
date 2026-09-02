import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildResourceReservationBinding } from '../../shared/resource-reservation-binding'
import type { ResourceReservationRequest } from '../../shared/resource-reservation-binding'
import { TerminalReservationBindings } from './terminal-reservation-bindings'

const REQUEST: ResourceReservationRequest = {
  key: 'key-1',
  reservationId: 'res-1',
  sessionId: 'session-1',
  resourceKind: 'terminal',
  ownershipGeneration: 1
}

describe('terminal reservation bindings', () => {
  it('binds once and replays the first binding for an identical retry', () => {
    const registry = new TerminalReservationBindings()
    const first = buildResourceReservationBinding(REQUEST, { boundAt: 1 })
    const second = buildResourceReservationBinding(REQUEST, { boundAt: 2 })

    expect(registry.bind('term_a', first)).toEqual({ outcome: 'bound' })
    expect(registry.bind('term_a', second)).toEqual({ outcome: 'replay', binding: first })
    expect(registry.get('term_a')).toEqual(first)
  })

  it('refuses the same key against a second terminal handle', () => {
    const registry = new TerminalReservationBindings()
    registry.bind('term_a', buildResourceReservationBinding(REQUEST, { boundAt: 1 }))

    const result = registry.bind('term_b', buildResourceReservationBinding(REQUEST, { boundAt: 2 }))

    expect(result.outcome).toBe('conflict')
  })

  it('refuses a reused key whose session changed before anything is created', () => {
    const registry = new TerminalReservationBindings()
    registry.bind('term_a', buildResourceReservationBinding(REQUEST, { boundAt: 1 }))

    expect(registry.assertBindable('term_a', { ...REQUEST, sessionId: 'session-2' })).toContain(
      'single-use'
    )
  })

  it('lets an untouched key bind', () => {
    const registry = new TerminalReservationBindings()

    expect(registry.assertBindable('term_a', REQUEST)).toBeNull()
  })

  it('reloads an immutable claim after runtime restart', () => {
    const profile = mkdtempSync(join(tmpdir(), 'orca-terminal-reservations-'))
    const first = new TerminalReservationBindings(profile)
    const binding = buildResourceReservationBinding(REQUEST, { boundAt: 1 })
    first.claim('term_a', binding)

    const restarted = new TerminalReservationBindings(profile)
    expect(restarted.get('term_a')).toEqual(binding)
    expect(restarted.claim('term_a', { ...binding, boundAt: 2 })).toEqual({
      outcome: 'replay',
      binding
    })
  })
})
