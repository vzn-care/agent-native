# VZN Code implementation

This is an implementation branch of the Agent-Native coding workspace plan. It contains a branded Electron build, an independent local host, a browser gateway, a runtime adapter, Gitea provisioning, and checkpoint transfer components. It is **not yet a daily-use, two-device release**.

## Checkouts and baseline

- Framework: this repository, branch `codex/vzn-code-foundation`, based on upstream Desktop `v0.1.293` / `c0215ef5ee74192c56ae8f66f5e44bacbf2e55f7` (core 0.226.0).
- Web workspace: sibling `vzn-code-workspace`, based on `vzn-care/vzn-native-team` main `bf37ffb46b4fa0660789131ad5512ff881e07b29` (core 0.208.0). The new app uses the versioned host protocol and does not pretend these package versions are identical.
- The original `/Users/chris/dev/VZN-Dev/vzn-native-team` checkout and its staged deployment documents were preserved.
- Native host development uses Node 26 because its journal uses built-in SQLite. The upstream framework still declares its own lower Node minimum. Pin Node 26 for this combined checkout.
- Framework package manager: pnpm 10.29.1. Web workspace package manager: its pinned pnpm 10.14.0.

See [baseline.md](baseline.md) for reconciliation of the fork's existing build-concurrency customization.

## Components

| Component        | Location                               | Implemented behavior                                                                                                |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Electron desktop | `packages/desktop-app`                 | Separate VZN app ID, URL scheme, profile, build configuration, and disabled upstream updater                        |
| Host             | `packages/vzn-code-host`               | Private Unix IPC, SQLite ownership and operations journal, project catalog, task controller, event replay           |
| Runtime          | `packages/vzn-code-runtime`            | Existing Agent-Native CLI execution, process-group cancellation, native session association, transcript replay      |
| Browser gateway  | `packages/vzn-code-gateway`            | Loopback HTTP bridge, exact browser origin and authority checks, owner bearer authentication, optional task control |
| Web app          | sibling `vzn-code-workspace/apps/code` | Studio connection, projects/workspaces, task controls and transcript; capability-gated unavailable states           |
| Gitea            | `packages/vzn-code-gitea`              | Idempotent private repo enrollment, deploy-key identity binding, revocation API, checkpoint protection readback     |
| Checkpoints      | `packages/vzn-code-workspace`          | Separate index/worktree/untracked layers, digest verification, isolated restore, explicit immutable-ref transport   |
| Preview          | `packages/vzn-code-preview`            | Separate-origin private HTTP/WebSocket routing component; integration gate remains open                             |

## Development commands

Run these from the framework root with Node 26 and the pinned pnpm. These are development commands, not a system-service installation.

```sh
pnpm install --frozen-lockfile
pnpm --filter @agent-native/desktop-app typecheck
pnpm --filter @agent-native/desktop-app build:vzn
```

When installation scripts are intentionally disabled, explicitly build the workspace prerequisites before the desktop:

```sh
pnpm --filter @agent-native/agentkit --filter @agent-native/recap-cli --filter @agent-native/shared-app-config --filter @agent-native/toolkit --filter @agent-native/core --filter @agent-native/code-agents-ui run build
```

Start the host in its own terminal. The runtime executable must be an absolute path to the existing Agent-Native CLI. Omitting it leaves execution unavailable.

```sh
node packages/vzn-code-host/src/cli.ts serve --state-dir /tmp/vzn-code-host --runtime-executable "$PWD/packages/core/bin/agent-native.js"
```

Register an explicitly chosen project from another terminal; no browser can enroll arbitrary filesystem roots:

```sh
node packages/vzn-code-host/src/cli.ts register-project pilot /absolute/path/to/pilot gitea-pilot --state-dir /tmp/vzn-code-host
```

Use a durable private state directory for a real pilot. `/tmp` is only a reproducible development example and must not hold an outstanding device checkout.

The browser bridge needs a locally generated, private owner-token file. It never prints that token. Generate a 32-byte base64url token with a local credential-management workflow, store it as a file owned by the current user with mode 0600, and give its path to the gateway:

```sh
node packages/vzn-code-gateway/src/cli.ts /tmp/vzn-code-host /absolute/private/owner-token http://localhost:PORT 45840 - allow-task-control
```

Replace `PORT` with the actual web gateway origin (no path or trailing slash). The final argument explicitly enables task-control RPCs; omit it for a read-only gateway. The Code app accepts the token into memory only and clears it when disconnected. This is a single-owner development enrollment flow, not completed multi-device identity management.

For another physical device, use an approved private HTTPS tunnel such as Tailscale Serve, preserve the configured public Host header, and configure that HTTPS origin as the gateway's fifth argument. The gateway itself always binds to 127.0.0.1. No public exposure or Tailscale configuration was performed by this implementation.

The web workspace has its own app build and setup instructions. Set the framework's documented `DO_NOT_TRACK=1` and `AGENT_NATIVE_TELEMETRY_DISABLED=1` when building this private product. Its real development UI was launched with an isolated PGlite database and the framework's normal development auto-login; no authentication-disable flag was needed. Production authentication and persistent database configuration remain deployment requirements.

## Verification and release gates

See [verification.md](verification.md) for the actual checks and their outcomes. A successful bundle is not proof of a running two-device system.

The earlier cloud session denied local Unix socket listeners (`listen EPERM`). Those tests now pass on Mac, and a disposable browser-to-host task completed through the real Code app. See [verification.md](verification.md) for the local run, reconnect, and cancellation results.

The actual built upstream CLI has been exercised through its explicit fixture engine without a paid provider call. Native provider authentication, approvals, steering, and provider-specific continuation still require live acceptance testing. A transcript is not migrated hidden model state. Restarted unknown processes retain uncertain ownership until their termination can be established.

## Remaining plan scope

The implementation supplies substantial source for C01–C12 and C17, with working local component tests. The milestone acceptance gates are still incomplete. In particular:

1. Connect the branded desktop and browser to the same Studio host; install the included Mac LaunchAgent in a durable checkout, verify login-after-reboot, and establish real authenticated device enrollment. A disposable LaunchAgent passed install, health, crash restart, and uninstall checks on Studio. The new web app currently uses a small custom task interface; integration of the shared CodeAgentsApp surface remains open.
2. Run the host/gateway integrations with Unix socket access and a second physical device. The local web UI and HTTP/WebSocket preview component have been exercised separately. Preview registration must still be wired to durable workspace ownership and private HTTPS ingress.
3. Install and pin Gitea privately on Studio; prove real SSH key isolation and protected immutable refs. API readback and a temporary bare Git repository do not establish Gitea server enforcement.
4. Implement native/Dev Container environment recipes and readiness, then the complete **Run here**, **Work here**, and **Return to Studio** transactions and conflict review.
5. Finish Windows secure named pipes, process ownership, filesystem compatibility, and installer validation. Current host/runtime reject unsupported Windows execution.
6. Add Codex App Server integration, provider continuation, child-browser control, coordinated backup/restore, retention, update draining, signed installers, and the fault-injection/two-device pilot suite.

No production deployment, Gitea installation, provider credential migration, signed release, or automatic device handoff has been completed or claimed.
