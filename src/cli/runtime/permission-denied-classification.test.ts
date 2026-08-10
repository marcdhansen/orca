import { EventEmitter } from 'node:events'
import type * as NodeNet from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getRuntimeMetadataPath, type RuntimeMetadata } from '../../shared/runtime-bootstrap'
// vi.mock below is hoisted above these imports, so both modules load against the
// faked connection factory.
import { getCliStatus } from './status'
import { sendRequest } from './transport'

// Why: a real permission-denied connect is not reproducible across platforms —
// a root CI user bypasses Unix mode bits and Windows guards named pipes by ACL.
// Faking the connect keeps the classification itself under test everywhere,
// including Windows, where the named-pipe path is exactly where this bug bites.
const { nextConnection } = vi.hoisted(() => ({
  nextConnection: { create: null as null | (() => EventEmitter) }
}))

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeNet>()
  return {
    ...actual,
    createConnection: (...args: unknown[]) => {
      const create = nextConnection.create
      if (!create) {
        return (actual.createConnection as (...a: unknown[]) => unknown)(...args)
      }
      return create()
    }
  }
})

afterEach(() => {
  nextConnection.create = null
})

// Emits 'error' then 'close', matching Node's real ordering — the close handler
// must not overwrite the classified error that the error handler already settled.
function failConnectWith(code: string): void {
  nextConnection.create = () => {
    const socket = new EventEmitter() as EventEmitter & Record<string, unknown>
    socket.setEncoding = () => socket
    socket.write = () => true
    socket.end = () => socket
    socket.destroy = () => socket
    setImmediate(() => {
      socket.emit('error', Object.assign(new Error(`connect ${code}`), { code }))
      socket.emit('close')
    })
    return socket
  }
}

const metadata: RuntimeMetadata = {
  runtimeId: 'runtime-1',
  pid: process.pid,
  transports: [{ kind: 'unix', endpoint: '/tmp/orca-guarded.sock' }],
  authToken: 'token',
  startedAt: 1
}

describe('runtime transport permission-denied classification', () => {
  it.each(['EACCES', 'EPERM'])('reports %s as permission denied, not unavailable', async (code) => {
    failConnectWith(code)

    // The old handler took no error parameter at all, so every failure collapsed
    // into 'runtime_unavailable' and the causing syscall code was unrecoverable.
    await expect(sendRequest(metadata, 'status.get', undefined, 1000)).rejects.toMatchObject({
      code: 'runtime_permission_denied',
      message: expect.stringContaining(code)
    })
  })

  it('still reports a refused connect as unavailable', async () => {
    failConnectWith('ECONNREFUSED')

    await expect(sendRequest(metadata, 'status.get', undefined, 1000)).rejects.toMatchObject({
      code: 'runtime_unavailable'
    })
  })
})

describe('CLI status permission-denied classification', () => {
  it('does not report a guarded endpoint as starting while the pid is alive', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-permission-'))
    writeFileSync(
      getRuntimeMetadataPath(userDataPath),
      JSON.stringify({
        runtimeId: 'runtime-1',
        // Why: this process is provably alive, which is the exact condition that
        // drove the old code down the 'starting' branch.
        pid: process.pid,
        transports: [{ kind: 'unix', endpoint: join(userDataPath, 'runtime.sock') }],
        authToken: 'token',
        startedAt: Date.now()
      })
    )
    failConnectWith('EACCES')

    const status = await getCliStatus(userDataPath)

    expect(status.result.runtime.state).not.toBe('starting')
    expect(status.result.graph.state).not.toBe('starting')
    expect(status.result.runtime).toMatchObject({
      state: 'permission_denied',
      reachable: false,
      runtimeId: null
    })
    // A live pid disproves 'not_running'; we were refused, not told it stopped.
    expect(status.result.graph.state).toBe('unavailable')
    expect(status.result.app.running).toBe(true)
  })
})
