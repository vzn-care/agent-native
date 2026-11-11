# Implementation verification — 2026-11-11

## Mac continuation

The three Unix IPC tests that could not bind in the cloud passed on the Mac. `node --test packages/vzn-code-host/test/*.test.ts packages/vzn-code-gateway/src/*.test.ts` finished with **19 passed, 0 failed, 0 skipped**. The browser gateway read the real host catalog over private IPC.

An isolated local Code app at `/code/home` connected to the gateway and a disposable project. Through the browser, a read-only task started on the host's actual Agent-Native CLI using its explicit fixture response, completed, and displayed its transcript. A second task used the runtime's long-running test executable: the browser disconnected, reconnected, recovered the same run by ID while it remained active, and cancelled it. The displayed terminal state was `cancelled`. This is local browser-to-host proof; provider authentication, a supervised service, and a second physical device remain open.

Both copied checkouts had incomplete Git object stores and hundreds of missing baseline files. Local object alternates now point to the original repositories, and only tracked files marked deleted were restored. The VZN Code work remains isolated from the original checkouts.

These results distinguish source/build validation from deployment and two-device acceptance. No production deployment, real provider request, live Gitea provisioning, or device ownership transfer was performed.

## Results

| Area                             | Actual result                                                                                        | Scope of proof                                                                                                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework dependency baseline    | Pinned pnpm 10.29.1 frozen installation passed; final offline frozen installation passed             | Existing external dependency resolutions preserved; new private workspace importers and pinned Node types added                                                                         |
| Core prerequisite packages       | Built agentkit, recap-cli, shared-app-config, toolkit, core and code-agents-ui                       | Local generated exports available                                                                                                                                                       |
| Fork concurrency compatibility   | 136 tests passed; core typecheck and full build passed                                               | Public config/CLI/env behavior restored on upstream implementation                                                                                                                      |
| Desktop identity                 | 66 tests passed; full typecheck and `build:vzn` passed                                               | Main, preload, renderer and runner bundles compile; Vite and Electron Builder configuration validation passed                                                                           |
| Host                             | 16 passed on Mac; no skipped tests                                                                  | SQLite transactions, durable grants, retry/cancel races, event replay, process-controller integration, SIGKILL lease recovery, and live private IPC                                   |
| Runtime adapter                  | 5 real-subprocess tests passed; typecheck passed                                                     | Owned process cancellation, session linkage, transcript replay, orphan uncertainty and known failed-exit recovery                                                                       |
| Existing upstream runtime        | Actual built CLI fixture completed with exit 0 and five translated/replayed events                   | Reuses real Agent-Native execution path with its explicit fixture engine; provider credentials/authentication remain unverified                                                         |
| Gitea API adapter                | 20 tests passed; strict typecheck passed                                                             | HTTP contract/policy handling against controlled responses; not live SSH enforcement                                                                                                    |
| Checkpoint capture and transport | 18 real-Git tests passed; strict typecheck passed                                                    | Staged/unstaged/untracked/binary/mode/symlink fidelity, source preservation, immutable refs, bare-remote transfer, retry, origin protection and URL-rewrite isolation                   |
| Browser gateway                  | 3 tests passed on Mac; typecheck passed                                                              | Real HTTP origin/authentication/mutation rejection and successful host transport                                                                                                        |
| Web app                          | 9 tests passed; app typecheck and production compilation passed; local browser task flow passed      | Isolated PGlite with default development auto-login; connection, task start, transcript, reconnect, and cancellation verified against a disposable local host                         |
| Workspace doctor                 | 1,049 existing findings, zero assigned to new Code app                                               | Existing workspace health is not represented as a clean doctor pass                                                                                                                     |
| Preview gateway                  | 14 tests passed, including 4 real TCP HTTP/WebSocket cases; typecheck passed                         | Authentication, cookies/headers, bidirectional WebSocket buffers and live revocation proved locally; host registration, ingress and physical-device proof remain open                   |

The earlier cloud run produced **41 passing tests and 3 Unix-socket-dependent failures**, with zero skips. Those three tests now pass on Mac. The earlier 284 focused passing tests are not a claim that the full upstream monorepo suite passed.

All six new private packages pass their normal package `typecheck` scripts with the pinned root dependencies. Final frozen offline installation succeeds without changing existing external dependency resolutions.

The browser screenshot is saved in the sibling workspace at `docs/evidence/code-disconnected-preview.png`. It deliberately shows the tested connection-error state, not a simulated successful Studio connection.

## Review findings repaired

1. **Process ownership after reconnect:** a native transcript can say completed before its process exits. Restarted adapters now require a durable association terminal result written after the owning process-close event. An unconfirmed process remains uncertain and keeps its execution fence.
2. **Rejected start locking a workspace:** invalid prompts and unavailable CLI preflight no longer reserve execution. Definitively unlaunched failures are distinguished from ambiguous launch failures.
3. **Failed tasks locking a workspace:** a confirmed failed process exit is a terminal error and can be retried with a new run identity; it does not imply successful task completion.
4. **Competing roots:** one workspace per project is enforced until isolated worktree execution is integrated, preventing two workspace IDs from writing the same registered project root.
5. **Capability mismatch:** browser task-control capabilities are advertised only when the gateway and host both permit them. A read-only gateway rejects task-control negotiation.
6. **Checkpoint origin aliases:** temporary-bare-remote tests caught `/var` versus `/private/var` aliases; canonical destination checks protect the normal origin.

## Commands

Run from the framework root with Node 26 and pinned dependencies:

```sh
node --test packages/vzn-code-host/test/*.test.ts packages/vzn-code-runtime/test/*.test.ts packages/vzn-code-gitea/src/*.test.ts packages/vzn-code-gateway/src/*.test.ts
node --test packages/vzn-code-workspace/src/*.test.ts
pnpm --filter @vzn-care/code-host typecheck
pnpm --filter @vzn-care/code-runtime typecheck
pnpm --filter @vzn-code/gateway typecheck
pnpm --filter @agent-native/desktop-app typecheck
pnpm --filter @agent-native/desktop-app build:vzn
```

See the sibling web workspace's `docs/code-foundation-baseline.md` for app commands and its separate pinned dependency versions.

## Earlier cloud environment limitations

The cloud execution environment denied Unix socket binding with `listen EPERM`. This limitation was resolved for the local Mac test above; physical-device validation remains separate.

The first web build was rejected by automatic approval review because its CLI attempted ancillary telemetry to `analytics.agent-native.com`. The supported opt-outs `DO_NOT_TRACK=1` and `AGENT_NATIVE_TELEMETRY_DISABLED=1` produced a successful build without that disclosure. Production-authentication and persistent-database startup requirements were preserved; real credentials were not read or invented.

The branded desktop has not been launched as an installed application, signed or notarized. Its current identity change does not replace every upstream icon, UI label, workspace path or native browser-host registration. Windows protected host transport and native runtime execution are explicitly unavailable rather than using an insecure fallback.

## Next acceptance gate

Run the live Gitea, private preview ingress, supervised host lifecycle, and physical-device checks documented beside those components before implementing the remaining handoff and environment milestones.
