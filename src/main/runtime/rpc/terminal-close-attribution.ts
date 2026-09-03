import { withSpan } from '../../observability/tracer'
import type { RuntimeTerminalClose } from '../../../shared/runtime-types'
import type { RpcContext } from './core'

type TerminalCloseMethod = 'terminal.close' | 'terminal.closeTab'
type TerminalCloseTargetKind = 'terminal' | 'terminal-tab'

type TerminalPresence =
  | { state: 'present'; tabId: string }
  | { state: 'absent' }
  | { state: 'unknown' }

async function attestTerminalPresence(
  context: Pick<RpcContext, 'runtime'>,
  terminal: string
): Promise<TerminalPresence> {
  try {
    const listed = await context.runtime.listTerminals(undefined, 1, {
      handles: [terminal],
      includeVisualLayouts: false
    })
    if (!listed.hostScope || listed.hostScope.omittedHostIds.length > 0) {
      return { state: 'unknown' }
    }
    const match = listed.terminals.find((candidate) => candidate.handle === terminal)
    return match ? { state: 'present', tabId: match.tabId } : { state: 'absent' }
  } catch {
    return { state: 'unknown' }
  }
}

function isTabNotFound(error: unknown): boolean {
  return error instanceof Error && error.message === 'tab_not_found'
}

export function withTerminalCloseAttribution(
  method: TerminalCloseMethod,
  context: Pick<
    RpcContext,
    'runtime' | 'clientKind' | 'pairedDeviceId' | 'connectionId' | 'requestId'
  >,
  targetKind: TerminalCloseTargetKind,
  terminal: string,
  close: () => Promise<RuntimeTerminalClose>
): Promise<RuntimeTerminalClose> {
  return withSpan(
    method,
    async (span) => {
      span.setAttribute('decision', 'allowed')
      const before = await attestTerminalPresence(context, terminal)
      try {
        const result = await close()
        span.setAttribute('outcome', 'succeeded')
        span.setAttribute('tabId', result.tabId)
        span.setAttribute('ptyKilled', result.ptyKilled)
        if (result.closeMode) {
          span.setAttribute('closeMode', result.closeMode)
        }
        return { ...result, outcome: 'closed' }
      } catch (error) {
        if (isTabNotFound(error)) {
          const after = await attestTerminalPresence(context, terminal)
          if (before.state === 'present' && after.state === 'absent') {
            span.setAttribute('outcome', 'succeeded-after-retirement')
            return {
              handle: terminal,
              tabId: before.tabId,
              outcome: 'closed',
              ptyKilled: false
            }
          }
          if (before.state === 'absent' && after.state === 'absent') {
            span.setAttribute('outcome', 'already-absent')
            return {
              handle: terminal,
              outcome: 'already_absent',
              ptyKilled: false
            }
          }
        }
        span.setAttribute('outcome', 'failed')
        throw error
      }
    },
    {
      kind: 'client',
      attributes: {
        attribution: 'terminal-close',
        runtimeId: context.runtime.getRuntimeId(),
        origin: context.clientKind ?? 'in-process',
        deviceId: context.pairedDeviceId ?? 'in-process',
        connectionGeneration: context.connectionId ?? 'in-process',
        requestId: context.requestId ?? 'in-process',
        targetKind,
        terminal
      }
    }
  )
}
