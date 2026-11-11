import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

export type PermissionMode = "read-only" | "full-auto";
export type RuntimeResult = {
  state: "completed" | "cancelled" | "errored" | "paused" | "unknown";
  nativeSessionId: string | null;
  exitCode: number | null;
  reason?: string;
};
export type RuntimeEvent = {
  id: string;
  runId: string;
  sessionId: string;
  nativeSessionId: string;
  kind: "user" | "system" | "note" | "artifact" | "status";
  message: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
  signal?: "credential-gap";
};
export type RuntimeReference = { id: string; nativeId?: string | null };
export type StartInput = {
  id: string;
  sessionId: string;
  workspaceRoot: string;
  prompt: string;
  permissionMode?: PermissionMode;
};
export type RuntimeOptions = {
  stateDirectory: string;
  executable: string;
  prefixArgs?: string[];
};
type Association = {
  version: 1;
  id: string;
  sessionId: string;
  workspaceRoot: string;
  nativeSessionId: string | null;
  state: "launch-intent" | "running" | RuntimeResult["state"];
  result?: RuntimeResult;
};
type LiveRun = {
  child: ChildProcess;
  cancelled: boolean;
  completion: Promise<RuntimeResult>;
  killTimer?: ReturnType<typeof setTimeout>;
};
type NativeRecord = { id: string; cwd: string; status: string };
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export class RuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function identifier(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value))
    throw new RuntimeError("INVALID_ID", "Runtime identity is invalid");
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RuntimeError("INVALID_RECORD", "Runtime record is not an object");
  return value as Record<string, unknown>;
}
function readBounded(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES)
    throw new RuntimeError(
      "UNSAFE_RECORD",
      "Runtime record is not a bounded regular file",
    );
  return readFileSync(path, "utf8");
}
function privateDirectory(path: string): string {
  if (!isAbsolute(path))
    throw new RuntimeError(
      "INVALID_DIRECTORY",
      "Runtime state directory must be absolute",
    );
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.()
  )
    throw new RuntimeError(
      "UNSAFE_DIRECTORY",
      "Runtime state directory must be owned by this user",
    );
  chmodSync(path, 0o700);
  return realpathSync(path);
}

