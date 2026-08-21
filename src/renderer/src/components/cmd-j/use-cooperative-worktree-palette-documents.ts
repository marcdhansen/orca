import { useEffect, useMemo, useState } from 'react'
import {
  buildWorktreePaletteDocumentsCooperatively,
  type WorktreePaletteDocumentSources
} from '@/lib/worktree-palette-document'
import type { PaletteDocument } from '@/lib/palette-match/palette-document'
import type { Worktree } from '../../../../shared/worktree/types'

const EMPTY_DOCUMENTS: ReadonlyMap<string, PaletteDocument> = new Map()
const DOCUMENT_BUILD_TIME_SLICE_MS = 16

type CompletedBuild = {
  request: WorktreePaletteDocumentBuildRequest
  documents: ReadonlyMap<string, PaletteDocument>
}

type WorktreePaletteDocumentBuildRequest = {
  worktrees: readonly Worktree[]
  sources: WorktreePaletteDocumentSources
}

export function useCooperativeWorktreePaletteDocuments(
  worktrees: readonly Worktree[],
  sources: WorktreePaletteDocumentSources
): { documents: ReadonlyMap<string, PaletteDocument>; pending: boolean } {
  const request = useMemo(() => ({ worktrees, sources }), [sources, worktrees])
  const [completed, setCompleted] = useState<CompletedBuild | null>(null)

  useEffect(() => {
    let current = true
    void buildWorktreePaletteDocumentsCooperatively(request.worktrees, request.sources, {
      shouldContinue: () => current,
      timeSliceMs: DOCUMENT_BUILD_TIME_SLICE_MS
    }).then((documents) => {
      if (current && documents) {
        setCompleted({ request, documents })
      }
    })
    return () => {
      current = false
    }
  }, [request])

  return completed?.request === request
    ? { documents: completed.documents, pending: false }
    : { documents: EMPTY_DOCUMENTS, pending: true }
}
