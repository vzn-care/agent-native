# Implementation verification — 2026-11-11

## Mac continuation

### Durable Mac pilot services

The framework PR branch was installed in `/Users/chris/dev/VZN-Dev/vzn-code-framework` with pinned Node 26 and a frozen pnpm install. The existing Studio host journal and project catalog were retained in a private state directory. The host and separate local/preview browser gateways are loaded as user LaunchAgents. Each process was forcibly terminated once and restarted by launchd; the local and private HTTPS listeners returned after the restart. Authenticated `health` RPCs through both gateway origins returned HTTP 200 against the host. Preview ingress remains Tailscale Serve, not Funnel. The gateway restarts clear browser sessions; the owner must sign in again in each browser profile. Login-after-reboot and a second device remain unverified.

An actual read-only CLI task initially reported a credential gap and exited. The runtime was changed to classify a confirmed credential-gap exit as a retryable error, and restart reconciliation cleared that run's uncertain fence. The Mac owner was already signed into Codex CLI; the host LaunchAgent now selects that engine explicitly and includes its installed command directory in `PATH`. A second read-only host task completed through Codex CLI, correctly reporting the pilot workspace package name `vzn-care` and manager `pnpm@10.14.0`. The Git working tree was clean before and after. This proves one live provider request on Studio, not browser or second-device provider acceptance.

The branded Desktop build now accepts an explicit `VZN_CODE_APP_URL` and saved the local Code page as a custom app in its isolated profile. Its VZN Code entry and embedded `/code/home` page were visually observed. Chrome sign-in did not authorize the Desktop webview's separate cookie session. The Desktop now opens the gateway `/connect` page in a restricted child window with that webview's session. After the owner signed in there, the Code page showed `Connected host` and the `pilot` project. A read-only task started from that Desktop page, completed through the supervised host and Codex CLI, and displayed its transcript. The answer matched `package.json`; the pilot Git tree stayed clean. The Desktop typecheck, VZN build, and 22 focused tests passed.

The three Unix IPC tests that could not bind in the cloud passed on the Mac. `node --test packages/vzn-code-host/test/*.test.ts packages/vzn-code-gateway/src/*.test.ts` finished with **19 passed, 0 failed, 0 skipped**. The browser gateway read the real host catalog over private IPC.

An isolated local Code app at `/code/home` connected to the gateway and a disposable project. Through the browser, a read-only task started on the host's actual Agent-Native CLI using its explicit fixture response, completed, and displayed its transcript. A second task used the runtime's long-running test executable: the browser disconnected, reconnected, recovered the same run by ID while it remained active, and cancelled it. The displayed terminal state was `cancelled`. A temporary Mac LaunchAgent also passed install, health, forced-kill restart, and uninstall checks. This earlier check used a fixture; the live Codex CLI check above ran afterward through the durable host.

The `dev:vzn` Electron app opened on Studio after the pinned Electron binary was installed in the isolated checkout. Its process used the separate `VZN Code Dev` profile and `VZN Code` log directory. The visible window was still the stock Agent-Native workspace, with no Code app entry; workspace app inventory requests returned 401. The development app was stopped and its newly created test profile moved to Trash. Desktop-to-host and Desktop-to-Code UI acceptance remain open.

Both copied checkouts had incomplete Git object stores and hundreds of missing baseline files. Local object alternates now point to the original repositories, and only tracked files marked deleted were restored. The VZN Code work remains isolated from the original checkouts.

These results distinguish source/build validation from deployment and two-device acceptance. No production deployment or device ownership transfer was performed.

### Private Gitea Mac pilot

Gitea 28.3.0 was installed through Homebrew and started as a user LaunchAgent with a pinned binary path. Its SQLite data, configuration, SSH host keys, and secrets live in a private local directory outside synchronized folders. HTTP and built-in SSH listen on loopback only; Tailscale Serve exposes separate private HTTPS and TCP endpoints without Funnel. Public registration and anonymous API access are disabled. The LaunchAgent restarted the server after termination, and both private endpoints remained reachable. The automation account is non-admin with a token scoped to repository and user API operations. The local configuration and token files have mode 0600, and the state directory has mode 0700. The tested release, configuration digest, host-key fingerprint, repository IDs, and command results are retained in the private compatibility record on Studio; no token or private key is recorded in this repository.

