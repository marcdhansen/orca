// Pinned pre-v1 backup writer injected into the agent-catalog v1 schema
// migration (src/shared/agent-catalog-schema-migration.ts). Kept in main
// because it is fs-bound; the migration itself is pure and shared with the CLI.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'
import type { PinnedBackupResult } from '../../shared/agent-catalog-schema-migration'

export function pinnedPreV1BackupPath(dataFile: string): string {
  return `${dataFile}.pre-agent-catalog-v1.backup`
}

/** True when an existing pinned backup is still a usable recovery point. Only a
 *  demonstrably torn backup (present, readable, not JSON) may be rewritten — an
 *  unreadable one is left alone rather than destroyed on a guess. */
function existingPinnedBackupIsUsable(backupFile: string): boolean {
  let contents: string
  try {
    contents = readFileSync(backupFile, 'utf-8')
  } catch {
    return true
  }
  try {
    JSON.parse(contents)
    return true
  } catch {
    return false
  }
}

/** Write the exact pre-v1 raw bytes to the pinned backup with the data file's
 *  permissions, fsync the file and its directory, then atomically rename into
 *  place. A usable existing pinned backup is kept (a crash between backup and
 *  first v1 write must not let a second attempt overwrite the original pre-v1
 *  state); a torn one is repaired, since this runs only while the profile is
 *  still pre-v1, so `rawContents` is genuine pre-v1 bytes. */
export function createPinnedPreV1Backup(dataFile: string, rawContents: string): PinnedBackupResult {
  const backupFile = pinnedPreV1BackupPath(dataFile)
  try {
    if (existsSync(backupFile) && existingPinnedBackupIsUsable(backupFile)) {
      return { ok: true, created: false }
    }
    const mode = statSync(dataFile).mode & 0o777
    writeFileDurableSync(durableWriteTempPath(backupFile), backupFile, rawContents, { mode })
    return { ok: true, created: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
