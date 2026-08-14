# Split `pty-connection.ts` under 400 lines

## Goal

- Source `src/renderer/src/components/terminal-pane/pty-connection.ts` ≤ 400 `wc -l` (already 4).
- Every dest file under `src/renderer/src/components/terminal-pane/pty-connection/` ≤ 400 `wc -l`.
- New `.ts` dest files also stay under oxlint `max-lines`: **300 counted** (`skipBlankLines` + `skipComments`). **No max-lines disables. No budget bumps.**
- Zero intentional behavior change. Cut/paste + imports. Keep why-comments.
- Public import path stays `./pty-connection` (`connectPanePty`, `STARTUP_CWD_FALLBACK_NOTICE`).
- Name dest files after concrete domain concepts. Never helpers/utils/common/misc/shared-stuff.

Current state (this worktree already finished the module-level extract):

| File | `wc -l` | Status |
| --- | --- | --- |
| `pty-connection.ts` | 4 | Thin barrel. Done. |
| 16 dest files listed in §1 | all well under 400/300 | Module-level extract. Done. |
| `pty-connection/connect-pane-pty.ts` | **8793** | Still the giant closure. This is the remaining split. |

`connectPanePty` lives at `connect-pane-pty.ts:425–8793` (8368 lines). `runDeferredConnect` is `3970–8519` (4550 lines).

Leave headroom: dest **bodies** should land around **180–220 counted lines**. Import blocks add 30–80 lines and count toward both `wc -l` and oxlint. If a dest is ≥260 counted after paste+imports, split it again before finishing.

---

## 1. Inventory

### Public API (barrel only)

| Symbol | Owner after split | Consumers |
| --- | --- | --- |
| `connectPanePty` | `pty-connection/connect-pane-pty.ts` | `TerminalPane.tsx`, `use-terminal-pane-lifecycle.ts`, `pty-connection.test.ts` (`await import('./pty-connection')`) |
| `STARTUP_CWD_FALLBACK_NOTICE` | `pty-connection/startup-cwd-fallback-notice.ts` | barrel + `startFreshSpawn` + one test |

`pty-connection-types.ts` stays a sibling (`PtyConnectionDeps`). Do not move it into the dest folder.

### 1a. Module-level — already extracted (keep, do not re-cut)

| Dest | Symbols | Est. wc |
| --- | --- | --- |
| `startup-cwd-fallback-notice.ts` | `STARTUP_CWD_FALLBACK_NOTICE` | 5 |
| `pty-connect-limits.ts` | `pendingSpawnByPaneKey`, SSH/retry/remote/diag/draft-paste constants, `recordPtyConnectDiagnostic` | 25 |
| `hidden-output-restore-limits.ts` | hidden-restore caps + unavailable warning | 38 |
| `foreground-output-budgets.ts` | foreground throughput/budget/drift constants | 16 |
| `foreground-output-scan.ts` | DEC 2026/cursor/focus sequences, `shouldWritePtyOutputForeground`, `scanSynchronizedForegroundOutput`, cursor helpers, inactive budget | 133 |
| `cursor-agent-reattach-screen.ts` | focus-mode types, parked cursor-agent screen, payload screen signal | 90 |
| `e2e-terminal-pty-harness.ts` | e2e injectors, hidden-snapshot override, output-debug | 160 |
| `hidden-startup-renderer-query.ts` | `shouldKeepHiddenStartupRendererQueriesLive`, `containsHiddenStartupRendererQuery` | 20 |
| `pane-pty-binding.ts` | `PanePtyBinding` | 24 |
| `agent-task-complete-settings.ts` | notification/tracking getters + subscribe | 50 |
| `ssh-session-connect.ts` | connect/outcome types, `waitForSshConnection`, prompt outcome | 70 |
| `paired-parked-terminal-restore.ts` | `isRemoteRuntimePtyId`, `canRestorePairedParkedTerminal`, `isSessionOwnedByWorktree` | 35 |
| `codex-pane-stale.ts` | restart-notice presence + `isCodexPaneStale` | 55 |
| `setup-split-geometry.ts` | rect/grid/setup-split readiness | 80 |
| `agent-done-started-at.ts` | `resolveLatestAgentDoneStartedAt` | 20 |
| `fresh-spawn-types.ts` | `PendingStartupCommand`, `FreshSpawnOptions`, `ColdRestoreAgentResumeStartup` | 26 |

