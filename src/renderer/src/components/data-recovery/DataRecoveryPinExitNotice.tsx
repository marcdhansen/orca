import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { translate } from '@/i18n/i18n'
import type { RecoveryPointDto } from '../../../../shared/data-recovery'
import { DataRecoveryDialog } from './DataRecoveryDialog'
import { DataRecoveryPinExitCustomAgentExample } from './DataRecoveryPinExitCustomAgentExample'
import {
  dismissPinExitNotice,
  isPinExitNoticeDismissed
} from './data-recovery-pin-exit-notice-dismissal'

/** Only a pin that can actually be restored: an unreadable one would send people
 *  to a downgrade they cannot perform. `restorable` is optional (older hosts omit
 *  it), so only an explicit false withdraws the dialog. */
function restorablePreV1Point(points: RecoveryPointDto[]): RecoveryPointDto | null {
  return (
    points.find((point) => point.id === 'agent-catalog-pre-v1' && point.restorable !== false) ??
    null
  )
}

/** One-shot dialog after a successful agent-catalog pin. Most people should
 *  continue; the optional path is how to return to the previous Orca without
 *  reinstalling over live data. Hidden when migration is blocked (red notice
 *  owns that state), when no restorable pin exists, on paired web, or after
 *  dismiss for this pin. */
export function DataRecoveryPinExitNotice() {
  const [pin, setPin] = useState<RecoveryPointDto | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const continueRef = useRef<HTMLButtonElement>(null)

  const refresh = useCallback(async () => {
    try {
      const status = await window.api.dataRecovery?.migrationStatus()
      if (status?.agentCatalogMigrationError != null) {
        setPin(null)
        return
      }
      const points = (await window.api.dataRecovery?.listPoints()) ?? []
      const next = restorablePreV1Point(points)
      setPin(next)
      setDismissed(next != null && isPinExitNoticeDismissed(next.createdAtMs))
    } catch {
      setPin(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleDismiss = (): void => {
    if (pin !== null) {
      dismissPinExitNotice(pin.createdAtMs)
    }
    setDismissed(true)
  }

  const pinDialogOpen = pin !== null && !dismissed && !recoveryOpen
  if (!pinDialogOpen && !recoveryOpen) {
    return null
  }

  return (
    <>
      <Dialog
        open={pinDialogOpen}
        onOpenChange={(open) => {
          // Closing because the restore dialog is on top is temporary.
          if (!open && !recoveryOpen) {
            handleDismiss()
          }
        }}
      >
        <DialogContent
          className="max-w-lg gap-5"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            continueRef.current?.focus()
          }}
        >
          <DialogHeader className="gap-3">
            <DialogTitle className="leading-snug">
              {translate(
                'auto.components.dataRecovery.pinExitTitle',
                'Custom agents are now available'
              )}
            </DialogTitle>
            <DialogDescription className="text-sm leading-relaxed text-foreground">
              {translate(
                'auto.components.dataRecovery.pinExitLead',
                'A custom agent is saved arguments for a harness like Codex or Claude, picked by name.'
              )}
            </DialogDescription>
          </DialogHeader>

          <DataRecoveryPinExitCustomAgentExample />
          <p className="text-sm leading-relaxed text-muted-foreground">
            {translate(
              'auto.components.dataRecovery.pinExitExampleHint',
              'Create them in Settings → Agents. Keep working as usual — nothing else is required.'
            )}
          </p>

          <Separator />

          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium text-foreground">
              {translate(
                'auto.components.dataRecovery.pinExitRollbackTitle',
                'Before you install an older Orca'
              )}
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {translate(
                'auto.components.dataRecovery.pinExitRollbackReinstall',
                'This version changed the local data format. Restore the previous backup first, or the older app can break.'
              )}
            </p>
            <ol className="list-decimal space-y-1 pl-4 text-sm leading-relaxed text-muted-foreground">
              <li>
                {translate(
                  'auto.components.dataRecovery.pinExitRollbackStepRestore',
                  'Restore the data backup. Orca will quit.'
                )}
              </li>
              <li>
                {translate(
                  'auto.components.dataRecovery.pinExitRollbackStepInstall',
                  'Then install the older Orca.'
                )}
              </li>
            </ol>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {translate(
                'auto.components.dataRecovery.pinExitRollbackLoss',
                'The restore discards changes since this update, including custom agents.'
              )}
            </p>
            <div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setRecoveryOpen(true)}
              >
                {translate('auto.components.dataRecovery.pinExitGoBack', 'Restore data backup…')}
              </Button>
            </div>
          </div>

          <DialogFooter>
            <Button ref={continueRef} type="button" onClick={handleDismiss}>
              {translate('auto.components.dataRecovery.dismissPinExit', 'Continue')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DataRecoveryDialog open={recoveryOpen} onOpenChange={setRecoveryOpen} />
    </>
  )
}
