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

| Component        | Location                               | Implemented behavior                                                                                                                    |
| ---------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Electron desktop | `packages/desktop-app`                 | Separate VZN app ID, URL scheme, profile, build configuration, and disabled upstream updater                                            |
| Host             | `packages/vzn-code-host`               | Private Unix IPC, SQLite ownership and operations journal, project catalog, task controller, event replay                               |
| Runtime          | `packages/vzn-code-runtime`            | Existing Agent-Native CLI execution, process-group cancellation, native session association, transcript replay                          |
| Browser gateway  | `packages/vzn-code-gateway`            | Loopback HTTP bridge, exact RPC origin and authority checks, owner-token enrollment with HttpOnly session cookie, optional task control |
| Web app          | sibling `vzn-code-workspace/apps/code` | Studio connection, projects/workspaces, task controls and transcript; capability-gated unavailable states                               |
| Gitea            | `packages/vzn-code-gitea`              | Idempotent private repo enrollment, deploy-key identity binding, revocation API, checkpoint protection readback                         |
| Checkpoints      | `packages/vzn-code-workspace`          | Separate index/worktree/untracked layers, digest verification, isolated restore, explicit immutable-ref transport                       |
| Preview          | `packages/vzn-code-preview`            | Separate-origin private HTTP/WebSocket routing component; integration gate remains open                                                 |

## Development commands

Run these from the framework root with Node 26 and the pinned pnpm. These are development commands, not a system-service installation.

```sh
pnpm install --frozen-lockfile
pnpm --filter @agent-native/desktop-app typecheck
pnpm --filter @agent-native/desktop-app build:vzn
```

For the branded Desktop development build, set `VZN_CODE_APP_URL` to the full Code page URL before the first launch, for example `http://127.0.0.1:8417/code/home` for the local workspace or an exact HTTPS preview URL. The VZN Code entry is then saved in the separate VZN Code Desktop profile. Existing profiles retain their saved URL; change it in Desktop app settings when switching between local and preview. The entry uses the web app's own sign-in and Studio gateway connection. Its Studio sign-in link opens a restricted Desktop window sharing the Code webview's cookie session; a sign-in completed in Chrome cannot authorize that separate session.

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

Replace `PORT` with the actual web gateway origin (no path or trailing slash). The browser-origin argument accepts a comma-separated list of **exact** origins, for example `http://127.0.0.1:8417,https://code-preview.example`. Do not use a wildcard or a shared Vercel suffix; add each preview deployment origin explicitly. The final argument explicitly enables task-control RPCs; omit it for a read-only gateway. The owner opens the gateway's `/connect` page and enters the token there. The gateway issues a private HttpOnly browser session; the Code app never handles the owner token. This is a single-owner development enrollment flow, not completed multi-device identity management.

An HTTPS preview page must connect to a private HTTPS gateway origin, such as a Tailscale Serve address, configured as the fifth CLI argument. Keep the gateway listener on `127.0.0.1`, retain exact browser-origin checks, and use Tailscale Serve rather than Funnel. The preview browser may request local-network access before it can reach a tailnet address; grant it only for the trusted preview origin. The remote gateway cookie uses `Secure; SameSite=None`, so browser third-party-cookie policy must be verified in the intended browser. A local Code page may continue using a separate loopback gateway and cookie. Browser connection state is scoped to each Code page origin.

For another physical device, use an approved private HTTPS tunnel such as Tailscale Serve, preserve the configured public Host header, and configure that HTTPS origin as the gateway's fifth argument. The gateway itself always binds to 127.0.0.1. The Mac pilot uses private Tailscale Serve ingress; a second physical device has not been checked.

### macOS login startup

From a checkout that will remain at the same absolute path, install the host and each gateway as a user LaunchAgent. Stop a manually started process on the same port before installing its gateway agent. The installer checks ownership and mode of the token file, writes an owned 0600 plist, and does not put the token value in the plist or logs.

