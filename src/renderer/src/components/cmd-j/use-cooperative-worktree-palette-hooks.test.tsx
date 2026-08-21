// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaletteDocument } from '@/lib/palette-match/palette-document'
import type { PaletteSearchResult } from '@/lib/worktree-palette-search'
import type { Worktree } from '../../../../shared/worktree/types'
import { useCooperativeWorktreePaletteDocuments } from './use-cooperative-worktree-palette-documents'
import { useCooperativeWorktreePaletteSearch } from './use-cooperative-worktree-palette-search'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const cooperativeMocks = vi.hoisted(() => ({
  buildDocuments: vi.fn(),
  searchDocuments: vi.fn(),
  searchDocumentsImmediately: vi.fn(() => [])
}))

vi.mock('@/lib/worktree-palette-document', () => ({
  buildWorktreePaletteDocumentsCooperatively: cooperativeMocks.buildDocuments
}))

vi.mock('@/lib/worktree-palette-search', () => ({
  searchWorktreeDocuments: cooperativeMocks.searchDocumentsImmediately,
  searchWorktreeDocumentsCooperatively: cooperativeMocks.searchDocuments
}))

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill
  })
  return { promise, resolve }
}

function makeWorktree(index: number): Worktree {
  return {
    id: `wt-${index}`,
    repoId: 'repo-1',
    path: `/work/wt-${index}`,
    head: 'abc123',
    branch: `refs/heads/needle-${index}`,
    isBare: false,
    isMainWorktree: false,
    displayName: `Needle ${index}`,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: index,
    lastActivityAt: index
  }
}

function makeSearchResult(worktreeId: string): PaletteSearchResult {
  return {
    worktreeId,
    matchedFields: ['displayName'],
    displayNameRanges: [],
    branchRanges: [],
    repoRanges: [],
    hostRanges: [],
    supportingText: null,
    qualityClass: 'exact-visible',
    rank: null
  }
}

const sources = { repoMap: new Map() }
const searchWorktrees = Array.from({ length: 200 }, (_, index) => makeWorktree(index))
const searchDocuments = new Map<string, PaletteDocument>()
const searchRepoMap = new Map()

function DocumentProbe({ worktrees }: { worktrees: readonly Worktree[] }): React.JSX.Element {
  const result = useCooperativeWorktreePaletteDocuments(worktrees, sources)
  return (
    <output data-pending={String(result.pending)}>{[...result.documents.keys()].join(',')}</output>
  )
}

function SearchProbe({ query }: { query: string }): React.JSX.Element {
  const result = useCooperativeWorktreePaletteSearch({
    worktrees: searchWorktrees,
    query,
    documents: searchDocuments,
    repoMap: searchRepoMap
  })
  return (
    <output data-pending={String(result.pending)}>
      {result.results.map((entry) => entry.worktreeId).join(',')}
    </output>
  )
}

describe('cooperative worktree palette hooks', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    cooperativeMocks.buildDocuments.mockReset()
    cooperativeMocks.searchDocuments.mockReset()
    cooperativeMocks.searchDocumentsImmediately.mockReset().mockReturnValue([])
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    document.body.replaceChildren()
  })

  it('publishes only the latest document generation and cancels on unmount', async () => {
    const first = deferred<ReadonlyMap<string, PaletteDocument> | null>()
    const second = deferred<ReadonlyMap<string, PaletteDocument> | null>()
    const third = deferred<ReadonlyMap<string, PaletteDocument> | null>()
    cooperativeMocks.buildDocuments
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise)

    await act(async () => root.render(<DocumentProbe worktrees={[makeWorktree(1)]} />))
    const firstOptions = cooperativeMocks.buildDocuments.mock.calls[0]![2]
    await act(async () => root.render(<DocumentProbe worktrees={[makeWorktree(2)]} />))
    expect(firstOptions.shouldContinue()).toBe(false)

    await act(async () => first.resolve(new Map([['stale', {} as PaletteDocument]])))
    expect(container.querySelector('output')?.dataset.pending).toBe('true')
    expect(container.textContent).toBe('')

    await act(async () => second.resolve(new Map([['current', {} as PaletteDocument]])))
    expect(container.querySelector('output')?.dataset.pending).toBe('false')
    expect(container.textContent).toBe('current')

    await act(async () => root.render(<DocumentProbe worktrees={[makeWorktree(3)]} />))
    const thirdOptions = cooperativeMocks.buildDocuments.mock.calls[2]![2]
    await act(async () => root.unmount())
    expect(thirdOptions.shouldContinue()).toBe(false)
    await act(async () => third.resolve(new Map([['unmounted', {} as PaletteDocument]])))
    root = createRoot(container)
  })

  it('never lets a superseded query publish stale results', async () => {
    const first = deferred<PaletteSearchResult[] | null>()
    const second = deferred<PaletteSearchResult[] | null>()
    cooperativeMocks.searchDocuments
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    await act(async () => root.render(<SearchProbe query="first" />))
    const firstOptions = cooperativeMocks.searchDocuments.mock.calls[0]![1]
    await act(async () => root.render(<SearchProbe query="second" />))
    expect(firstOptions.shouldContinue()).toBe(false)

    await act(async () => first.resolve([makeSearchResult('stale')]))
    expect(container.querySelector('output')?.dataset.pending).toBe('true')
    expect(container.textContent).toBe('')

    await act(async () => second.resolve([makeSearchResult('current')]))
    expect(container.querySelector('output')?.dataset.pending).toBe('false')
    expect(container.textContent).toBe('current')
  })
})
