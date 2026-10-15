import { randomUUID } from 'node:crypto'
import type {
  ModelCapacityRecoveryLedger,
  ModelCapacityRecoveryRecord
} from '../../shared/model-capacity-recovery'
import {
  capacityRecoveryMessageDigest,
  classifyModelCapacityRollout,
  type ModelCapacityRolloutMatch
} from './model-capacity-rollout-classifier'

export {
  capacityRecoveryMessageDigest,
  classifyModelCapacityRollout,
  MODEL_CAPACITY_ERROR_V1
} from './model-capacity-rollout-classifier'
export const MODEL_CAPACITY_RETRY_DELAYS_MS = [5_000, 15_000, 45_000] as const
export const MODEL_CAPACITY_RECOVERY_DEADLINE_MS = 120_000

export type CapacityRecoveryPersistence = {
  getModelCapacityRecoveryLedger(): ModelCapacityRecoveryLedger
  replaceModelCapacityRecoveryLedgerAndFlush(ledger: ModelCapacityRecoveryLedger): void
}

export type CapacityRecoveryEnvelope = Readonly<{
  version: 1
  envelopeId: string
  ptyId: string
  input: string
  messageDigest: string
  identity: string
  createdAt: number
}>

export type CapacityRecoveryObservation = {
  records: readonly unknown[]
  identity: string
  providerTurnId?: string
}

export class AgentPromptSubmissionRuntime {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly generations = new Map<string, number>()
  private readonly envelopes = new Map<string, CapacityRecoveryEnvelope>()
  private memoryLedger: ModelCapacityRecoveryLedger = {}