### 1b. `connectPanePty` groups still inside `connect-pane-pty.ts`

Line numbers are **current** (`connect-pane-pty.ts`).

**Spine (425–3969)** — indent-2 state + handlers created at `connectPanePty` call time:

| Lines | Group | Est. body |
| --- | --- | --- |
| 425–542 | identity, timers, no-op slots, kitty tracker, startup capture | 118 |
| 543–664 | sleeping record + draft-paste claim | 122 |
| 665–716 | launch-config register + `neutralTerminalTitle` | 52 |
| 717–844 | pending shell command / CSI consume | 128 |
| 845–957 | title-completion suppress + hook lifecycle | 113 |
| 958–1043 | `observeAcceptedShellCommandInput` | 86 |
| 1044–1135 | authoritative/scoped owner + title-only interrupt | 92 |
| 1136–1218 | reattach payload signal + idle cursor reset | 83 |
| 1219–1358 | interrupt/question inference + pending intent | 140 |
| 1359–1593 | command-finished + visible foreground sample | 235 |
| 1594–1655 | `onTerminalKeyDown` | 62 |
| 1657–1743 | fit binding + side-effect fact consumer | 87 |
| 1744–1824 | `createAgentCompletionCoordinator` | 81 |
| 1825–1946 | surviving-pane focus + hibernate wake consume | 122 |
| 1947–2097 | `onExit` | 151 |
| 2098–2177 | `onTitleChange` + cache-timer seed | 80 |
| 2178–2300 | Command Code working/done status | 123 |
| 2301–2416 | `bindActivePanePty` / `onPtySpawn` / `onPtyRebind` | 116 |
| 2418–2632 | BEL + task-complete notification | 215 |
| 2633–2710 | idle / working / exited title callbacks | 78 |
| 2711–2972 | pane env, host route, direct-SSH retry, ConPTY mode | 262 |
| 2973–3256 | renderer-owned status, transport create, capability replies | 284 |
| 3257–3552 | viewport claim, undeliverable-input recovery, `forwardPtyInput` | 296 |
| 3553–3912 | resize, grid drift, observed geometry, spawn-size reconcile | 360 |
| 3913–3969 | startup-grid settle + `runDeferredConnect` scheduler prelude | 57 |

**`runDeferredConnect` (3970–8519)** — locals are created only after `connectStarted = true` (not on the startup-grid early return). Preserve that timing.

Largest inners:

| Symbol | Lines | Est. body |
| --- | --- | --- |
| `reportError` + serializer + draft paste + cold restore | 4010–4538 | 529 |
| `startFreshSpawn` | 4539–4764 | 226 |
| replay write / drain / `replayDataCallback` | 4765–5085 | 321 |
| `captureTransportOutputCallbacks` | 5086–5148 | 63 |
| hidden-restore state + serialize + flood + delivery sync | 5149–5550 | 402 |
| write/refresh/`writePtyOutputToXterm` | 5551–5804 | 254 |
| skip/salvage/queue/reconcile/seq | 5805–6560 | 756 |
| `applyMainBufferSnapshot` | 6561–6753 | 193 |
| `requestHiddenOutputRestoreIfNeeded` | 6754–7023 | 270 |
| `dataCallback` | 7024–7193 | 170 |
| reattach live-data deferral + SSH prepaint | 7194–7388 | 195 |
| `handleReattachResult` | 7389–7843 | **455** |
| `attachRetainedLegacyPty` (fn only) | 7844–7867 | 24 |
| SSH deferred connect + session resolve + attach/spawn | 7868–8518 | **651** |
| reconcile + binding + dispose | 8520–8793 | 274 |

