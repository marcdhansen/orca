import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LAUNCH_TOKEN_ECHO_PROTOCOL_VERSION } from '../../shared/agent-launch-token-echo-protocol'
import { SshPtyProvider } from './ssh-pty-provider'

describe('SSH launch-token echo negotiation', () => {
  const request = vi.fn()
  let provider: SshPtyProvider

  beforeEach(() => {
    request.mockReset()
    provider = new SshPtyProvider('conn-1', {
      request,
      notify: vi.fn(),
      onNotification: vi.fn(),
      dispose: vi.fn(),
      isDisposed: vi.fn(() => false)
    } as never)
  })

  function spawnParams(): Record<string, unknown> {
    const call = request.mock.calls.find(([method]) => method === 'pty.spawn')
    return (call?.[1] ?? {}) as Record<string, unknown>
  }

  // New main + old relay: the relay accepts launchToken and never re-lists it, so a
  // crash-recovery re-list would read the live agent as absent and Retry would duplicate it.
  it('withholds the token from a relay that cannot echo it', async () => {
    request.mockImplementation(async (method: string) =>
      method === 'pty.getCapabilities' ? {} : { id: 'pty-old', incarnationId: 'inc-old' }
    )

    await provider.spawn({ cols: 80, rows: 24, command: 'claude', launchToken: 'tok-1' })

    expect('launchToken' in spawnParams()).toBe(false)
    expect(provider.providesLaunchTokenListings()).toBe(false)
  })

  it('sends the token once the relay advertises the echo', async () => {
    request.mockImplementation(async (method: string) =>
      method === 'pty.getCapabilities'
        ? { launchTokenEchoVersion: LAUNCH_TOKEN_ECHO_PROTOCOL_VERSION }
        : { id: 'pty-new', incarnationId: 'inc-new' }
    )

    await provider.spawn({ cols: 80, rows: 24, command: 'claude', launchToken: 'tok-2' })

    expect(spawnParams().launchToken).toBe('tok-2')
    expect(provider.providesLaunchTokenListings()).toBe(true)
  })

  // Old main + new relay: the advertisement is purely additive, so a tokenless spawn
  // (all an old main ever sends) stays byte-for-byte what it was and probes nothing.
  it('leaves a tokenless spawn unprobed and unchanged', async () => {
    request.mockResolvedValue({ id: 'pty-plain', incarnationId: 'inc-plain' })

    await provider.spawn({ cols: 80, rows: 24, command: 'claude' })

    expect(request.mock.calls.map(([method]) => method)).toEqual(['pty.spawn'])
    expect('launchToken' in spawnParams()).toBe(false)
  })

  it('re-probes a negative echo capability after an in-place relay upgrade', async () => {
    request.mockResolvedValueOnce({}).mockResolvedValueOnce({
      launchTokenEchoVersion: LAUNCH_TOKEN_ECHO_PROTOCOL_VERSION
    })

    await expect(provider.supportsLaunchTokenEcho()).resolves.toBe(false)
    await expect(provider.supportsLaunchTokenEcho()).resolves.toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
  })
})