/** Owns CLI process lifetime; the host journal owns execution authority and event delivery. */
export class AgentNativeRuntime {
  readonly capabilities = {
    execution: true,
    cancellation: "owned-process-group",
    transcriptReplay: true,
    automaticResume: false,
    nativeContinuation: "manual-cli",
    providerAuthentication: "existing-cli-only",
  } as const;
  readonly stateDirectory: string;
  private readonly options: RuntimeOptions;
  private readonly live = new Map<string, LiveRun>();
  constructor(options: RuntimeOptions) {
    if (process.platform === "win32")
      throw new RuntimeError(
        "UNSUPPORTED_PLATFORM",
        "Runtime process-group ownership requires macOS or Linux",
      );
    if (!isAbsolute(options.executable))
      throw new RuntimeError(
        "INVALID_EXECUTABLE",
        "Configure an absolute Agent-Native executable path",
      );
    this.options = { ...options, prefixArgs: [...(options.prefixArgs ?? [])] };
    this.stateDirectory = privateDirectory(options.stateDirectory);
  }
  async readiness(workspaceRoot: string): Promise<{
    available: boolean;
    provider: "unverified";
    code: string;
    capabilities: AgentNativeRuntime["capabilities"];
  }> {
    this.workspace(workspaceRoot);
    const available = await new Promise<boolean>((resolve) => {
      const child = this.spawn(["code", "--help"], workspaceRoot);
      let output = "";
      let overflow = false;
      child.stdout?.on("data", (chunk: Buffer) => {
        if (output.length + chunk.length > 64 * 1024) {
          overflow = true;
          this.signal(child, "SIGKILL");
        } else output += chunk.toString("utf8");
      });
      child.stderr?.resume();
      const timeout = setTimeout(() => this.signal(child, "SIGKILL"), 10_000);
      child.once("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolve(
          code === 0 &&
            !overflow &&
            output.includes("agent-native code") &&
            output.includes("--permission-mode"),
        );
      });
    });
    return {
      available,
      provider: "unverified",
      code: available ? "CLI_READY_PROVIDER_UNVERIFIED" : "CLI_UNAVAILABLE",
      capabilities: this.capabilities,
    };
  }
  async start(
    input: StartInput,
    options: { onEvent?: (event: RuntimeEvent) => void } = {},
  ): Promise<{ nativeId: string; completion: Promise<RuntimeResult> }> {
    identifier(input.id);
    identifier(input.sessionId);
    const workspaceRoot = this.workspace(input.workspaceRoot);
    if (
      !input.prompt.trim() ||
      input.prompt.length > 100_000 ||
      input.prompt.includes("\0")
    )
      throw new RuntimeError(
        "INVALID_PROMPT",
        "Prompt must contain between 1 and 100000 characters without NUL bytes",
      );
    if (
      input.permissionMode !== undefined &&
      input.permissionMode !== "read-only" &&
      input.permissionMode !== "full-auto"
    )
      throw new RuntimeError(
        "INVALID_PERMISSION_MODE",
        "Only read-only and full-auto modes are exposed by this bridge",
      );
    if (existsSync(this.directory(input.id)))
      throw new RuntimeError(
        "RUN_ALREADY_RESERVED",
        "This run already has durable launch intent; reconcile it instead of launching again",
      );
    if (!(await this.readiness(workspaceRoot)).available)
      throw new RuntimeError(
        "CLI_UNAVAILABLE",
        "Agent-Native code help probe failed; install or configure the existing CLI",
      );
    mkdirSync(this.directory(input.id), { mode: 0o700 });
    const stateDirectoryHandle = openSync(this.stateDirectory, "r");
    try {
      fsyncSync(stateDirectoryHandle);
    } finally {
      closeSync(stateDirectoryHandle);
    }
    const association: Association = {
      version: 1,
      id: input.id,
      sessionId: input.sessionId,
      workspaceRoot,
      nativeSessionId: null,
      state: "launch-intent",
    };
    this.write(association);
    const child = this.spawn(
      [
        "code",
        "exec",
        "--permission-mode",
        input.permissionMode ?? "read-only",
        "--",
        input.prompt,
      ],
      workspaceRoot,
      this.store(input.id),
    );
    child.stdout?.resume();
    child.stderr?.resume();
    let failure: string | undefined;
    let delivered = 0;
    const sync = (final = false) => {
      try {
        const current = this.discover(association);
        if (current) {
          association.nativeSessionId = current.id;
          this.write(association);
          const events = this.transcript({ id: input.id }, final);
          for (const event of events.slice(delivered)) {
            options.onEvent?.(event);
            delivered += 1;
          }
        }
      } catch (error) {
        failure =
          error instanceof RuntimeError ? error.code : "TRANSCRIPT_READ_FAILED";
        this.signal(child, "SIGKILL");
      }
    };
    const timer = setInterval(sync, 100);
    const completion = new Promise<RuntimeResult>((resolve) => {
      child.once("error", () => {
        failure = "SPAWN_FAILED";
      });
      child.once("spawn", () => {
        association.state = "running";
        try {
          this.write(association);
        } catch {
          failure = "ASSOCIATION_WRITE_FAILED";
          this.signal(child, "SIGKILL");
        }
      });
      child.once("close", (exitCode) => {
        clearInterval(timer);
        const live = this.live.get(input.id);
        if (live?.killTimer) clearTimeout(live.killTimer);
        if (live?.cancelled) this.signal(child, "SIGKILL");
        sync(true);
        let native: NativeRecord | null = null;
        try {
          native = this.discover(association);
        } catch {
          failure = "NATIVE_RECORD_INVALID";
        }
        const state: RuntimeResult["state"] = failure
          ? "errored"
          : live?.cancelled
            ? "cancelled"
            : exitCode !== 0
              ? "errored"
              : native?.status === "completed"
                ? "completed"
                : native?.status === "errored"
                  ? "errored"
                  : native?.status === "paused" ||
                      native?.status === "needs-approval"
                    ? "paused"
                    : "unknown";
        const result: RuntimeResult = {
          state,
          nativeSessionId: association.nativeSessionId,
          exitCode,
          ...(failure ? { reason: failure } : {}),
        };
        association.state = state;
        association.result = result;
        try {
          this.write(association);
        } catch {
          result.state = "unknown";
          result.reason = "ASSOCIATION_WRITE_FAILED";
        }
        this.live.delete(input.id);
        resolve(result);
      });
    });
    this.live.set(input.id, { child, cancelled: false, completion });
    return { nativeId: input.id, completion };
  }
  async inspect(
    reference: RuntimeReference,
  ): Promise<"running" | "completed" | "cancelled" | "errored" | "unknown"> {
    const association = this.read(reference);
    if (this.live.has(reference.id)) return "running";
    if (
      association.state === "completed" ||
      association.state === "cancelled" ||
      association.state === "errored"
    )
      return association.state;
    // A native status update can precede process exit; only our close handler proves termination.
    return "unknown";
  }
  async cancel(reference: RuntimeReference): Promise<void> {
    const association = this.read(reference);
    const live = this.live.get(reference.id);
    if (!live) {
      if (
        association.state === "completed" ||
        association.state === "cancelled" ||
        association.state === "errored"
      )
        return;
      throw new RuntimeError(
        "CANCELLATION_UNCERTAIN",
        "This process does not own the runner; reconcile manually before retrying or transferring ownership",
      );
    }
    live.cancelled = true;
    this.signal(live.child, "SIGTERM");
    live.killTimer ??= setTimeout(
      () => this.signal(live.child, "SIGKILL"),
      2000,
    );
    await live.completion;
  }
  transcript(reference: RuntimeReference, final = false): RuntimeEvent[] {
    const association = this.read(reference);
    const native = this.discover(association);
    if (!native) return [];
    const path = join(
      this.store(reference.id),
      "transcripts",
      `${native.id}.jsonl`,
    );
    if (!existsSync(path)) return [];
    const text = readBounded(path);
    const lines = text.split("\n");
    const tail = lines.pop();
    if (tail && final)
      throw new RuntimeError(
        "TRUNCATED_TRANSCRIPT",
        "The native transcript ended with a partial event",
      );
    return lines
      .filter((line) => line.length > 0)
      .map((line) => {
        const event = object(JSON.parse(line));
        if (
          event.schemaVersion !== 1 ||
          typeof event.id !== "string" ||
          event.runId !== native.id ||
          typeof event.message !== "string" ||
          typeof event.createdAt !== "string" ||
          !["user", "system", "note", "artifact", "status"].includes(
            String(event.kind),
          )
        )
          throw new RuntimeError(
            "INVALID_TRANSCRIPT",
            "Native transcript schema or session identity does not match",
          );
        return {
          id: event.id,
          runId: reference.id,
          sessionId: association.sessionId,
          nativeSessionId: native.id,
          kind: event.kind as RuntimeEvent["kind"],
          message: event.message,
          createdAt: event.createdAt,
          ...(event.metadata ? { metadata: object(event.metadata) } : {}),
          ...(event.signal === "credential-gap"
            ? { signal: "credential-gap" as const }
            : {}),
        };
      });
  }
  private workspace(root: string): string {
    if (!isAbsolute(root) || !statSync(root).isDirectory())
      throw new RuntimeError(
        "INVALID_WORKSPACE",
        "Workspace must be an existing absolute directory",
      );
    return realpathSync(root);
  }
  private directory(id: string): string {
    return join(this.stateDirectory, identifier(id));
  }
  private store(id: string): string {
    return join(this.directory(id), "native");
  }
  private write(association: Association): void {
    const path = join(this.directory(association.id), "association.json");
    const file = openSync(`${path}.tmp`, "w", 0o600);
    try {
      writeFileSync(file, JSON.stringify(association) + "\n");
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(`${path}.tmp`, path);
    const directory = openSync(this.directory(association.id), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  private read(reference: RuntimeReference): Association {
    if (reference.nativeId && reference.nativeId !== reference.id)
      throw new RuntimeError(
        "IDENTITY_MISMATCH",
        "Runtime association does not match the host run",
      );
    const data = object(
      JSON.parse(
        readBounded(join(this.directory(reference.id), "association.json")),
      ),
    );
    if (
      data.version !== 1 ||
      data.id !== reference.id ||
      typeof data.sessionId !== "string" ||
      typeof data.workspaceRoot !== "string" ||
      (data.nativeSessionId !== null &&
        typeof data.nativeSessionId !== "string")
    )
      throw new RuntimeError(
        "INVALID_ASSOCIATION",
        "Runtime association has an invalid schema",
      );
    return data as Association;
  }
  private discover(association: Association): NativeRecord | null {
    const directory = join(this.store(association.id), "runs");
    if (!existsSync(directory)) return null;
    const files = readdirSync(directory).filter((name) =>
      name.endsWith(".json"),
    );
    if (!files.length) return null;
    if (files.length !== 1)
      throw new RuntimeError(
        "AMBIGUOUS_NATIVE_SESSION",
        "Dedicated runtime store contains multiple sessions",
      );
    const file = files[0];
    if (file === undefined)
      throw new RuntimeError(
        "MISSING_NATIVE_RECORD",
        "Native session filename is missing",
      );
    const record = object(JSON.parse(readBounded(join(directory, file))));
    if (
      record.schemaVersion !== 1 ||
      typeof record.id !== "string" ||
      typeof record.status !== "string" ||
      record.cwd !== association.workspaceRoot ||
      file !== `${identifier(record.id)}.json` ||
      (association.nativeSessionId !== null &&
        record.id !== association.nativeSessionId)
    )
      throw new RuntimeError(
        "NATIVE_IDENTITY_MISMATCH",
        "Native run identity or workspace does not match its host association",
      );
    return {
      id: record.id,
      cwd: association.workspaceRoot,
      status: record.status,
    };
  }
  private spawn(args: string[], cwd: string, store?: string): ChildProcess {
    return spawn(
      this.options.executable,
      [...(this.options.prefixArgs ?? []), ...args],
      {
        cwd,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...(store ? { AGENT_NATIVE_CODE_AGENTS_HOME: store } : {}),
        },
      },
    );
  }
  private signal(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ESRCH")
      )
        throw error;
    }
  }
}