`attachRetainedLegacyPty` itself is 24 lines. The 676-line span cited in the prompt is that function **plus** the rest of `runDeferredConnect`. Cut those as separate dests.

---

## 2. Giant-closure strategy: `ConnectPanePtySession` + `install*`

Do **not** try to keep nested closures by passing 30 arguments. Do **not** add max-lines disables.

### Mutable session bag

```ts
export type ConnectPanePtySession =
  ConnectPanePtySessionCore &
  ConnectPanePtySessionAgent &
  ConnectPanePtySessionTransport &
  ConnectPanePtySessionOutput &
  ConnectPanePtySessionFnSlots
```

- One flat object. Shared `let`/`const` becomes `session.field`.
- Locals used by only one dest stay local in that dest.
- Function slots (`session.onExit`, `session.dataCallback`, …) replace `let foo = () => {}` / later reassignment.
- `transport` is a late-assigned slot. Installers that *define* functions before create-transport may close over `session.transport` and read it at **call** time only — same TDZ-safe pattern as today’s `const transport` declared later.

Split the type across dests so the type files themselves stay under 300 counted:

| Dest | Contents | Est. wc |
| --- | --- | --- |
| `connect-pane-pty-session-core.ts` | pane/manager/deps/cacheKey, disposed, connect timers, recovery ids | 160 |
| `connect-pane-pty-session-agent.ts` | shell-inference, title/hook, interrupt, hibernate, completion | 160 |
| `connect-pane-pty-session-transport.ts` | transport, SSH retry, resize/geometry, input marks | 160 |
| `connect-pane-pty-session-output.ts` | hidden-restore, replay queue, seq baselines, draft-paste | 180 |
| `connect-pane-pty-session-fn.ts` | function-slot types only | 180 |
| `connect-pane-pty-session.ts` | intersection alias | 20 |
| `create-connect-pane-pty-session.ts` | `createConnectPanePtySession` + four `init*Session*` slice fillers | 220 |

`createConnectPanePtySession` initializes every scalar/timer/no-op slot. It does **not** run definition-time side effects (no `addEventListener`, no transport create, no rAF).

### `install*` contract

```ts
export function installOnExit(session: ConnectPanePtySession): void {
  session.onExit = (ptyId, opts = {}) => {
    if (session.handledExitPtyId === ptyId) return
    // original body; identifiers → session.identifier
  }
}
```

Mechanical rewrite rules:

1. Cut/paste the original body. Keep every why-comment next to the same statement.
2. Shared state: `foo` → `session.foo`. Do not rename fields.
3. Late reassignment (`queueAgentIdleTerminalModeReset = …`, `wakeHibernatedAgentPane = …`) becomes `session.queueAgentIdleTerminalModeReset = …` at the same source location.
4. Do not invert `if`/`return` order. Do not merge branches. Do not “clean up” `let`.
5. If a dest exceeds 300 counted after imports, extract the next sequential named step. Do not add a disable.

### Two-phase install (preserve `runDeferredConnect` timing)

Today many functions and almost all hidden-restore/replay state are **created inside** `runDeferredConnect` only after `connectStarted = true`. Outer binding methods can run first (`syncProcessTracking` today still hits the no-op `syncHiddenRendererPtyDelivery`). Hoisting those installs to `connectPanePty` time would change pre-connect behavior.

| Phase | When | What |
| --- | --- | --- |
| A | `connectPanePty` body | identity + outer handlers + transport + resize + scheduler |
| B | first `runDeferredConnect` pass after `connectStarted = true` | serializer, draft paste, spawn/reattach, replay, hidden restore, `dataCallback`, SSH deferred flow |

```ts
session.runDeferredConnect = () => {
  if (session.connectStarted) return
  if (!session.startupGridSettledForConnect && shouldSettleStartupGridBeforeConnect(session)) {
    // same early return as today — Phase B must NOT run
    …
    return
  }
  session.connectStarted = true
  installDeferredConnectInners(session) // Phase B, once
  resolveDeferredConnectTarget(session) // SSH / reattach / attach / spawn
}
```

