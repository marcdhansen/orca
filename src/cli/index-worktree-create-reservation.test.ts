import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { RESOURCE_RESERVATION_ATTRIBUTION_RUNTIME_CAPABILITY } from '../shared/protocol-version'
import { buildWorktree, okFixture, queueFixtures } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

const RESERVATION_ARGS = [
  '--idempotency-key',
  'key-1',
  '--reservation-id',
  'res-1',
  '--reservation-session',
  'session-1',
  '--ownership-generation',
  '7',
  '--reservation-issuer',
  'openloop'
]

const RESERVATION_PARAM = {
  key: 'key-1',
  reservationId: 'res-1',
  sessionId: 'session-1',
  resourceKind: 'worktree',
  ownershipGeneration: 7,
  issuer: 'openloop'
}

function statusFixture(capabilities: string[]) {
  return okFixture('req_status', { runtimeId: 'runtime-1', capabilities })
}

function createdWorktreeFixture(reservation: unknown) {
  return okFixture('req_create', {
    worktree: {
      ...buildWorktree('/tmp/repo/child', 'child', 'abc', 'repo-1'),
      ...(reservation === undefined ? {} : { reservation })
    },
    lineage: null,
    warnings: []
  })
}

function silenceOutput(): void {
  process.exitCode = undefined
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
}

/** --no-parent with an explicit --repo keeps the run free of cwd-inference RPCs, so every
 *  assertion below is about the reservation calls and nothing else. */
const CREATE_ARGS = ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'child', '--no-parent']

describe('orca worktree create reservation binding', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('sends the caller-generated binding after the host advertises support', async () => {
    queueFixtures(
      callMock,
      statusFixture([RESOURCE_RESERVATION_ATTRIBUTION_RUNTIME_CAPABILITY]),
      createdWorktreeFixture({ ...RESERVATION_PARAM, boundAt: 42 })
    )
    silenceOutput()

    await main([...CREATE_ARGS, ...RESERVATION_ARGS, '--json'], '/tmp/elsewhere')

    expect(callMock).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({ reservation: RESERVATION_PARAM })
    )
    expect(process.exitCode).toBeFalsy()
  })

  it('refuses before creating anything when the host does not advertise the capability', async () => {
    queueFixtures(callMock, statusFixture(['worktree.create-idempotency.v1']))
    silenceOutput()

    await main([...CREATE_ARGS, ...RESERVATION_ARGS, '--json'], '/tmp/elsewhere')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).not.toHaveBeenCalledWith('worktree.create', expect.anything())
    expect(process.exitCode).toBe(1)
  })

  it('refuses a create whose reply carries no binding back', async () => {
    queueFixtures(
      callMock,
      statusFixture([RESOURCE_RESERVATION_ATTRIBUTION_RUNTIME_CAPABILITY]),
      createdWorktreeFixture(undefined)
    )
    silenceOutput()

    await main([...CREATE_ARGS, ...RESERVATION_ARGS, '--json'], '/tmp/elsewhere')

    expect(process.exitCode).toBe(1)
  })

  it('sends no reservation and probes no capability without the flags', async () => {
    queueFixtures(callMock, createdWorktreeFixture(undefined))
    silenceOutput()

    await main([...CREATE_ARGS, '--json'], '/tmp/elsewhere')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith(
      'worktree.create',
      expect.not.objectContaining({ reservation: expect.anything() })
    )
  })

  it('refuses a partial binding rather than creating an unattributable workspace', async () => {
    silenceOutput()

    await main([...CREATE_ARGS, '--idempotency-key', 'key-1', '--json'], '/tmp/elsewhere')

    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })
})
