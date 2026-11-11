# VZN Code local host foundation

`packages/vzn-code-host` runs independently of Desktop. It uses Node 26, native
TypeScript execution, `node:sqlite`, and a private Unix socket. It never exposes
TCP, a general shell RPC, or an HTTP endpoint. The optional existing Agent-Native
CLI adapter remains responsible for provider execution; this package does not
implement another agent loop.

## Start and inspect

From the framework checkout:

```sh
node packages/vzn-code-host/src/cli.ts serve
node packages/vzn-code-host/src/cli.ts health
node packages/vzn-code-host/src/cli.ts register-project my-project /absolute/project/root repository-identity stable-registration-operation
node packages/vzn-code-host/src/cli.ts list-projects
```

The default state directory is `~/.vzn-code-host`. Every command accepts
`--state-dir /absolute/private/directory`; keep it short enough for a Unix socket
path (100 bytes maximum). State must live on a local disk, outside cloud-sync
folders. A user supervisor may launch `serve`; this package does not install a
launch agent or startup task. SIGTERM/SIGINT explicitly stop the host and request
cancellation of managed work. Closing a client connection does not stop work.

To opt into the existing CLI runtime:

```sh
node packages/vzn-code-host/src/cli.ts serve --runtime-executable /absolute/path/to/agent-native
```

The default has no task execution capability. Selecting an executable enables
the adapter contract; each launch verifies CLI readiness. Provider authentication
is explicitly unverified until a real task succeeds. Tasks default to the runtime's read-only permission mode. A caller may explicitly
select `full-auto` for files and commands. Verified terminated provider failures
are `errored`; paused approvals and unverified process states remain `uncertain`.

Windows deliberately returns `UNSUPPORTED_PLATFORM`: a protected named pipe and
Windows process-tree ownership are not implemented. An insecure default-DACL
pipe is not used as a fallback.

## IPC contract

Import `HostClient` from `@vzn-care/code-host/client` (or its `src/client.ts` in a
source checkout). Each connection begins with `hello`:

```ts
const client = new HostClient(socketPath);
await client.request({
  kind: "hello",
  capabilities: ["project-catalog", "session-event-replay"],
});
const health = await client.request({ kind: "health" });
client.close();
```

Wire messages are newline-delimited JSON with `{protocolVersion:1,requestId}`.
The client adds these fields, matches replies, and throws `HostError` with a
stable `code` on rejection. Request IDs, operation IDs, project/workspace/run/
session IDs allow 1–128 ASCII alphanumeric, underscore, or hyphen characters,
with an alphanumeric first character. Unknown versions, fields, kinds, or
capabilities fail closed. A request is at most 64 KiB; event pages are 1–500
records. Idle connections close; callers reconnect and negotiate again.

| Request kind       | Required capability    | Additional input                                                               | Result                                                                       |
| ------------------ | ---------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `hello`            | none                   | `capabilities:string[]`                                                        | Available/negotiated capabilities; execution and remote-control availability |
| `health`           | negotiated connection  | none                                                                           | Status, PID, schema/protocol version, device, runtime availability           |
| `register-project` | `project-catalog`      | `operationId,projectId,root,repository`                                        | `{id,root,repository}` with canonical existing root                          |
| `list-projects`    | `project-catalog`      | none                                                                           | `{projects}`                                                                 |
| `create-workspace` | `project-catalog`      | `operationId,workspaceId,projectId`                                            | `{id,projectId,owner,epoch}`                                                 |
| `list-workspaces`  | `project-catalog`      | `projectId`                                                                    | `{workspaces}`                                                               |
| `session-events`   | `session-event-replay` | `sessionId,after,limit`                                                        | `{events,nextCursor}`                                                        |
| `start-run`        | `task-control`         | `operationId,runId,workspaceId,sessionId,expectedEpoch,prompt,permissionMode?` | Durable run record                                                           |
| `cancel-run`       | `task-control`         | `operationId,runId,expectedEpoch`                                              | Run with cancellation requested and verified/uncertain outcome               |
| `run-status`       | `task-control`         | `runId`                                                                        | Durable run record                                                           |
| `run-transcript`   | `task-control`         | `runId`                                                                        | `{events}` from the native transcript                                        |