`installDeferredConnectInners` is a thin sequencer (install calls only) so it stays under 400/300.

### Oversized inners — sequential named steps, not a 400-line dest

- `handleReattachResult` (455): outer bind/expiry stays in `install-handle-reattach-result.ts`; paint branches become `apply-reattach-daemon-snapshot.ts`, `apply-reattach-replay-or-model.ts`, `apply-reattach-cold-restore.ts`; fit continuation in `fit-after-reattach-restore.ts`.
- SSH/session/spawn tail (651): `install-ssh-deferred-connect-gate.ts`, `install-ssh-deferred-passphrase-wait.ts`, `install-ssh-deferred-reattach.ts`, `install-resolve-deferred-reattach-session.ts`, `install-deferred-reattach-connect.ts`, `install-deferred-attach-or-spawn.ts`.
- `requestHiddenOutputRestoreIfNeeded` (270 + imports): kickoff/scheduler vs async loop as two dests.
- `startFreshSpawn` (226 + imports): connect call vs `.then` settle as two dests (`install-start-fresh-spawn.ts`, `settle-fresh-spawn-result.ts`).
- `applyMainBufferSnapshot` (193 + imports): snapshot write vs `afterRestore` fit as two dests if imports push it over.

---

## 3. Dest path list (remaining) with estimates

Estimates include a typical import block. Each dest must finish ≤400 wc / ≤300 counted.

### Session bag

| Path | Est. wc | Est. counted |
| --- | --- | --- |
| `connect-pane-pty-session-core.ts` | 160 | 140 |
| `connect-pane-pty-session-agent.ts` | 160 | 140 |
| `connect-pane-pty-session-transport.ts` | 160 | 140 |
| `connect-pane-pty-session-output.ts` | 180 | 155 |
| `connect-pane-pty-session-fn.ts` | 180 | 165 |
| `connect-pane-pty-session.ts` | 20 | 15 |
| `create-connect-pane-pty-session.ts` | 220 | 200 |

### Phase A installers (outer `connectPanePty`)

| Path | Source lines | Est. wc |
| --- | --- | --- |
| `install-sleeping-record-access.ts` | 543–664 | 180 |
| `install-launch-config-title.ts` | 665–716 | 90 |
| `install-shell-command-inference.ts` | 717–844 | 190 |
| `install-agent-completion-side-effects.ts` | 845–957 | 170 |
| `install-observe-shell-command-input.ts` | 958–1043 | 140 |
| `install-pane-agent-identity.ts` | 1044–1135 | 150 |
| `install-reattach-idle-cursor.ts` | 1136–1218 | 140 |
| `install-interrupt-input-intent.ts` | 1219–1358 | 200 |
| `install-command-finished-policy.ts` | 1359–1521 | 220 |
| `install-visible-foreground-sample.ts` | 1522–1593 | 130 |
| `install-terminal-keydown.ts` | 1594–1655 | 120 |
| `install-pane-pty-fit-binding.ts` | 1657–1743 | 150 |
| `install-agent-completion-coordinator.ts` | 1744–1824 | 150 |
| `install-hibernated-agent-wake.ts` | 1825–1946 | 180 |
| `install-pty-exit.ts` | 1947–2097 | 210 |
| `install-title-change.ts` | 2098–2177 | 140 |
| `install-command-code-status.ts` | 2178–2300 | 180 |
| `install-bind-spawn-rebind.ts` | 2301–2416 | 180 |
| `install-bell-notifications.ts` | 2418–2513 | 160 |
| `install-agent-task-complete-notification.ts` | 2514–2632 | 180 |
| `install-agent-idle-working-exited.ts` | 2633–2710 | 130 |
| `install-pane-identity-env.ts` | 2711–2812 | 160 |
| `install-direct-ssh-retry.ts` | 2813–2910 | 160 |
| `install-windows-conpty-mode.ts` | 2911–2972 | 120 |
| `install-renderer-owned-agent-status.ts` | 2973–3090 | 180 |
| `install-pty-transport.ts` | 3091–3256 | 230 |
| `install-viewport-recovery.ts` | 3257–3400 | 200 |
| `install-forward-pty-input.ts` | 3401–3552 | 210 |
| `install-pty-resize.ts` | 3553–3671 | 180 |
| `install-foreground-grid-drift.ts` | 3672–3728 | 110 |
| `install-observed-pane-geometry.ts` | 3729–3864 | 200 |
| `install-pty-size-reconcile.ts` | 3865–3912 | 100 |
| `install-startup-grid-settle.ts` | 3913–3969 | 110 |