Against that live instance, the adapter created two disposable private repositories and repeated enrollment with identical repository IDs. It refused to adopt an unrelated existing repository. It registered separate write and read-only keys for project A and a separate write key for B. A's write key could push an explicit `incoming/child/probe` ref, while A's read-only key could fetch but not push. A's key could not fetch B, and B's key could fetch B. A's key could not create a nested `handoff/task/probe` ref. After the Studio user created an accepted ref, A's key could not fast-forward, force-update, or delete it; the Studio user could not make a non-fast-forward force update. The accepted object ID remained unchanged. The adapter rejected A's key under B, revoked A's write key, confirmed a second revocation was safe, and observed the old key denied over a new SSH connection while A's other key still worked. The denial persisted after a Gitea restart; the host journal rejected cross-project reuse after reopening.

These are disposable Mac-only probes. The pilot did not test child HTTPS/API credentials, interrupted transfer reconciliation, a coordinated off-Studio backup and isolated restore, or a real child checkout. No checkpoint refs were sent to GitHub.

### Trusted-host Gitea integration

The host now loads an owner-controlled private `gitea.json` and token file on startup. Schema v2 durably records enrollment, protection, device-key, and revocation state. The owner-only IPC capability and CLI can enroll and inspect a repository, add a public deploy key, and revoke it; the browser gateway rejects these requests. An interrupted API-call test reopened the journal and recovered the same enrollment identity, key intent, and revocation fence. A second test rejected a shared configuration file before the host opened IPC.

An isolated copy of the durable host's version-1 journal migrated to version 2 and retained its registered project count. The test copy was removed afterward; the running durable host was not restarted or migrated during the preview sign-in wait.

An isolated host process connected to the private Gitea instance, enrolled a fourth disposable repository through the new CLI, and read back its protected binding. It added a device key, observed a successful pinned-SSH fetch, revoked the key, and observed the next fetch denied. After restarting that host process, enrollment returned the same repository ID and stale key enrollment failed with `DEVICE_KEY_CONFLICT`. The durable Studio host remains on its current configuration until the preview task finishes; this test did not enable live checkout or checkpoint transfer.

## Results

| Area                             | Actual result                                                                                    | Scope of proof                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework dependency baseline    | Pinned pnpm 10.29.1 frozen installation passed in the stable checkout                            | Existing external dependency resolutions preserved; one uncached tarball required network access for the fresh checkout                                               |
| Core prerequisite packages       | Built agentkit, recap-cli, shared-app-config, toolkit, core and code-agents-ui                   | Local generated exports available                                                                                                                                     |
| Fork concurrency compatibility   | 136 tests passed; core typecheck and full build passed                                           | Public config/CLI/env behavior restored on upstream implementation                                                                                                    |
| Desktop identity                 | Earlier 66 tests and 22 focused Desktop tests passed; typecheck and `build:vzn` passed           | Isolated VZN profile, embedded Code workflow, same-session sign-in, host connection, and completed read-only task were observed                                       |
| Host                             | 18 passed on Mac; no skipped tests; disposable LaunchAgent restart passed                        | SQLite transactions, durable grants and provisioning intents, retry/cancel races, event replay, live private IPC, and launchd restart                                  |
| Runtime adapter                  | 6 real-subprocess tests passed; typecheck passed                                                 | Owned process cancellation, session linkage, transcript replay, orphan uncertainty, failed-exit recovery and credential-gap retry                                     |
| Existing upstream runtime        | Actual built CLI fixture and one read-only Codex CLI task completed                              | Existing Mac owner sign-in completed one real provider request; browser and second-device provider flow remain open                                                   |
| Gitea API adapter                | 20 tests passed; strict typecheck passed; live Mac pilot passed selected gates                   | Private repository enrollment, key isolation/revocation, and protected-ref enforcement on Gitea 28.3.0; backup, transfer, and second-device proof remain open         |
| Checkpoint capture and transport | 18 real-Git tests passed; strict typecheck passed                                                | Staged/unstaged/untracked/binary/mode/symlink fidelity, source preservation, immutable refs, bare-remote transfer, retry, origin protection and URL-rewrite isolation |
| Browser gateway                  | 4 tests passed on Mac; typecheck passed; both LaunchAgents crash-restarted                       | Real HTTP origin/authentication/mutation rejection and authenticated host reads through local and preview gateways                                                    |
| Web app                          | 11 tests passed; app typecheck and production compilation passed; local browser task flow passed | Isolated PGlite with default development auto-login; connection, task start, transcript, reconnect, and cancellation verified against a disposable local host         |
| Workspace doctor                 | 1,049 existing findings, zero assigned to new Code app                                           | Existing workspace health is not represented as a clean doctor pass                                                                                                   |
| Preview gateway                  | 14 tests passed, including 4 real TCP HTTP/WebSocket cases; typecheck passed                     | Authentication, cookies/headers, bidirectional WebSocket buffers and live revocation proved locally; host registration, ingress and physical-device proof remain open |

