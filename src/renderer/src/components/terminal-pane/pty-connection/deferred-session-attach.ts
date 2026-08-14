import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { useAppStore } from '@/store'
import { isRuntimeOwnedSshTargetId } from '../../../../../shared/execution-host'
// Why: a restored pane's stale-account prompt can only be raised once a PTY is
// actually attached — nothing is inspectable while the session hydrates.
import { resolveSshPaneConnectGate } from '../ssh-pane-connect-gate'

import {
  type UserInitiatedSshConnectOutcome,
  isSshSessionExpiredError,
  sshPromptConnectOutcomeForStatus,
  waitForSshConnection
} from './ssh-session-connect'
import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'

/**
 * Establishes a binding between a terminal pane and its corresponding PTY stream,
 * managing input, output, title synchronization, and agent status tracking.
 */

import type { ConnectPanePtySession } from './connect-pane-pty-session'

import { runDeferredSessionReattachChoice } from './deferred-session-reattach-choice'

export function runDeferredSessionAttach(session: ConnectPanePtySession): void {
  // Why: trigger the deferred SSH connect per-tab (not per-target) so multiple tabs for one target reattach independently.
  // Must run before session-id resolution: the SSH provider isn't registered until connect succeeds.
  if (session.connectionId) {
    const storeState = useAppStore.getState()
    // Why: a removed SSH target (ghost workspace) would fail reattach with a spurious "file an issue" banner for an expected action, so skip it (runtime-owned targets exempt).
    // A present map missing this id = target removed; an absent map = not yet hydrated (test stubs), so don't treat it as gone.
    if (
      !isRuntimeOwnedSshTargetId(session.connectionId) &&
      storeState.sshTargetLabels instanceof Map &&
      !storeState.sshTargetLabels.has(session.connectionId)
    ) {
      return
    }
    const restoredLeafSessionId =
      session.deps.restoredLeafId && session.deps.restoredPtyIdByLeafId
        ? (session.deps.restoredPtyIdByLeafId[session.deps.restoredLeafId] ?? null)
        : null
    const gate = resolveSshPaneConnectGate({
      connectionId: session.connectionId,
      sshStatus: storeState.sshConnectionStates.get(session.connectionId)?.status,
      isDeferredTarget: storeState.deferredSshReconnectTargets.includes(session.connectionId),
      restoredLeafSessionId,
      deferredTabSessionId: storeState.deferredSshSessionIdsByTabId[session.deps.tabId],
      tabPtyId: storeState.tabsByWorktree[session.deps.worktreeId]?.find(
        (t) => t.id === session.deps.tabId
      )?.ptyId,
      hasLeafSessionMap: Boolean(
        session.deps.restoredPtyIdByLeafId &&
        Object.keys(session.deps.restoredPtyIdByLeafId).length > 0
      )
    })
    const pendingSessionId = gate.pendingSessionId
    console.warn(
      `[pty-connection] SSH tab=${session.deps.tabId} connectionId=${session.connectionId} pendingSessionId=${pendingSessionId} sshConnected=${gate.sshConnected}`
    )
    const legacyWorkerOwnsPane = session.isLegacyWorkerAutomaticResumeBlocked()
    if (gate.enterDeferredFlow && (!legacyWorkerOwnsPane || !gate.sshConnected)) {
      // Paint main's parked model while SSH recovery continues off the render path.
      session.prepaintParkedSshSnapshot(pendingSessionId)
      void (async () => {
        // Why: for a passphrase target with no cached credential, don't auto-fire ssh.connect — a prompt popping just from focusing a tab / Cmd+J would surprise the user.
        // Wait for a user-initiated connect first; no-passphrase targets return false here and auto-connect as before.
        let needsPrompt = false
        try {
          needsPrompt = await window.api.ssh.needsPassphrasePrompt({
            targetId: session.connectionId
          })
        } catch (err) {
          console.warn('[pty-connection] needsPassphrasePrompt probe failed:', err)
          // Why: on probe failure fall through to auto-connect rather than stranding the tab — a stuck tab is worse than a surprising prompt.
        }
        if (session.disposed || !session.capturedDirectSshRetryLeaseMatches()) {
          return
        }
        if (needsPrompt) {
          const alreadyConnected =
            useAppStore.getState().sshConnectionStates.get(session.connectionId)?.status ===
            'connected'
          if (!alreadyConnected) {
            // Wait for the user-driven connect (sidebar card control or terminal reconnect overlay → passphrase → ssh.connect) to complete.
            // Why: resolve on terminal-failure statuses too ('auth-failed'/'error'/'reconnection-failed') so it can't hang forever if the user cancels or the connect fails.
            const outcome = await new Promise<UserInitiatedSshConnectOutcome>((resolve) => {
              // Why: 'disconnected' counts as terminal only after a non-disconnected status was seen (a real connect attempt that returned to 'disconnected').
              // Treating the entry-time 'disconnected' as terminal would skip the gate, defeating the passphrase-prompt deferral.
              let sawNonDisconnected =
                useAppStore.getState().sshConnectionStates.get(session.connectionId)?.status !==
                  'disconnected' &&
                useAppStore.getState().sshConnectionStates.get(session.connectionId)?.status !==
                  undefined
              let resolvedOutcome: UserInitiatedSshConnectOutcome = 'cancelled'
              let settled = false
              const finish = (nextOutcome: UserInitiatedSshConnectOutcome): void => {
                if (settled) {
                  return
                }
                resolvedOutcome = nextOutcome
                settled = true
                unsub()
                const idx = session.waitTeardowns.indexOf(teardown)
                if (idx !== -1) {
                  session.waitTeardowns.splice(idx, 1)
                }
                resolve(resolvedOutcome)
              }
              const teardown = (): void => finish('cancelled')
              // Why: register a teardown so dispose() can unsubscribe+resolve if the session.pane is torn down mid-wait.
              // Else the zustand subscriber + async IIFE leak: the callback only checks `session.disposed` when it next fires, which may never happen.
              session.waitTeardowns.push(teardown)
              const unsub = useAppStore.subscribe((state) => {
                if (session.disposed) {
                  finish('cancelled')
                  return
                }
                const status = state.sshConnectionStates.get(session.connectionId)?.status
                if (status && status !== 'disconnected') {
                  sawNonDisconnected = true
                }
                const nextOutcome = sshPromptConnectOutcomeForStatus(status, sawNonDisconnected)
                if (nextOutcome) {
                  finish(nextOutcome)
                }
              })
              // Why: re-read state after subscribing to catch a status change that landed between the alreadyConnected check and the subscribe — else we'd wait forever.
              if (session.disposed) {
                finish('cancelled')
                return
              }
              const currentStatus = useAppStore
                .getState()
                .sshConnectionStates.get(session.connectionId)?.status
              const currentOutcome = sshPromptConnectOutcomeForStatus(
                currentStatus,
                sawNonDisconnected
              )
              if (currentOutcome) {
                finish(currentOutcome)
              }
            })
            if (session.disposed || !session.capturedDirectSshRetryLeaseMatches()) {
              return
            }
            if (outcome === 'cancelled') {
              return
            }
            if (outcome === 'failed') {
              session.reportError('SSH connection failed')
              return
            }
          }
        }

        // Why: wait for the shared SSH connection (multiple panes/tabs may need it) before PTY reattach, rather than returning early when it's in-flight.
        const connectResult = await waitForSshConnection(session.connectionId)
        if (session.disposed || !session.capturedDirectSshRetryLeaseMatches()) {
          return
        }
        if (!connectResult.connected) {
          session.reportError(`SSH connection failed: ${connectResult.error}`)
          return
        }
        useAppStore.getState().removeDeferredSshReconnectTarget(session.connectionId)
        if (session.disposed) {
          return
        }
        if (pendingSessionId) {
          if (session.isLegacyWorkerAutomaticResumeBlocked()) {
            if (session.attachRetainedLegacyPty(pendingSessionId)) {
              useAppStore.getState().removeDeferredSshSessionId(session.deps.tabId)
              scheduleRuntimeGraphSync()
            }
            return
          }
          console.warn(
            `[pty-connection] Attempting reattach for tab=${session.deps.tabId} sessionId=${pendingSessionId}`
          )
          // Why: the saved remote PTY id is single-use restore metadata; clear it before attach so remounts don't keep retrying an expired session.
          useAppStore.getState().removeDeferredSshSessionId(session.deps.tabId)
          // Why: pre-signal SSH-deferred reattach too so the cooperation gate applies uniformly to remote sessions (Electron preserves the declare→connect order).
          // See docs/mobile-prefer-renderer-scrollback.md.
          const preSignalPromise =
            session.runtimeEnvironmentId || isRemoteRuntimePtyId(pendingSessionId)
              ? Promise.resolve(null)
              : window.api.pty.declarePendingPaneSerializer(session.cacheKey).catch(() => null)
          let expiredReattachError = false
          const coldRestoreStartup = session.buildColdRestoreAgentResumeStartup()
          session.clearPaneMode2031State()
          session.clearHiddenOutputRestoreState()
          const outputCallbacks = session.captureTransportOutputCallbacks((message) => {
            if (isSshSessionExpiredError(message)) {
              expiredReattachError = true
              return
            }
            if (!session.isCapturedDirectSshReattachCurrent(pendingSessionId)) {
              return
            }
            session.reportError(message)
          })
          session.beginReattachLiveDataDeferral(outputCallbacks.generation)
          session.transportConnectInFlightSince = Date.now()
          const reattachPromise = session.transport.connect({
            url: '',
            cols: session.cols,
            rows: session.rows,
            sessionId: pendingSessionId,
            ...(coldRestoreStartup?.command ? { command: coldRestoreStartup.command } : {}),
            ...(coldRestoreStartup?.env
              ? { env: session.mergeStartupEnvWithPaneIdentity(coldRestoreStartup.env) }
              : {}),
            ...(coldRestoreStartup?.launchConfig
              ? { launchConfig: coldRestoreStartup.launchConfig }
              : {}),
            ...(coldRestoreStartup?.resumeProviderSession
              ? { resumeProviderSession: coldRestoreStartup.resumeProviderSession }
              : {}),
            ...(coldRestoreStartup?.launchToken
              ? { launchToken: coldRestoreStartup.launchToken }
              : {}),
            ...(coldRestoreStartup?.agent ? { launchAgent: coldRestoreStartup.agent } : {}),
            ...(session.shouldDeclareHiddenAtSpawn() ? { initiallyHidden: true } : {}),
            ...(session.directSshRetryAttempt
              ? { admitPtyId: session.claimCapturedDirectSshRetryPty }
              : {}),
            callbacks: outputCallbacks.callbacks
          })
          void Promise.resolve(reattachPromise)
            .catch(() => null)
            .finally(() => {
              session.transportConnectInFlightSince = null
            })
          const trackedReattachPromise = Promise.resolve(reattachPromise)
            .then(async (result) => {
              if (outputCallbacks.generation !== session.transportStreamGeneration) {
                session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
                const gen = await preSignalPromise
                if (typeof gen === 'number') {
                  void window.api.pty
                    .clearPendingPaneSerializer(session.cacheKey, gen)
                    .catch(() => {})
                }
                return
              }
              console.warn(
                `[pty-connection] Reattach result for tab=${session.deps.tabId}:`,
                result
                  ? {
                      sessionExpired: (result as Record<string, unknown>).sessionExpired,
                      replay: !!(result as Record<string, unknown>).replay
                    }
                  : 'undefined'
              )
              if (!result && expiredReattachError) {
                session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
                const gen = await preSignalPromise
                if (typeof gen === 'number') {
                  void window.api.pty
                    .clearPendingPaneSerializer(session.cacheKey, gen)
                    .catch(() => {})
                }
                if (session.disposed) {
                  return
                }
                if (session.rejectObsoleteDirectSshReattach(pendingSessionId)) {
                  return
                }
                session.deps.clearExitedPanePtyLayoutBinding(session.pane.id, pendingSessionId)
                session.deps.clearTabPtyId(session.deps.tabId, pendingSessionId)
                session.startFreshColdRestoreAgentResume(coldRestoreStartup, {
                  forceBlankRestoredViewport: true
                })
                return
              }
              const accepted = await session.handleReattachResult(
                result,
                pendingSessionId,
                coldRestoreStartup,
                outputCallbacks.generation
              )
              session.finishReattachLiveDataDeferral(accepted, outputCallbacks.generation)
              const gen = await preSignalPromise
              if (typeof gen === 'number') {
                if (!accepted) {
                  await window.api.pty
                    .clearPendingPaneSerializer(session.cacheKey, gen)
                    .catch(() => {})
                } else if (!isRemoteRuntimePtyId(pendingSessionId)) {
                  const settledPtyId =
                    result && typeof result === 'object' && 'id' in result
                      ? result.id
                      : (session.transport.getPtyId() ?? pendingSessionId)
                  const hasRestorePayload =
                    result &&
                    typeof result === 'object' &&
                    ('snapshot' in result || 'replay' in result || 'coldRestore' in result)
                  await (hasRestorePayload
                    ? session.settlePaneSerializerAfterReplay(settledPtyId, gen)
                    : window.api.pty.settlePaneSerializer(session.cacheKey, gen))
                }
              }
            })
            .catch(async (err) => {
              session.finishReattachLiveDataDeferral(false, outputCallbacks.generation)
              const gen = await preSignalPromise
              if (typeof gen === 'number') {
                void window.api.pty
                  .clearPendingPaneSerializer(session.cacheKey, gen)
                  .catch(() => {})
              }
              console.warn(`[pty-connection] Reattach FAILED for tab=${session.deps.tabId}:`, err)
              if (
                session.disposed ||
                outputCallbacks.generation !== session.transportStreamGeneration
              ) {
                return
              }
              if (session.rejectObsoleteDirectSshReattach(pendingSessionId)) {
                return
              }
              if (isSshSessionExpiredError(err)) {
                session.deps.clearExitedPanePtyLayoutBinding(session.pane.id, pendingSessionId)
                session.deps.clearTabPtyId(session.deps.tabId, pendingSessionId)
                session.startFreshColdRestoreAgentResume(coldRestoreStartup, {
                  forceBlankRestoredViewport: true
                })
                return
              }
              session.startFreshColdRestoreAgentResume(coldRestoreStartup, {
                forceBlankRestoredViewport: true
              })
            })
          session.armDirectSshPaneRetryTimeout(
            trackedReattachPromise,
            session.directSshRetryAttempt
          )
        } else {
          session.startFreshColdRestoreAgentResume()
        }
      })()
      return
    }
  }

  runDeferredSessionReattachChoice(session)
}