### Phase B installers (`runDeferredConnect` inners)

| Path | Source lines | Est. wc |
| --- | --- | --- |
| `install-deferred-connect.ts` | 3970–4008 + sequencer | 120 |
| `install-pane-serializer.ts` | 4010–4158 | 200 |
| `install-startup-draft-paste.ts` | 4159–4295 | 200 |
| `install-cold-restore-resume.ts` | 4296–4450 | 210 |
| `install-pending-startup-command.ts` | 4451–4538 | 150 |
| `install-start-fresh-spawn.ts` | 4539–4640 | 180 |
| `settle-fresh-spawn-result.ts` | 4641–4764 | 190 |
| `install-replay-write.ts` | 4765–4924 | 220 |
| `install-replay-data-drain.ts` | 4925–5085 | 220 |
| `install-transport-output-callbacks.ts` | 5086–5148 | 120 |
| `install-hidden-restore-state.ts` | 5149–5250 | 170 |
| `install-hidden-output-snapshot.ts` | 5251–5350 | 160 |
| `install-hidden-restore-flood.ts` | 5351–5480 | 190 |
| `install-hidden-delivery-sync.ts` | 5481–5550 | 140 |
| `install-pty-output-refresh.ts` | 5551–5710 | 210 |
| `install-write-pty-output.ts` | 5711–5804 | 170 |
| `install-hidden-query-salvage.ts` | 5805–5960 | 210 |
| `install-restore-chunk-reconcile.ts` | 5961–6120 | 210 |
| `install-snapshot-kitty-seq.ts` | 6121–6240 | 180 |
| `install-hidden-restore-timers.ts` | 6241–6400 | 200 |
| `install-hidden-restore-abandon.ts` | 6401–6560 | 210 |
| `install-apply-main-buffer-snapshot.ts` | 6561–6660 | 180 |
| `install-snapshot-after-restore.ts` | 6661–6753 | 160 |
| `install-request-hidden-restore.ts` | 6754–6880 | 190 |
| `install-run-hidden-restore-loop.ts` | 6881–7023 | 210 |
| `install-live-data-callback.ts` | 7024–7193 | 230 |
| `install-reattach-live-deferral.ts` | 7194–7288 | 160 |
| `install-ssh-reattach-prepaint.ts` | 7289–7388 | 170 |
| `install-handle-reattach-result.ts` | 7389–7550 | 220 |
| `apply-reattach-daemon-snapshot.ts` | snapshot branch | 160 |
| `apply-reattach-replay-or-model.ts` | replay/model branch | 190 |
| `apply-reattach-cold-restore.ts` | cold-restore branch | 150 |
| `fit-after-reattach-restore.ts` | fit continuation | 100 |
| `install-attach-retained-legacy-pty.ts` | 7844–7867 | 70 |
| `install-ssh-deferred-connect-gate.ts` | 7868–7920 | 110 |
| `install-ssh-deferred-passphrase-wait.ts` | 7921–8040 | 190 |
| `install-ssh-deferred-reattach.ts` | 8041–8180 | 220 |
| `install-resolve-deferred-reattach-session.ts` | 8181–8280 | 170 |
| `install-deferred-reattach-connect.ts` | 8281–8420 | 210 |
| `install-deferred-attach-or-spawn.ts` | 8421–8518 | 180 |
| `install-deferred-connect-inners.ts` | Phase B sequencer only | 80 |

### Binding return + orchestrator

