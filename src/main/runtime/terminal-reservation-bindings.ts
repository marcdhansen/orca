import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  describeResourceReservationConflict,
  resourceReservationBindingMatchesRequest,
  type ResourceReservationBinding,
  type ResourceReservationRequest
} from '../../shared/resource-reservation-binding'

const TERMINAL_RESERVATIONS_FILE = 'terminal-reservations.json'

export type TerminalReservationBindResult =
  | { outcome: 'bound' }
  | { outcome: 'replay'; binding: ResourceReservationBinding }
  | { outcome: 'conflict'; message: string }

/** Durable reservation authority. Claims are persisted before provider mutation. */
export class TerminalReservationBindings {
  private readonly byHandle = new Map<string, ResourceReservationBinding>()
  private readonly handleByKey = new Map<string, string>()
  private storagePath: string | null = null

  constructor(profileStorageDirectory?: string) {
    if (profileStorageDirectory) {
      this.configurePersistence(profileStorageDirectory)
    }
  }

  configurePersistence(profileStorageDirectory: string): void {
    this.storagePath = join(profileStorageDirectory, TERMINAL_RESERVATIONS_FILE)
    this.hydrate()
  }

  /** Atomically claims a key before creation, or returns its immutable prior binding. */
  claim(handle: string, binding: ResourceReservationBinding): TerminalReservationBindResult {
    const existing = this.inspect(handle, binding)
    if (existing) {
      return existing
    }
    this.byHandle.set(handle, binding)
    this.handleByKey.set(binding.key, handle)
    try {
      this.persist()
    } catch (error) {
      this.byHandle.delete(handle)
      this.handleByKey.delete(binding.key)
      throw error
    }
    return { outcome: 'bound' }
  }

  bind(handle: string, binding: ResourceReservationBinding): TerminalReservationBindResult {
    return this.claim(handle, binding)
  }

  /** Releases only the exact claim owned by a failed create attempt. */
  release(handle: string, binding: ResourceReservationBinding): void {
    if (this.byHandle.get(handle) !== binding || this.handleByKey.get(binding.key) !== handle) {
      return
    }
    this.byHandle.delete(handle)
    this.handleByKey.delete(binding.key)
    this.persist()
  }

  assertBindable(handle: string, request: ResourceReservationRequest): string | null {
    const result = this.inspect(handle, request)
    return result?.outcome === 'conflict' ? result.message : null
  }

  get(handle: string): ResourceReservationBinding | undefined {
    return this.byHandle.get(handle)
  }

  private inspect(
    handle: string,
    request: ResourceReservationRequest
  ): Exclude<TerminalReservationBindResult, { outcome: 'bound' }> | null {
    const existingHandle = this.handleByKey.get(request.key)
    const existing = existingHandle ? this.byHandle.get(existingHandle) : undefined
    if (!existing || !existingHandle) {
      return null
    }
    if (existingHandle !== handle || !resourceReservationBindingMatchesRequest(existing, request)) {
      return {
        outcome: 'conflict',
        message: describeResourceReservationConflict(existing, request, existingHandle)
      }
    }
    return { outcome: 'replay', binding: existing }
  }

  private hydrate(): void {
    if (!this.storagePath) {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.storagePath, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }
      throw error
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Invalid terminal reservation store: ${this.storagePath}`)
    }
    for (const entry of parsed) {
      const { handle, binding } = (entry ?? {}) as {
        handle?: unknown
        binding?: ResourceReservationBinding
      }
      if (typeof handle !== 'string' || !binding || typeof binding.key !== 'string') {
        throw new Error(`Invalid terminal reservation entry: ${this.storagePath}`)
      }
      this.byHandle.set(handle, binding)
      this.handleByKey.set(binding.key, handle)
    }
  }

  private persist(): void {
    if (!this.storagePath) {
      return
    }
    mkdirSync(dirname(this.storagePath), { recursive: true })
    const temporaryPath = `${this.storagePath}.tmp`
    const entries = [...this.byHandle].map(([handle, binding]) => ({ handle, binding }))
    writeFileSync(temporaryPath, `${JSON.stringify(entries)}\n`, { mode: 0o600 })
    renameSync(temporaryPath, this.storagePath)
  }
}
