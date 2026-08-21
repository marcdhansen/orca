# Reading the Windows process table

Orca needs three things from the Windows process table: who a PID's parent is
(descendant walks and teardown identity), what a process is running (agent
recognition), and how much memory/CPU it uses (Resource Manager).

Node cannot answer the first one without native code. That is why seven
independent readers existed, each forking `powershell.exe` to run
`Get-CimInstance Win32_Process`, with a `wmic` fallback that Windows 11 24H2 has
since removed.

## Use the native snapshot

`src/main/windows/windows-process-table.ts` is the only module that may read the
table. It wraps a Toolhelp32 snapshot from `@vscode/windows-process-tree`.

```ts
import { readWindowsProcessTable, readWindowsProcessTableFresh } from '../windows/windows-process-table'
```

- `readWindowsProcessTable()` — shared TTL cache. Use for anything periodic.
- `readWindowsProcessTableFresh()` — a snapshot that starts after the call. Use
  for teardown identity, where a cached row can predate the exit it is being
  asked about.

Both **reject** when the table cannot be read. Do not convert that into an empty
array. An empty table is a claim that nothing is running, and callers act on
that claim by declaring a tree dead or a shell childless. "Unavailable" has to
stay distinguishable from "empty" — collapsing the two is how a PTY tree
survived its own teardown (#9045).

Measured on Windows 11 with 1050 processes (p50 / p95):

| | p50 | p95 |
| --- | --- | --- |
| pid + ppid + name | 15.9 ms | 17.5 ms |
| + memory + command line | 30.6 ms | 33.7 ms |
| `Get-CimInstance` via PowerShell | 706 ms | 723 ms |

## Why the package is patched

`config/patches/@vscode__windows-process-tree@0.8.0.patch` carries two hunks.

1. **Spectre mitigation.** The upstream `binding.gyp` requires Spectre-mitigated
   libraries, which Orca's Windows build agents do not install. `node-pty` is
   patched the same way for the same reason.
2. **The 1024-process cap.** `GetRawProcessList` stopped after 1024 entries.
   Measured on a real host with 1051 processes, the module returned exactly
   1024 and the querying process was itself among the 27 missing. A truncated
   snapshot silently hides the descendants a teardown is trying to reap — the
   exact failure the native path exists to remove.

The typings claim `commandLine` is truncated at 512 characters. Measured, it is
not: the longest observed on a real host was 26,059.

## Packaging

The addon is Windows-only, so it follows the same contract as
`windows-native-registry` (asserted by
`config/scripts/package-electron-runtime-contract.test.mjs`):

- an `optionalDependency`, so a macOS/Linux install tolerates its absence;
- **not** in `pnpm.onlyBuiltDependencies` — pnpm installs optional dependencies
  on every host, and macOS/Linux must never run `node-gyp` for it;
- listed in the win32 branch of `rebuild-native-deps.mjs` and
  `ensure-native-runtime.mjs`;
- copied into the packaged `node_modules` for win32 only.

## What the snapshot does not provide

`CreationDate` (process start time) has no equivalent. Anything using a start
time to prove a PID has not been recycled — daemon identity, managed-hook
ownership, and CPU accounting in the memory collector — still reads it through
its own query. Those callers are not migrated.

Start time is a proxy for identity, not identity. The durable answer for the
process trees Orca itself spawns is an inherited handle: a job object names the
tree Orca created, so no start-time comparison is needed. Those readers should
be resolved that way rather than by adding a start time to this module.

Do not adopt `getProcessCpuUsage()` from the package. It takes both CPU samples
inside one call with a blocking `Sleep(1000)` in the middle, which would hold a
libuv threadpool slot for a full second out of the Resource Manager's two-second
poll.

## Owning a PTY's process tree

`src/main/windows/windows-pty-job.ts` is the counterpart to reading the table:
it answers "is this tree mine, and how do I kill it?" with a handle instead of
an inference.

node-pty is patched (`config/patches/node-pty@1.1.0.patch`) to create a job
object per ConPTY and assign the shell to it under `CREATE_SUSPENDED`, before
the shell can spawn anything. Assigning after the fact leaves a window in which
a fast child escapes the job.

- `terminatePtyJob(proc)` — one `TerminateJobObject` call for the whole tree.
- `listPtyJobProcessIds(proc)` — the live pids under a tree that is still
  tracked, including children that detached from the console.

Measured on Windows 11 against a shell whose grandchild was spawned `detached`:
job membership was `[shell, grandchild]` and one call killed both. Neither a
parent-pid walk nor `GetConsoleProcessList` sees that grandchild — it leaves
the console and reparents, which is what left `claude.exe`/`node.exe`/`cmd.exe`
holding worktree directories open (#9045, #10475, #10897).

The per-PTY job deliberately does **not** set
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Measured on Windows 11: with that flag,
releasing the handle when the shell exits also kills whatever the user left
running, so typing `exit` in a pane reaped a `start /b` server that used to
survive. The job exists to make an *explicit* teardown exact, not to redefine
what a clean exit means.

That means reaping a dead daemon's shells (#9195, #10415) is **not** delivered
by this job. It needs a separate daemon-level job that the daemon assigns
itself to at startup; children inherit job membership, so its closure on daemon
death reaps the shells without touching clean-exit semantics.

Once the shell exits, node-pty drops its handle record and closes the job, so a
terminated tree reports `null` rather than `[]`. Null means *unverifiable* in
the sense of [`ssh-execution-boundary.md`](./ssh-execution-boundary.md) — no job
support, not a ConPTY, or no longer tracked. It is never evidence that
processes died.

Both functions report `unavailable` / `null` rather than a false success when a
pty has no job — an outer job without `JOB_OBJECT_LIMIT_BREAKAWAY_OK` (some EDR
and container hosts) can refuse the assignment, and a pty started before this
build has none. Callers must fall back, not conclude the tree is gone. That
conflation is the original bug.

### Known limitation: the baton table is not synchronised

node-pty keeps its per-terminal handles in a plain `std::vector` and erases from
it on a detached exit thread, while `get_pty_baton` is called from the main JS
thread. That race predates this change — `PtyResize`, `PtyClear` and `PtyKill`
all read the table the same way — but `terminatePtyJob` adds an instance of it:
the exit thread can close `hJob` between the lookup and `TerminateJobObject`.

Losing that race normally just returns `FALSE`, which surfaces as `unavailable`
and falls back. The case that would not be benign is a recycled `HANDLE` value,
where the call could reach a different job in the same process. Fixing it
properly means synchronising node-pty's handle table rather than adding a lock
around one accessor, so it is deliberately left alone here.