| Path | Source lines | Est. wc |
| --- | --- | --- |
| `install-session-reconcile.ts` | 8520–8589 | 130 |
| `create-pane-pty-binding.ts` | 8590–8670 | 150 |
| `dispose-pane-pty-binding.ts` | 8671–8792 | 190 |
| `connect-pane-pty.ts` | create session + Phase A `install*` calls + return binding | **≤200** |

`connect-pane-pty.ts` after the split is only the orchestrator (no handler bodies). That is what gets the remaining giant file under 400.

**New dest count: 73 files. Plus the 16 already-extracted module-level dests = 89 files in `pty-connection/`. Barrel stays at the parent path.**

If any dest is over after paste, split that dest again. Do not ship a dest over 400/300.

---

## 4. Import update list

| File | Change |
| --- | --- |
| `pty-connection.ts` | Already the barrel. Keep: re-export `connectPanePty` + `STARTUP_CWD_FALLBACK_NOTICE` only. Do not add more public exports. |
| `TerminalPane.tsx` | No change (`import { connectPanePty } from './pty-connection'`). |
| `use-terminal-pane-lifecycle.ts` | No change. |
| `pty-connection.test.ts` | No change (`await import('./pty-connection')`). |
| `pty-connection-types.ts` | No change. Dest files import `../pty-connection-types`. |
| `connect-pane-pty.ts` | Drop the 420-line import wall. Import session create + Phase A installers + binding factory only. |
| New dests | Sibling dests via `./name`. Parent pane modules via `../name`. Shared via `../../../../../shared/...`. `@/` aliases unchanged. |
| **Never** | A dest importing `../pty-connection` (the barrel). That is a cycle. |

Barrel re-export is an explicit exception to the no-re-export rule so consumers keep `./pty-connection`. Dest files must import each other directly.

---

## 5. Characterization tests

Do **not** add new tests unless a newly exported pure symbol has zero coverage from `pty-connection.test.ts`.

Existing coverage is the behavior lock: `pty-connection.test.ts` dynamically imports the barrel and drives `connectPanePty` (579 tests). Module-level dests stay unexported from the barrel, so they keep getting hit through those tests.

If a dest must export a pure function for another dest, keep it folder-internal. Do not add it to the barrel.

---

## 6. Sequencing

Do this in order so the file is always compilable and tests can run after each phase.

1. Add session type slices + `createConnectPanePtySession`. Leave `connectPanePty` bodies in place; only move the top-of-function `let`/`const` defaults onto the bag **in a follow-up commit-sized step**, not all at once if that blocks review — but the implementation may do it in one pass as long as identifiers rewrite 1:1.
2. Extract Phase A installers from the **bottom of the outer spine upward** (dispose/reconcile, then resize, then input, then transport, then title/exit). After each extract, `connect-pane-pty.ts` shrinks and still calls the installer.
3. Extract Phase B: first the sequencer + `runDeferredConnect` shell, then oversized inners (`handleReattachResult`, SSH tail, hidden restore, `startFreshSpawn`, `dataCallback`).
4. When `connect-pane-pty.ts` is only create + `install*` calls + `return createPanePtyBinding(session)`, stop.
5. `wc -l` every dest. Split any dest over 400 wc or 300 counted.
6. Run verification. Prune the stale max-lines baseline entry for the old `pty-connection.ts` disable (`pnpm check:max-lines-ratchet --prune`). `connect-pane-pty.ts` must not gain a disable.

Do not stop at a “partial” split that leaves `connect-pane-pty.ts` over 400.

---

## 7. Verification

```bash
pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/terminal-pane/pty-connection.test.ts
pnpm run typecheck:web
pnpm run check:max-lines-ratchet
wc -l src/renderer/src/components/terminal-pane/pty-connection.ts \
  src/renderer/src/components/terminal-pane/pty-connection/*.ts
```

Every path printed by `wc -l` must be ≤ 400. After the source/orchestrator lose any `oxlint-disable max-lines`:

```bash
pnpm check:max-lines-ratchet --prune
```

No push, no PR. Local commit only if green:

`refactor: split pty-connection.ts under 400 lines`
