import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __setWindowsProcessTreeLoaderForTests,
  isWindowsProcessTableAvailable,
  readWindowsProcessTable,
  readWindowsProcessTableFresh,
  resetWindowsProcessTableForTests
} from './windows-process-table'

const getAllProcesses = vi.fn()

// A real snapshot always contains the querying process; the reader rejects a
// table without it, because that is what a blocked CreateToolhelp32Snapshot
// returns -- an empty list rather than an error.
const SELF = { pid: process.pid, ppid: 0, name: 'vitest.exe' }
const NATIVE = [
  SELF,
  { pid: 100, ppid: 4, name: 'orca.exe', commandLine: '"C:/a b/orca.exe" --x', memory: 4096 }
]

describe('windows process table', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    getAllProcesses.mockReset()
    getAllProcesses.mockImplementation((cb: (rows: unknown) => void) => cb(NATIVE))
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    __setWindowsProcessTreeLoaderForTests(() => ({
      ProcessDataFlag: { None: 0, Memory: 1, CommandLine: 2 },
      getAllProcesses
    }))
  })

  afterEach(() => {
    __setWindowsProcessTreeLoaderForTests()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('maps native rows, defaulting an unreadable command line to empty', async () => {
    const rows = await readWindowsProcessTableFresh()
    expect(rows).toEqual([
      { pid: process.pid, ppid: 0, name: 'vitest.exe', command: '', memoryBytes: undefined },
      {
        pid: 100,
        ppid: 4,
        name: 'orca.exe',
        command: '"C:/a b/orca.exe" --x',
        memoryBytes: 4096
      }
    ])
  })

  it('requests memory and command line together', async () => {
    await readWindowsProcessTableFresh()
    expect(getAllProcesses.mock.calls[0]?.[1]).toBe(3)
  })

  it('serves repeat reads from the shared snapshot', async () => {
    await readWindowsProcessTable()
    await readWindowsProcessTable()
    expect(getAllProcesses).toHaveBeenCalledTimes(1)
  })

  it('rejects rather than reporting an empty machine when the module is absent', async () => {
    // A caller that reads "no processes" acts on it -- by declaring a tree dead,
    // or by concluding a shell has no children. Absence must not look like that.
    __setWindowsProcessTreeLoaderForTests(() => null)
    await expect(readWindowsProcessTableFresh()).rejects.toThrow(/unavailable/)
    expect(isWindowsProcessTableAvailable()).toBe(false)
  })

  it('rejects when the snapshot itself fails', async () => {
    getAllProcesses.mockImplementation((cb: (rows: unknown) => void) => cb(undefined))
    resetWindowsProcessTableForTests()
    await expect(readWindowsProcessTableFresh()).rejects.toThrow()
  })

  it('rejects an empty snapshot rather than reporting an idle machine', async () => {
    // CreateToolhelp32Snapshot failing under an EDR hook or a restricted token
    // yields an empty vector, not an error. Callers act on "nothing is running"
    // by concluding a live PTY root is already gone.
    getAllProcesses.mockImplementation((cb: (rows: unknown) => void) => cb([]))
    resetWindowsProcessTableForTests()
    await expect(readWindowsProcessTableFresh()).rejects.toThrow(/unreadable/)
  })

  it('rejects when the snapshot never calls back', async () => {
    // The vendored reader latches a module-global on a wedge, so without a
    // deadline one hang kills the process table for the life of the app.
    vi.useFakeTimers()
    getAllProcesses.mockImplementation(() => {})
    resetWindowsProcessTableForTests()
    const pending = readWindowsProcessTableFresh()
    const assertion = expect(pending).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(3_000)
    await assertion
    vi.useRealTimers()
  })

  it('is unavailable off Windows without attempting a require', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    __setWindowsProcessTreeLoaderForTests()
    expect(isWindowsProcessTableAvailable()).toBe(false)
  })
})
