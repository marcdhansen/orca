import { useEffect, useMemo, useState } from 'react'
import {
  searchWorktreeDocuments,
  searchWorktreeDocumentsCooperatively,
  type PaletteSearchResult,
  type WorktreePaletteSearchArgs
} from '@/lib/worktree-palette-search'
import { parseCmdJTaskSourceUrl } from '@/lib/worktree-palette-task-url-match'

const COOPERATIVE_SEARCH_MIN_WORKTREES = 200

type CompletedSearch = {
  request: WorktreePaletteSearchArgs
  results: PaletteSearchResult[]
}

type CooperativeWorktreePaletteSearch = {
  pending: boolean
  results: PaletteSearchResult[]
}

export function useCooperativeWorktreePaletteSearch(
  args: WorktreePaletteSearchArgs
): CooperativeWorktreePaletteSearch {
  const { worktrees, query, documents, repoMap, repoMapByHostIdentity, checksReviewByWorktree } =
    args
  const request = useMemo<WorktreePaletteSearchArgs>(
    () => ({
      worktrees,
      query,
      documents,
      repoMap,
      repoMapByHostIdentity,
      checksReviewByWorktree
    }),
    [worktrees, query, documents, repoMap, repoMapByHostIdentity, checksReviewByWorktree]
  )
  const cooperative =
    request.worktrees.length >= COOPERATIVE_SEARCH_MIN_WORKTREES &&
    request.query.trim().length > 0 &&
    parseCmdJTaskSourceUrl(request.query.trim()) === null
  const immediateResults = useMemo(
    () => (cooperative ? null : searchWorktreeDocuments(request)),
    [cooperative, request]
  )
  const [completed, setCompleted] = useState<CompletedSearch | null>(null)

  useEffect(() => {
    if (!cooperative) {
      return
    }
    let current = true
    void searchWorktreeDocumentsCooperatively(request, {
      shouldContinue: () => current
    }).then((results) => {
      if (current && results) {
        setCompleted({ request, results })
      }
    })
    return () => {
      current = false
    }
  }, [cooperative, request])

  if (immediateResults) {
    return { pending: false, results: immediateResults }
  }
  return completed?.request === request
    ? { pending: false, results: completed.results }
    : { pending: true, results: [] }
}
