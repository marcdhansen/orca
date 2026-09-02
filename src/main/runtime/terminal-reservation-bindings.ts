import {
  describeResourceReservationConflict,
  resourceReservationBindingMatchesRequest,
  type ResourceReservationBinding,
  type ResourceReservationRequest
} from '../../shared/resource-reservation-binding'

const DEFAULT_MAX_TERMINAL_RESERVATIONS = 4_096

export type TerminalReservationBindResult =
  | { outcome: 'bound' }
  | { outcome: 'replay'; binding: ResourceReservationBinding }
  | { outcome: 'conflict'; message: string }

/**
 * Handle → reservation binding for terminals. The handle a reserved create returns is derived
 * from the reservation key itself, so this registry is a projection cache, not the source of
 * identity: an evicted entry still re-derives to the same handle on retry.
 */
export class TerminalReservationBindings {
  private readonly byHandle = new Map<string, ResourceReservationBinding>()
  private readonly handleByKey = new Map<string, string>()

  constructor(private readonly maxEntries = DEFAULT_MAX_TERMINAL_RESERVATIONS) {}

  /** Records the binding, or reports why this key cannot bind to this handle. */
  bind(handle: string, binding: ResourceReservationBinding): TerminalReservationBindResult {
    const existingHandle = this.handleByKey.get(binding.key)
    const existing = existingHandle ? this.byHandle.get(existingHandle) : undefined
    if (existing && existingHandle) {
      if (
        existingHandle !== handle ||
        !resourceReservationBindingMatchesRequest(existing, binding)
      ) {
        return {
          outcome: 'conflict',
          message: describeResourceReservationConflict(existing, binding, existingHandle)
        }
      }
      return { outcome: 'replay', binding: existing }
    }
    this.evictOldestIfFull()
    this.byHandle.set(handle, binding)
    this.handleByKey.set(binding.key, handle)
    return { outcome: 'bound' }
  }

  /** Refuses a request whose key is already bound elsewhere, before any resource is created. */
  assertBindable(handle: string, request: ResourceReservationRequest): string | null {
    const existingHandle = this.handleByKey.get(request.key)
    if (!existingHandle) {
      return null
    }
    const existing = this.byHandle.get(existingHandle)
    if (!existing) {
      return null
    }
    if (existingHandle === handle && resourceReservationBindingMatchesRequest(existing, request)) {
      return null
    }
    return describeResourceReservationConflict(existing, request, existingHandle)
  }

  get(handle: string): ResourceReservationBinding | undefined {
    return this.byHandle.get(handle)
  }

  private evictOldestIfFull(): void {
    if (this.byHandle.size < this.maxEntries) {
      return
    }
    const oldest = this.byHandle.keys().next()
    if (oldest.done) {
      return
    }
    const evicted = this.byHandle.get(oldest.value)
    this.byHandle.delete(oldest.value)
    if (evicted && this.handleByKey.get(evicted.key) === oldest.value) {
      this.handleByKey.delete(evicted.key)
    }
  }
}
