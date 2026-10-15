export type ModelCapacityRecoveryPhase =
  | 'ARMED'
  | 'WAITING'
  | 'SUBMITTING'
  | 'RETRYING'
  | 'SUCCEEDED'
  | 'ATTENTION'
  | 'AMBIGUOUS'

export type ModelCapacityRecoveryRecord = {
  version: 1
  ptyId: string
  envelopeId: string
  messageDigest: string
  providerTurnId: string | null
  identity: string
  phase: ModelCapacityRecoveryPhase
  generation: number
  attempts: number
  createdAt: number
  updatedAt: number
  attentionReason?: string
}

export type ModelCapacityRecoveryLedger = Record<string, ModelCapacityRecoveryRecord>