The earlier cloud run produced **41 passing tests and 3 Unix-socket-dependent failures**, with zero skips. Those three tests now pass on Mac. The earlier 284 focused passing tests are not a claim that the full upstream monorepo suite passed.

All six new private packages pass their normal package `typecheck` scripts with the pinned root dependencies. Final frozen offline installation succeeds without changing existing external dependency resolutions.

The browser screenshot is saved in the sibling workspace at `docs/evidence/code-disconnected-preview.png`. It deliberately shows the tested connection-error state, not a simulated successful Studio connection.

### PR review continuation

The owner token is now entered only on the gateway's `/connect` page. Enrollment issues an HttpOnly session cookie; browser RPC requires that cookie and the exact configured Code origin. The embedded Mac browser sent `Origin: null` for its top-level sign-in form, so enrollment accepts that form origin only with the owner token. RPC never accepts an opaque origin. The isolated Mac browser signed in, connected, started a read-only fixture task, and displayed its completed transcript. It restored the same run after navigating to Settings and after a full page reload. Windows and physical remote-browser checks were deferred at the user's request.

## Review findings repaired

1. **Process ownership after reconnect:** a native transcript can say completed before its process exits. Restarted adapters now require a durable association terminal result written after the owning process-close event. An unconfirmed process remains uncertain and keeps its execution fence.
2. **Rejected start locking a workspace:** invalid prompts and unavailable CLI preflight no longer reserve execution. Definitively unlaunched failures are distinguished from ambiguous launch failures.
3. **Failed tasks locking a workspace:** a confirmed failed process exit is a terminal error and can be retried with a new run identity; it does not imply successful task completion.
4. **Credential-gap exit locking a workspace:** a paused native record with a credential-gap transcript is retryable only after the adapter records the process close; restart reconciles the previous uncertain run using that durable result.
5. **Competing roots:** one workspace per project is enforced until isolated worktree execution is integrated, preventing two workspace IDs from writing the same registered project root.
6. **Capability mismatch:** browser task-control capabilities are advertised only when the gateway and host both permit them. A read-only gateway rejects task-control negotiation.
7. **Checkpoint origin aliases:** temporary-bare-remote tests caught `/var` versus `/private/var` aliases; canonical destination checks protect the normal origin.

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

The branded desktop has not been launched as an installed application, signed or notarized. The development window opened, but its current identity change does not replace every upstream icon, UI label, workspace path or native browser-host registration. Windows protected host transport and native runtime execution are explicitly unavailable rather than using an insecure fallback.

## Next acceptance gate

Verify login-after-reboot and reconnect after a gateway restart. Enable the tested Gitea integration on the durable host and complete a coordinated backup. Physical-device access and provider execution from the remote preview browser remain separate gates before handoff and environment milestones.
