/**
 * Registry test for the host-session-mirror settle seam. Four review rounds
 * each found a NEW call site settling the latch out of order with its store
 * patch, so the seam is enforced structurally: a settle exists only as the
 * receipt of a landed patch (or as the audited stale-frame exception), and a
 * new patch or settle site fails this census until it adopts that contract.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const RENDERER_SRC = join(import.meta.dirname, '..')

const SETTLE_RULE = [
  'The mirror latch settles EXACTLY when evidence reached the store.',
  'applyWebSessionTabsStorePatch returns the settle receipt for its own patch:',
  'capture it and invoke it after the frame finishes recovery. A frame rejected',
  'as stale settles through hostSessionMirrorSettleForStaleFrame, whose only',
  'valid precondition is shouldApplyWebSessionTabsSnapshot returning false.',
  'Never call markHostSessionMirror*Hydrated from feature code, and never add a',
  'boolean that remembers "the patch landed" — that ordering bug shipped four',
  'times. If you added a legitimate new site, update this census deliberately.'
].join(' ')

function productionSources(): { path: string; source: string }[] {
  const sources: { path: string; source: string }[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) {
        walk(path)
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry) || /\.test\.|\.d\.ts$/.test(entry)) {
        continue
      }
      sources.push({
        path: relative(RENDERER_SRC, path).split(sep).join('/'),
        source: readFileSync(path, 'utf8')
      })
    }
  }
  walk(RENDERER_SRC)
  return sources
}

function countOccurrences(source: string, needle: string): number {
  let count = 0
  for (
    let index = source.indexOf(needle);
    index !== -1;
    index = source.indexOf(needle, index + 1)
  ) {
    count += 1
  }
  return count
}

describe('host-session-mirror settle census', () => {
  const sources = productionSources()

  it('mirror marks are reachable only through the settle receipts', () => {
    const markCounts: Record<string, { hydrated: number; worktreeHydrated: number }> = {}
    for (const { path, source } of sources) {
      const hydrated = countOccurrences(source, 'markHostSessionMirrorHydrated(')
      const worktreeHydrated = countOccurrences(source, 'markHostSessionMirrorWorktreeHydrated(')
      if (hydrated + worktreeHydrated > 0) {
        markCounts[path] = { hydrated, worktreeHydrated }
      }
    }
    expect(markCounts, SETTLE_RULE).toEqual({
      // The definitions themselves.
      'runtime/host-session-mirror-hydration.ts': { hydrated: 1, worktreeHydrated: 1 },
      // Exactly the receipt constructors: the patch receipt (environment-wide
      // and per-worktree) and the stale-frame receipt.
      'runtime/web-session-tabs-sync.ts': { hydrated: 1, worktreeHydrated: 2 }
    })
  })

  it('every store patch call site captures its settle receipt', () => {
    const needle = 'applyWebSessionTabsStorePatch('
    const callSites: Record<string, number> = {}
    for (const { path, source } of sources) {
      let calls = 0
      for (
        let index = source.indexOf(needle);
        index !== -1;
        index = source.indexOf(needle, index + 1)
      ) {
        const before = source.slice(0, index).trimEnd()
        if (before.endsWith('function')) {
          continue // The definition.
        }
        calls += 1
        // A receipt is captured when the call is an expression consumed by an
        // assignment, return, ternary, or argument — never a bare statement.
        const capturedBy = before.slice(-1)
        expect(
          ['=', '(', ',', '?', ':', '{'].includes(capturedBy) || before.endsWith('return'),
          `${path} discards the settle receipt of applyWebSessionTabsStorePatch. ${SETTLE_RULE}`
        ).toBe(true)
      }
      if (calls > 0) {
        callSites[path] = calls
      }
    }
    expect(callSites, SETTLE_RULE).toEqual({
      // initial listAll, visibility-resume repair, full inventory, global
      // singular frame, scoped active frame.
      'runtime/web-session-tabs-sync.ts': 5,
      // The eager post-create session.tabs.list refresh.
      'runtime/web-runtime-session.ts': 1
    })
  })

  it('the stale-frame settle appears only at its audited sites', () => {
    const staleCounts: Record<string, number> = {}
    for (const { path, source } of sources) {
      const count = countOccurrences(source, 'hostSessionMirrorSettleForStaleFrame(')
      if (count > 0) {
        staleCounts[path] = count
      }
    }
    expect(staleCounts, SETTLE_RULE).toEqual({
      // The definition, the global singular frame, and the scoped active frame.
      'runtime/web-session-tabs-sync.ts': 3
    })
  })
})
