import type { WorktreeLineageWarning } from './lineage-types'

/** Immutable, non-derivable parts of a reservation-bearing worktree create response. */
export type WorktreeReservationCreateReceipt = {
  version: 1
  warnings: WorktreeLineageWarning[]
  warning?: string
  startupTerminal?: {
    spawned: boolean
    handle?: string
    tabId?: string
    paneKey?: string | null
    ptyId?: string | null
    surface?: 'visible' | 'background'
  }
  agentTerminalHandle?: string
}