  constructor(
    private readonly persistence: () => CapacityRecoveryPersistence | null,
    private readonly now: () => number = Date.now,
    private readonly delay: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  hydrate(): void {
    const store = this.persistence()
    if (!store) {
      return
    }
    const ledger = store.getModelCapacityRecoveryLedger()
    let changed = false
    for (const [ptyId, record] of Object.entries(ledger)) {
      if (record.phase === 'SUBMITTING' || record.phase === 'RETRYING') {
        ledger[ptyId] = this.attention(record, 'AMBIGUOUS', 'restart_during_delivery')
        changed = true
      }
    }
    if (changed) {
      store.replaceModelCapacityRecoveryLedgerAndFlush(ledger)
    }
  }

  serializeInput<T>(ptyId: string, operation: () => Promise<T>): Promise<T> {
    // Invalidate synchronously before joining the queue: keyboard/paste input that arrives
    // during a retry delay must fence delivery, not wait behind it.
    this.invalidate(ptyId, 'terminal_input')
    return operation()
  }

  submitOwnedPrompt<T>(
    ptyId: string,
    input: string,
    identity: string,
    operation: () => Promise<T>
  ): Promise<T> {
    this.invalidate(ptyId, 'new_owned_prompt')
    const envelope = Object.freeze({
      version: 1 as const,
      envelopeId: randomUUID(),
      ptyId,
      input,
      messageDigest: capacityRecoveryMessageDigest(input),
      identity,
      createdAt: this.now()
    })
    this.envelopes.set(ptyId, envelope)
    this.persist({
      version: 1,
      ptyId,
      envelopeId: envelope.envelopeId,
      messageDigest: envelope.messageDigest,
      providerTurnId: null,
      identity,
      phase: 'ARMED',
      generation: this.generation(ptyId),
      attempts: 0,
      createdAt: envelope.createdAt,
      updatedAt: envelope.createdAt
    })
    return operation()
  }

  async recover(
    ptyId: string,
    observation: CapacityRecoveryObservation,
    deliver: (exactInput: string) => Promise<void>
  ): Promise<'replayed' | 'attention' | 'ignored'> {
    const match = classifyModelCapacityRollout(observation.records)
    if (!match) {
      return 'ignored'
    }
    return this.serialized(ptyId, async () => {
      const envelope = this.envelopes.get(ptyId)
      const current = this.read(ptyId)
      if (!envelope || !current) {
        return this.markAttention(ptyId, 'unowned_input', match)
      }
      if (
        envelope.identity !== observation.identity ||
        current.identity !== observation.identity ||
        envelope.messageDigest !== match.messageDigest ||
        (observation.providerTurnId && observation.providerTurnId !== match.providerTurnId)
      ) {
        return this.markAttention(ptyId, 'identity_or_envelope_mismatch', match)
      }
      if (current.generation !== this.generation(ptyId)) {
        return this.markAttention(ptyId, 'input_generation_changed', match)
      }
      if (current.phase === 'SUBMITTING' || current.phase === 'RETRYING') {
        return 'ignored'
      }
      if (current.phase === 'WAITING' && current.providerTurnId === match.providerTurnId) {
        return 'ignored'
      }
      if (current.attempts >= MODEL_CAPACITY_RETRY_DELAYS_MS.length) {
        return this.markAttention(ptyId, 'retry_exhausted', match)
      }
      const elapsed = this.now() - current.createdAt
      const waitMs = MODEL_CAPACITY_RETRY_DELAYS_MS[current.attempts]
      if (elapsed + waitMs > MODEL_CAPACITY_RECOVERY_DEADLINE_MS) {
        return this.markAttention(ptyId, 'deadline_exhausted', match)
      }
      const reserved = {
        ...current,
        providerTurnId: match.providerTurnId,
        phase: 'RETRYING' as const,
        attempts: current.attempts + 1,
        updatedAt: this.now()
      }
      this.persist(reserved)
      await this.delay(waitMs)
      if (
        reserved.generation !== this.generation(ptyId) ||
        this.read(ptyId)?.phase !== 'RETRYING'
      ) {
        return 'attention'
      }
      this.persist({ ...reserved, phase: 'SUBMITTING', updatedAt: this.now() })
      try {
        await deliver(envelope.input)
      } catch (error) {
        this.persistTerminal(reserved, 'AMBIGUOUS', 'delivery_uncertain')
        throw error
      }
      this.persist({ ...reserved, phase: 'WAITING', updatedAt: this.now() })
      return 'replayed'
    })
  }

  private serialized<T>(ptyId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(ptyId)
    const result = previous ? previous.catch(() => undefined).then(operation) : operation()
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.tails.set(ptyId, tail)
    void tail.finally(() => {
      if (this.tails.get(ptyId) === tail) {
        this.tails.delete(ptyId)
      }
    })
    return result
  }

  private generation(ptyId: string): number {
    return this.generations.get(ptyId) ?? 0
  }

  private invalidate(ptyId: string, reason: string): void {
    this.generations.set(ptyId, this.generation(ptyId) + 1)
    const current = this.read(ptyId)
    if (current && !['SUCCEEDED', 'ATTENTION', 'AMBIGUOUS'].includes(current.phase)) {
      this.persistTerminal(current, 'ATTENTION', reason)
    }
    this.envelopes.delete(ptyId)
  }

  private read(ptyId: string): ModelCapacityRecoveryRecord | null {
    return (
      (this.persistence()?.getModelCapacityRecoveryLedger() ?? this.memoryLedger)[ptyId] ?? null
    )
  }

  private persist(record: ModelCapacityRecoveryRecord): void {
    const store = this.persistence()
    const ledger = store?.getModelCapacityRecoveryLedger() ?? structuredClone(this.memoryLedger)
    ledger[record.ptyId] = record
    if (store) {
      store.replaceModelCapacityRecoveryLedgerAndFlush(ledger)
    } else {
      this.memoryLedger = ledger
    }
  }

  private attention(
    record: ModelCapacityRecoveryRecord,
    phase: 'ATTENTION' | 'AMBIGUOUS',
    reason: string
  ): ModelCapacityRecoveryRecord {
    return { ...record, phase, attentionReason: reason, updatedAt: this.now() }
  }

  private persistTerminal(
    record: ModelCapacityRecoveryRecord,
    phase: 'ATTENTION' | 'AMBIGUOUS',
    reason: string
  ): void {
    this.envelopes.delete(record.ptyId)
    this.persist(this.attention(record, phase, reason))
  }

  private markAttention(
    ptyId: string,
    reason: string,
    match: ModelCapacityRolloutMatch
  ): 'attention' {
    const current = this.read(ptyId)
    const now = this.now()
    this.persistTerminal(
      current ?? {
        version: 1,
        ptyId,
        envelopeId: 'redacted-unowned',
        messageDigest: match.messageDigest,
        providerTurnId: match.providerTurnId,
        identity: 'unowned',
        phase: 'ATTENTION',
        generation: this.generation(ptyId),
        attempts: 0,
        createdAt: now,
        updatedAt: now
      },
      'ATTENTION',
      reason
    )
    return 'attention'
  }
}
