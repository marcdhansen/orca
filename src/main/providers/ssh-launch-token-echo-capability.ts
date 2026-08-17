import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { LAUNCH_TOKEN_ECHO_PROTOCOL_VERSION } from '../../shared/agent-launch-token-echo-protocol'
import { SSH_AGENT_SESSION_CAPABILITY_PROBE_TIMEOUT_MS } from './ssh-agent-session-create-operation'

export async function sshEchoesLaunchTokens(
  mux: SshChannelMultiplexer,
  options: { signal?: AbortSignal } = {}
): Promise<boolean> {
  try {
    const result = (await mux.request('pty.getCapabilities', undefined, {
      signal: options.signal,
      timeoutMs: SSH_AGENT_SESSION_CAPABILITY_PROBE_TIMEOUT_MS
    })) as { launchTokenEchoVersion?: unknown }
    return result.launchTokenEchoVersion === LAUNCH_TOKEN_ECHO_PROTOCOL_VERSION
  } catch {
    // Why: probing never spawns, so an unreachable or old relay just keeps the tokenless path.
    return false
  }
}