`task-control` exists only with an explicit runtime adapter. The health
`executionAvailable` field means that adapter is configured; it does not claim
provider authentication, permission to edit, or successful execution. The service
has one configured device identity (default `studio`), never a caller-supplied
actor. The socket's OS owner is the trust boundary. A browser must use the
separately authenticated gateway; it cannot connect directly to the socket.

A run record contains `id,workspaceId,sessionId,deviceId,epoch,state,
cancelRequested,nativeId`. State is `launch-intent`, `running`, `uncertain`,
`completed`, `cancelled`, or `errored`. A native ID is an adapter association identity, not
an assumption that provider sessions move between machines.

## Persistence and recovery invariants

- The directory is mode `0700`; socket and database files are `0600`. Symlink,
  hard-link, and wrong-owner state files are rejected. A separate SQLite
  `BEGIN EXCLUSIVE` lock prevents two service instances from owning one state
  directory. The OS releases that lock on process death; PID reuse is irrelevant.
- The journal uses WAL, `synchronous=FULL`, foreign keys, and immediate
  transactions. Schema versions newer than this host are rejected. The initial
  schema is additive; future versions require coordinated backup/migration.
- Project IDs and canonical roots are unique. Until isolated worktrees exist,
  one project may have only one workspace, so alternate workspace IDs cannot
  launch competing writers into the same root.
- Mutation operation IDs are durable and bind the full operation input. Same-key
  retries return the prior outcome; a different payload fails with
  `OPERATION_CONFLICT`. Run retries read current state and never receive another
  launch permit. Prompt and permission mode participate in the fingerprint, not plaintext SQL.
- A run reservation is committed before calling the runtime. Restart reconciles
  durable run identities before accepting requests. Missing native association,
  uncertain spawn, or orphan ownership becomes `uncertain`; no automatic retry,
  PID-only kill, writer transfer, or duplicated process is attempted.
- Empty prompts and unavailable CLI readiness fail before launch reservation.
  Definitive prelaunch rejections and verified terminated failures allow a new
  operation/run retry; ambiguous failures continue to fence the workspace.
- Cancellation intent is durable, including when it races CLI readiness. The
  host waits for initial launch registration before asking the owning adapter
  to cancel. Termination must be verified; a failed stop stays uncertain.
- Event cursors are globally ordered. Source-device/segment/sequence identities
  are unique; replay is idempotent, conflicting content and missing source
  sequences fail. Native transcript bytes stay in runtime files. Journal events
  contain native-event references; `run-transcript` retrieves the messages. Restart
  reconciliation imports missed native transcript callbacks with the same source
  sequence identities before serving requests.
- `Journal.grant()` is a coordinator primitive, not an exposed checkout RPC.
  It atomically increments the epoch and assigns the child before a response.
  Lost acknowledgements replay the same grant. An outstanding grant cannot be
  reclaimed by timeout or another grant. It remains outstanding after restart.
  Verified preparation, child activation, release receipts, return/import, and
  recovery-branch workflows are still required before exposing checkout.
- `claimKeyIdentity()` permanently binds a canonical SSH public key to one Gitea
  instance/project/device tuple. Identical claims succeed; reuse for another
  identity fails, including after restart. The Gitea adapter normalizes keys.

These are fail-safe reservation semantics, not a claim of exactly-once external
process side effects. A crash between spawn and durable acknowledgement requires
reconciliation and may require manual recovery. Backups must coordinate journal,
Gitea, native transcripts, and outstanding child grants; restoring an older
journal alone is not safe ownership recovery.

## Validation and remaining gates

```sh
node --test packages/vzn-code-host/test/*.test.ts
pnpm --filter @vzn-care/code-host typecheck
```

Tests exercise independent SQLite clients racing a grant, lost acknowledgements,
restart fencing, cancellation of a real child process, event replay/conflicts,
key reuse, the real runtime adapter against a test CLI, cancellation during CLI
readiness, and protocol validation. Separate socket and CLI subprocess tests
exercise the actual IPC boundary when local socket binding is allowed.

The current managed execution sandbox rejects Unix socket bind with `EPERM`.
Those transport tests remain enabled and fail visibly in this environment; they
must pass on the target Mac before claiming background-host acceptance. The
subprocess runtime fixture proves lifecycle wiring, not a real provider task.
Closing/reopening Desktop, launch-at-login/crash recovery under an OS supervisor,
real provider execution, cross-device controls, Windows, and verified
checkout/return remain separate acceptance gates.
