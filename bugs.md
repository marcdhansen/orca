The zero-regression bar is not met. Review of af702b1c54 against

  merge-base 9772da844a found 4 P0 release blockers, 27 P1 regressions,

  and 9 P2 issues. The branch also fails typecheck, desktop build, lint,

  and its new SSH E2E coverage.

  ## P0 — Release blockers

  1. Mobile can execute AI text as shell commands against older hosts.

     Identity-only launch is sent unconditionally at mobile/src/session/

     identity-create-terminal-params.ts:15. Old hosts strip it and

     create a bare shell; PR triage and review then submit provider/

     user-controlled text with Enter at mobile/src/session/pr-ai-triage-

     launch.ts:42 and mobile/src/session/use-mobile-diff-review-send-

     actions.ts:109. Filenames, titles, comments, or check output

     containing shell metacharacters can execute locally or over SSH.

  2. Catalog/reference authoring acknowledges changes before they are

     durable. Mutations return success immediately at src/main/agent-

     launch/agent-catalog-service.ts:247, while persistence waits 1–5

     seconds and merely logs failures at src/main/persistence.ts:3946.

     Crash, power loss, or disk failure can lose acknowledged agents/

     references or resurrect deletions.

  3. Migration accepts an unreadable pre-v1 backup as valid. Read

     failure returns “usable” at src/main/agent-launch/agent-catalog-

     pre-v1-backup.ts:16. Reproduced with a directory at the backup

     path: migration returned success without a readable rollback point.

  4. New “durable” launch stores silently swallow every write failure

     while callers report success:

      - src/main/agent-launch/agent-launch-operation-store-

        persistence.ts:269

      - src/main/agent-launch/agent-session-record-store-

        persistence.ts:171

      - src/main/agent-launch/background-agent-launch-store-

        persistence.ts:85

     These stores also use the non-fsync writer. Restart can lose

     idempotency, recovery, capacity, session-resume, or background-

     launch state.

  ## P1 — Functionality, reliability, security, and performance

  1. Paired web never consumes the custom-agent catalog. The host

     publishes it at src/main/runtime/rpc/methods/client-ui.ts:38, but

     paired web discards it at src/renderer/src/web/web-preload-

     api.ts:3926, rejects catalog access at src/renderer/src/web/web-

     preload-api.ts:756, and no-ops revision events at src/renderer/src/

     hooks/useIpcEvents.ts:1007. Custom agents cannot be selected or

     refreshed; a custom default becomes Blank.

  2. Paired-web identity launches are not capability-gated. src/

     renderer/src/runtime/web-runtime-session.ts:261 sends agentLaunch

     to old hosts, which create a bare shell and report success. The

     explicit gate already exists in src/renderer/src/runtime/agent-

     launch-identity-negotiation.ts:1.

  3. Folder-workspace quick-create has the same older-host regression:

     it sends an empty command plus only agentLaunch at src/renderer/

     src/components/sidebar/folder-workspace-composer-submit.ts:53. Old

     hosts open a blank shell and drop the linked draft/note.

  4. launchToken changed the daemon and SSH relay wire without version/

     capability negotiation. The daemon remains v33 at src/main/daemon/

     daemon-protocol-version.ts:1, while new main sends the field at

     src/main/daemon/daemon-pty-adapter.ts:512. Old surviving daemons/

     relays ignore it. After a main crash, the live agent appears absent

     and Retry can create a duplicate.

  5. A successful empty scoped SSH relist is never authoritative because

     connection IDs are recorded only while iterating returned sessions

     at src/main/runtime/orca-runtime.ts:32363. Pending launches remain

     unknown, retain capacity, and cannot retry.

  6. Catalog repair deadlocks with more than 256 corrupt rows. Snapshot

     generation requests tokens for every row, but src/main/agent-

     launch/agent-catalog-repair-mutations.ts:35 evicts them at 256.

     Reproduced with 257 rows: every repair token becomes stale.

  7. Reference payload budgeting measures the pre-persistence

     representation at src/main/agent-launch/agent-catalog-

     service.ts:229, not the expanded projection. A reproduced 180 KB

     input was accepted and persisted as a 541 KB payload over the 512

     KiB limit.

  8. Quick-command RPC updates bypass reference authority at src/main/

     runtime/orca-runtime.ts:4016: no live/enabled validation, reference

     revision, tombstone handling, or change event.

  9. Tombstone pruning is quadratic. src/main/agent-launch/agent-

     catalog-tombstone-gc.ts:23 rescans every reference owner for every

     tombstone. A minimal 3,500-row benchmark took about 591 ms before

     real scanner overhead.

  10. Mobile replay authorization changes are omitted from the admission

     fingerprint. Replay environment can change after an env rotation

     while the fingerprint remains identical: src/main/agent-launch/

     resolve-agent-launch-result.ts:107.

  11. WSL descriptors can be classified as native/local, leaving Windows

     or UNC paths inside Linux argv: src/main/agent-launch/agent-launch-

     host-state.ts:124, src/main/runtime/orca-runtime.ts:25930.

  12. The command-length cap runs before the final prompt is appended.

     RPC permits 100,000 characters at src/main/runtime/rpc/methods/

     agent-launch-spawn-schema.ts:44, the cap checks earlier at src/

     main/agent-launch/resolve-agent-launch.ts:296, and prompt suffixes

     are added later at src/shared/resolved-agent-startup-plan.ts:181.

     Windows can receive an oversized command instead of a typed

     failure.

  13. Stage-two host-state rejection can leak reservations because the

     read occurs before guarded transaction cleanup: src/main/agent-

     launch/agent-launch-worktree-resolution.ts:141, src/main/agent-

     launch/agent-launch-worktree-transaction.ts:115. Repeated SSH

     disconnect races can exhaust capacity until restart.

  14. Admission principals identify only mobile or runtime, not devices,

     by design at src/main/agent-launch/agent-launch-admission-

     store.ts:25. Multiple phones share limits and recovery rows;

     worktree/background Forget does not verify the stored principal,

     allowing one paired device to forget another’s launch.

  15. orchestration.dispatchForget claims owner authorization but

     performs no Run/caller ownership check at src/main/runtime/rpc/

     methods/orchestration.ts:1465. Stronger mutations use src/main/

     runtime/rpc/methods/orchestration-run-scope.ts:37.

  16. Environment-size validation checks only resolved custom env, not

     the actual inherited/default spawn environment. Native Windows can

     exceed CreateProcess’s environment-block limit and fail opaquely.

  17. Settled operation history is globally unbounded. Only each

     individual scope is capped at src/main/agent-launch/agent-launch-

     operation-store.ts:237; unique scopes live forever and every write

     serializes all scopes. At 5,000 scopes: 5,000 retained,

     approximately 2.8 GB cumulative serialization, 8.2 seconds before

     encryption/disk.

  18. Session records are permanently unbounded and synchronously

     rewrite encrypted full history at src/main/agent-launch/agent-

     session-record-store.ts:101. Valid-cap benchmark: 1,000 records,

     16.8 MB final payload, 8.4 GB cumulative writes, 11 seconds before

     real encryption/disk.

  19. Unbound launch staging also leaks. Runtime/mobile registrations

     provide terminalId but no paneKey, while the sole cleanup only

     removes by paneKey: src/main/agent-launch/agent-session-launch-

     registration.ts:32, src/main/agent-launch/agent-session-record-

     store.ts:170.

  20. Background launch attempts are globally unbounded at src/main/

     agent-launch/background-agent-launch-store.ts:43, with full-ledger

     writes on creation and settlement. At 5,000 attempts: 4.7 GB

     cumulative serialization and 8.1 seconds before disk.

  21. Production launch rebuilds the full normalized catalog 2–3 times

     per launch at src/main/agent-launch/agent-launch-spawn.ts:155 and

     src/main/agent-launch/agent-launch-boundary.ts:343. At a valid

     2,500-agent catalog, the three-pass p95 was about 32 ms of main-

     thread CPU before preflight/spawn. The registered performance test

     injects a prebuilt catalog and misses this production work.

  22. useLocalAgentCatalog creates a separate full IPC fetch, cache, and

     settings listener for every split group and closed quick-command

     dialog: src/renderer/src/hooks/useLocalAgentCatalog.ts:28, src/

     renderer/src/components/tab-bar/use-tab-bar-runtime-model.ts:151.

     Sixteen 2,500-agent builds cost about 161 ms and clone roughly 9.7

     MB.

  23. Direct work-item launch rejects custom overrides/defaults because

     it validates them against built-in-only detection at src/renderer/

     src/lib/launch-work-item-direct.ts:142.

  24. Source-control “Don’t save” launches stale persisted CLI args.

     Current edited agentArgs exist at src/renderer/src/components/

     right-sidebar/runSourceControlAgentActionStart.ts:123, but the

     launch sends only a recipe locator at line 136.

  25. The source-control action picker omits named custom agents because

     options are built from the built-in catalog/detection only: src/

     renderer/src/components/right-sidebar/

     useSourceControlAgentActionDialog.ts:146.

  26. Automation terminal cleanup is discarded. src/main/automations/

     service.ts:143 early-returns for already-final runs, but the

     renderer intentionally sends a second update clearing retired

     terminal pointers at src/renderer/src/hooks/

     useAutomationDispatchEvents.ts:377. “View run” can target a dead

     terminal.

  27. Remote capacity-recovery sheets do not live-refresh. src/renderer/

     src/components/agent/AgentLaunchCapacityRecoverySheet.tsx:135

     subscribes only to local preload events, not remote runtime

     worktreesChanged.

  28. All four new SSH custom-agent E2Es fail before exercising the

     feature. tests/e2e/helpers/docker-ssh-custom-agent-remote.ts:112

     treats SshTargetAddResult as the target instead of

     destructuring .target, producing SSH target "undefined" not found.

  29. The broken SSH suite is non-blocking in PR verification, and the

     release workflow runs full E2E only after publication: .github/

     workflows/pr.yml:541.

  ## P2 — Narrow but concrete regressions

  - Repaired null defaults map back to legacy Auto and can unexpectedly

    launch an installed agent: src/shared/tui-agent-selection.ts:82.

  - Legacy Windows prefix parsing does not understand PowerShell

    backticks or cmd carets: src/shared/legacy-agent-prefix-

    tokenizer.ts:115.

  - Duplicating a built-in flattens grouped args with .join(' '), losing

    quoted boundaries: src/main/agent-launch/agent-catalog-lifecycle-

    mutations.ts:117.

  - Future catalog schema versions remain writable by older app builds:

    src/shared/agent-catalog-schema-migration.ts:54.

  - Quick-create can submit before the catalog loads and silently choose

    a built-in: src/renderer/src/components/

    NewWorkspaceComposerModal.tsx:159.

  - Required Linux packaging bypasses the CLI require-graph verifier:

    package.json:72, config/scripts/run-electron-vite-targets-in-

    parallel.mjs:35. This reopens a previously shipped dead-CLI failure

    class.

  - Recovery UI advertises any existing backup as restorable even if it

    cannot be read.

  - settings.get now carries up to 512 KiB of catalog data on unrelated

    mobile/paired-web settings reads; paired web then discards it: src/

    main/runtime/rpc/methods/client-ui.ts:38.

  - Mobile revision caches clear data but retain every historical host

    key for process lifetime.