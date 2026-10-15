import { createHash } from 'node:crypto'

export const MODEL_CAPACITY_ERROR_V1 =
  'Selected model is at capacity. Please try a different model.'

type JsonRecord = Record<string, unknown>

export type ModelCapacityRolloutMatch = {
  providerTurnId: string
  normalizedMessage: string
  messageDigest: string
}

function object(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null
}

function payload(record: JsonRecord): JsonRecord | null {
  return object(record.payload)
}

function recordKind(record: JsonRecord): string | null {
  return typeof record.type === 'string' ? record.type : null
}

export function normalizeCapacityRecoveryMessage(message: string): string {
  return message.replace(/\r\n/g, '\n')
}

export function capacityRecoveryMessageDigest(message: string): string {
  return createHash('sha256')
    .update(normalizeCapacityRecoveryMessage(message), 'utf8')
    .digest('hex')
}

function readTurnId(record: JsonRecord): string | null {
  const body = payload(record) ?? record
  for (const key of ['turn_id', 'turnId', 'id']) {
    if (typeof body[key] === 'string' && body[key]) {
      return body[key]
    }
  }
  return null
}

function readUserMessage(record: JsonRecord): string | null {
  const body = payload(record) ?? record
  if (body.type !== 'message' || body.role !== 'user') {
    return null
  }
  if (typeof body.content === 'string') {
    return body.content
  }
  if (!Array.isArray(body.content) || body.content.length !== 1) {
    return null
  }
  const item = object(body.content[0])
  return item && item.type === 'input_text' && typeof item.text === 'string' ? item.text : null
}

function readTerminalError(record: JsonRecord): string | null {
  const body = payload(record) ?? record
  if (body.type !== 'task_complete') {
    return null
  }
  if (typeof body.error === 'string') {
    return body.error
  }
  const error = object(body.error)
  return error && typeof error.message === 'string' ? error.message : null
}

export function classifyModelCapacityRollout(
  records: readonly unknown[]
): ModelCapacityRolloutMatch | null {
  if (records.length !== 4) {
    return null
  }
  const parsed = records.map(object)
  if (parsed.some((record) => !record)) {
    return null
  }
  const [started, context, user, complete] = parsed as JsonRecord[]
  if (recordKind(started) !== 'event_msg' || payload(started)?.type !== 'task_started') {
    return null
  }
  if (recordKind(context) !== 'turn_context') {
    return null
  }
  const startedTurnId = readTurnId(started)
  if (!startedTurnId || readTurnId(context) !== startedTurnId) {
    return null
  }
  if (recordKind(user) !== 'response_item') {
    return null
  }
  const message = readUserMessage(user)
  if (message === null) {
    return null
  }
  if (recordKind(complete) !== 'event_msg' || readTurnId(complete) !== startedTurnId) {
    return null
  }
  if (readTerminalError(complete) !== MODEL_CAPACITY_ERROR_V1) {
    return null
  }
  return {
    providerTurnId: startedTurnId,
    normalizedMessage: normalizeCapacityRecoveryMessage(message),
    messageDigest: capacityRecoveryMessageDigest(message)
  }
}
