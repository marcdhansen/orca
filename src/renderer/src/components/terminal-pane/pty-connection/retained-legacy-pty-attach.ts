// Why: a restored pane's stale-account prompt can only be raised once a PTY is
// actually attached — nothing is inspectable while the session hydrates.

import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'

/**
 * Establishes a binding between a terminal pane and its corresponding PTY stream,
 * managing input, output, title synchronization, and agent status tracking.
 */

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function bindAttachRetainedLegacyPty(session: ConnectPanePtySession): void {
  session.attachRetainedLegacyPty = (ptyId: string): boolean => {
    try {
      session.authoritativeReattachGeneration += 1
      session.clearPaneMode2031State()
      session.clearHiddenOutputRestoreState()
      const outputCallbacks = session.captureTransportOutputCallbacks(session.reportError)
      session.transport.attach({
        existingPtyId: ptyId,
        callbacks: outputCallbacks.callbacks
      })
      const attachedPtyId = session.transport.getPtyId() ?? ptyId
      session.bindActivePanePty(attachedPtyId, {
        updateTabPtyId: 'if-missing',
        sampleVisibleForegroundAgent: true
      })
      if (isRemoteRuntimePtyId(attachedPtyId)) {
        session.registerPaneSerializerFor(attachedPtyId)
      }
      return true
    } catch (err) {
      session.reportError(err instanceof Error ? err.message : String(err))
      return false
    }
  }
}
