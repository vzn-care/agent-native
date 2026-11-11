# Existing coding runtime bridge

`@vzn-care/code-runtime` supervises the pinned Agent-Native CLI. It does not implement a model loop, a provider client, or a credential store. The host is responsible for authorizing workspace ownership and committing launch intent before calling `start`.

## Launch contract

```ts
import { AgentNativeRuntime } from "../../packages/vzn-code-runtime/src/index.ts";

const runtime = new AgentNativeRuntime({
  stateDirectory: "/absolute/private/vzn/runtime",
  executable: "/absolute/path/to/agent-native",
});

const readiness = await runtime.readiness("/absolute/workspace");
// readiness.provider is always "unverified": --help does not authenticate.
const run = await runtime.start({
  id: "host-run-id",
  sessionId: "logical-session-id",
  workspaceRoot: "/absolute/workspace",
  prompt: "Explain the repository structure",
  permissionMode: "read-only",
});
const result = await run.completion;
```

For the source checkout, configure the Node executable with `prefixArgs: ["/absolute/repository/packages/core/bin/agent-native.js"]`. The upstream launcher resolves its existing `tsx` source fallback or built CLI. Workspace dependencies must be installed; the bridge does not install or download them.

The exact argv is `code exec --permission-mode read-only -- <prompt>`; `full-auto` is the only other exposed mode. The prompt remains one argument, including quotes, shell syntax, or leading hyphens. The process uses the canonical explicit workspace as `cwd`, no shell, and ignored stdin. Permission modes constrain upstream tools; they are not an OS sandbox. The bridge deliberately does not expose upstream `ask-before-edit`, because the pinned executor permits writes in that mode.

## Session and event ownership

Before spawn, the bridge writes and fsyncs a private association record under `<stateDirectory>/<hostRunId>/association.json`. It contains host run ID, logical session ID, canonical workspace, state, and subsequently the upstream session ID. An existing run directory blocks another launch, including after a crash. The host's returned `nativeId` is this stable association ID, not a PID.

Each invocation gets a dedicated `AGENT_NATIVE_CODE_AGENTS_HOME` under that association. The upstream CLI creates its normal `runs/<nativeId>.json` and `transcripts/<nativeId>.jsonl`. The bridge discovers exactly one native session and validates its schema, workspace, filename, and identity before translating transcript events. The event includes both native and host identities. A restarted bridge can replay the native transcript; the host owns durable cursors and deduplication when importing those events.

A zero process exit does not establish successful execution. Completion requires a native `completed` record. Native errors, pending approvals, missing final records, and malformed transcripts remain distinct outcomes. Records are limited to 8 MiB each; exceeding that bound fails explicitly instead of silently truncating history. Raw stdout and stderr are drained, never copied into host events. Provider errors recorded by upstream remain available in the native transcript.

## Cancellation and recovery

Cancellation signals only a process group created by the current bridge instance, first with SIGTERM and then SIGKILL after two seconds. Terminal cancellation is recorded after child closure. A durably recorded `errored` result after child closure is a known terminal failure: it releases execution ownership without claiming task success, and cancellation becomes a no-op. A new run may retry the task with a new host run ID. The bridge never reconstructs kill authority from a stored PID. After host restart, an association without a terminal result persisted by the owning process close handler returns `unknown`, even if the native record already says `completed`, and cancellation returns `CANCELLATION_UNCERTAIN`; the host must retain its uncertain state and block duplicate execution or ownership transfer.

Automatic resume is not implemented. Existing transcript replay and native CLI continuation are separate capabilities. An operator can use the existing `agent-native code resume <nativeId> "follow-up"` with the association's `AGENT_NATIVE_CODE_AGENTS_HOME` and workspace after independently reconciling execution ownership. The bridge does not automatically issue that command or import another machine's provider session.

## Provider readiness

Readiness launches the existing CLI's `code --help` with a bounded output buffer and ten-second timeout. It reports `CLI_READY_PROVIDER_UNVERIFIED` or `CLI_UNAVAILABLE`. No provider credentials are read, printed, copied, or validated by the bridge. The runner inherits the environment and existing upstream authentication behavior. Readiness makes no paid model request and must not be displayed as authenticated provider readiness.

The pinned source establishes these integration points:

- `packages/core/src/cli/code.ts`: `runTask` creates the native run, writes the initial transcript, and invokes `executeCodeAgentRun`; `parseTaskArgs` supports the `--` prompt delimiter.
- `packages/core/src/cli/code-agent-runs.ts`: `AGENT_NATIVE_CODE_AGENTS_HOME`, schema version 1 run records, and JSONL transcripts.
- `packages/core/src/cli/code-agent-executor.ts`: existing provider resolution, coding tools, execution loop, native CLI engines, and permission semantics.
- `packages/desktop-app/src/main/code-agent-runner-entry.ts`: a separate desktop internal runner entry that is deliberately not imported by this package.

## Verification

Run `node --test packages/vzn-code-runtime/test/*.test.ts`. Tests spawn a real fixture executable and verify literal argv, explicit workspace, translated transcript events, durable session replay, duplicate-launch rejection, cancellation, restart uncertainty (including a still-live process with a native completed record), nonzero exit, and missing executable behavior. They do not demonstrate authentication or model output from a real provider.

Verified against the pinned checkout after dependency installation and upstream prebuild:

- `node --import tsx packages/core/src/cli/index.ts code --help` completed successfully. The ordinary source launcher uses a tsx IPC socket that is blocked in the restricted test environment; the import loader avoids that extra socket.
- The bridge launched the actual built `packages/core/dist/cli/index.js`, with `AGENT_ENGINE=anthropic` and upstream's explicit `AGENT_NATIVE_CODE_AGENT_FAKE_RESPONSE` test engine. Readiness succeeded, the native run completed with exit 0, and all five native transcript events were translated and replayed. This verifies integration with the existing runtime using a fixture response, not provider authentication or real model output.
- Strict TypeScript checking and the subprocess contract tests passed. No real-provider execution or paid model request has been performed.