```sh
node packages/vzn-code-host/src/launchd-cli.ts install --state-dir "$HOME/.vzn-code-host" --runtime-executable "$PWD/packages/core/bin/agent-native.js" --agent-engine codex-cli
node packages/vzn-code-gateway/src/launchd-cli.ts install local "$HOME/.vzn-code-host" "$HOME/.vzn-code-host/owner-token" http://127.0.0.1:8417 45840 - allow-task-control
node packages/vzn-code-gateway/src/launchd-cli.ts install preview "$HOME/.vzn-code-host" "$HOME/.vzn-code-host/owner-token" https://code-preview.example 45841 https://studio.example:45841 allow-task-control

node packages/vzn-code-host/src/launchd-cli.ts status
node packages/vzn-code-gateway/src/launchd-cli.ts status local
node packages/vzn-code-gateway/src/launchd-cli.ts status preview
```

Replace the example preview and private gateway origins with exact HTTPS origins. Multiple preview origins can be comma-separated in the third argument after the token file. The preview gateway still requires a separate private HTTPS ingress; LaunchAgent installation never enables Tailscale Serve or Funnel. Gateway restarts clear in-memory browser sessions, so sign in again on its `/connect` page after a restart. `uninstall <local|preview>` removes only that gateway's LaunchAgent, not the token, host journal, or private ingress configuration. Reinstall after moving the checkout or changing the Node binary.

The optional `--agent-engine codex-cli` uses the Mac owner's existing Codex CLI sign-in without putting credentials in the plist. Verify `codex login status` locally before enabling it. Omit this option to use the CLI's normal provider selection; it may require a provider key through the deployment's secret manager. A terminated missing-credential run is recorded as a retryable error.

The web workspace has its own app build and setup instructions. Set the framework's documented `DO_NOT_TRACK=1` and `AGENT_NATIVE_TELEMETRY_DISABLED=1` when building this private product. Its real development UI was launched with an isolated PGlite database and the framework's normal development auto-login; no authentication-disable flag was needed. Production authentication and persistent database configuration remain deployment requirements.

## Verification and release gates

See [verification.md](verification.md) for the actual checks and their outcomes. A successful bundle is not proof of a running two-device system.

The earlier cloud session denied local Unix socket listeners (`listen EPERM`). Those tests now pass on Mac, and a disposable browser-to-host task completed through the real Code app. See [verification.md](verification.md) for the local run, reconnect, and cancellation results.

The actual built upstream CLI has completed an explicit fixture run, one live read-only host task, and one read-only task initiated in the branded Desktop's embedded Code page using the Mac owner's existing Codex CLI sign-in. Remote-preview provider execution, approvals, steering, and provider-specific continuation still require live acceptance testing. A transcript is not migrated hidden model state. Restarted unknown processes retain uncertain ownership until their termination can be established.

## Remaining plan scope

The implementation supplies substantial source for C01–C12 and C17, with working local component tests. The milestone acceptance gates are still incomplete. In particular:

1. Verify login-after-reboot and establish real authenticated device enrollment. The branded Desktop's Code entry connected to the same Studio host and completed a read-only task. The host and both gateways are installed as Mac LaunchAgents in a durable checkout, and all three passed health and crash restart checks. The new web app currently uses a small custom task interface; integration of the shared CodeAgentsApp surface remains open.
2. Run the host/gateway integrations with Unix socket access and a second physical device. The local web UI and HTTP/WebSocket preview component have been exercised separately. Preview registration must still be wired to durable workspace ownership and private HTTPS ingress.
3. Integrate the privately installed Gitea service with the trusted host, then complete the remaining live handoff gates. The Mac pilot proved repository key isolation, revocation, and protected-ref enforcement on Gitea 28.3.0. Backup/restore, host-managed enrollment intent, and a real ownership transfer remain open.
4. Implement native/Dev Container environment recipes and readiness, then the complete **Run here**, **Work here**, and **Return to Studio** transactions and conflict review.
5. Finish Windows secure named pipes, process ownership, filesystem compatibility, and installer validation. Current host/runtime reject unsupported Windows execution.
6. Add Codex App Server integration, provider continuation, child-browser control, coordinated backup/restore, retention, update draining, signed installers, and the fault-injection/two-device pilot suite.

No production deployment, provider credential migration, signed release, or automatic device handoff has been completed or claimed.
