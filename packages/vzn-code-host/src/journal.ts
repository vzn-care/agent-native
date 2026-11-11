import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { HostError, identifier } from "./protocol.ts";

export type Project = { id: string; root: string; repository: string };
export type Workspace = {
  id: string;
  projectId: string;
  owner: string;
  epoch: number;
};
export type RunState =
  | "launch-intent"
  | "running"
  | "uncertain"
  | "completed"
  | "cancelled"
  | "errored";
export type Run = {
  id: string;
  workspaceId: string;
  sessionId: string;
  deviceId: string;
  epoch: number;
  state: RunState;
  cancelRequested: number;
  nativeId: string | null;
};
export type SessionEvent = {
  cursor: number;
  sessionId: string;
  sourceDevice: string;
  segmentId: string;
  sequence: number;
  type: string;
  payload: unknown;
};
export type RuntimeAdapter = {
  /** Must reconcile a stable run identity, never infer identity from a PID alone. */
  inspect(
    run: Run,
  ): Promise<"running" | "completed" | "cancelled" | "errored" | "unknown">;
  cancel(run: Run): Promise<void>;
};

export class Journal {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
    );
    const version = this.db.prepare("PRAGMA user_version").get();
    if (version?.user_version !== 0 && version?.user_version !== 1) {
      this.db.close();
      throw new HostError(
        "INCOMPATIBLE_JOURNAL",
        "Journal schema is newer than this host",
      );
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, repository TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), owner TEXT NOT NULL, epoch INTEGER NOT NULL CHECK(epoch > 0));
      CREATE UNIQUE INDEX IF NOT EXISTS one_workspace_per_project ON workspaces(project_id);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), source TEXT NOT NULL, target TEXT NOT NULL, epoch INTEGER NOT NULL, released INTEGER NOT NULL DEFAULT 0, UNIQUE(workspace_id, epoch));
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), session_id TEXT NOT NULL, device_id TEXT NOT NULL, epoch INTEGER NOT NULL, state TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0, native_id TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(workspace_id) WHERE state IN ('launch-intent', 'running', 'uncertain');
      CREATE TABLE IF NOT EXISTS events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source_device TEXT NOT NULL, segment_id TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(source_device, segment_id, sequence));
      CREATE INDEX IF NOT EXISTS session_event_cursor ON events(session_id, cursor);
      CREATE TABLE IF NOT EXISTS key_identities (public_key TEXT PRIMARY KEY, instance_id TEXT NOT NULL, project_id TEXT NOT NULL, device_id TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
  }
  claimKeyIdentity(identity: {
    instanceId: string;
    projectId: string;
    deviceId: string;
    publicKey: string;
  }): boolean {
    return this.transaction(() => {
      const previous = this.db
        .prepare(
          "SELECT instance_id, project_id, device_id FROM key_identities WHERE public_key = ?",
        )
        .get(identity.publicKey);
      if (previous)
        return (
          previous.instance_id === identity.instanceId &&
          previous.project_id === identity.projectId &&
          previous.device_id === identity.deviceId
        );
      this.db
        .prepare("INSERT INTO key_identities VALUES (?, ?, ?, ?)")
        .run(
          identity.publicKey,
          identity.instanceId,
          identity.projectId,
          identity.deviceId,
        );
      return true;
    });
  }
  close(): void {
    this.db.close();
  }
  transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  operation<T>(id: string, input: unknown, apply: () => T): T {
    identifier(id, "operationId");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    return this.transaction(() => {
      const previous = this.db
        .prepare("SELECT fingerprint, result FROM operations WHERE id = ?")
        .get(id);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new HostError(
            "OPERATION_CONFLICT",
            "Operation key was already used with different input",
          );
        return JSON.parse(String(previous.result)) as T;
      }
      const result = apply();
      this.db
        .prepare("INSERT INTO operations VALUES (?, ?, ?)")
        .run(id, fingerprint, JSON.stringify(result));
      return result;
    });
  }
  registerProject(operationId: string, project: Project): Project {
    return this.operation(
      operationId,
      ["register-project", project.id, project.root, project.repository],
      () => {
        const old = this.db
          .prepare(
            "SELECT id, root, repository FROM projects WHERE id = ? OR root = ?",
          )
          .get(project.id, project.root);
        if (
          old &&
          (old.id !== project.id ||
            old.root !== project.root ||
            old.repository !== project.repository)
        )
          throw new HostError(
            "PROJECT_CONFLICT",
            "Project ID or root is already registered differently",
          );
        this.db
          .prepare("INSERT OR IGNORE INTO projects VALUES (?, ?, ?)")
          .run(project.id, project.root, project.repository);
        return project;
      },
    );
  }
  listProjects(): Project[] {
    const rows = this.db
      .prepare(
        "SELECT id, root, repository FROM projects ORDER BY id LIMIT 1001",
      )
      .all();
    if (rows.length > 1000)
      throw new HostError(
        "CATALOG_LIMIT",
        "Project catalog requires pagination beyond 1000 projects",
      );
    return rows.map((row) => ({ ...row }) as Project);
  }

  createWorkspace(
    operationId: string,
    id: string,
    projectId: string,
    owner: string,
  ): Workspace {
    return this.operation(
      operationId,
      ["create-workspace", id, projectId, owner],
      () => {
        if (
          this.db
            .prepare("SELECT id FROM workspaces WHERE project_id = ?")
            .get(projectId)
        )
          throw new HostError(
            "PROJECT_WORKSPACE_EXISTS",
            "Project already has a workspace; isolated worktrees are not implemented",
          );
        this.db
          .prepare("INSERT INTO workspaces VALUES (?, ?, ?, 1)")
          .run(id, projectId, owner);
        return this.workspace(id);
      },
    );
  }
  project(id: string): Project {
    const row = this.db
      .prepare("SELECT id, root, repository FROM projects WHERE id = ?")
      .get(id);
    if (!row) throw new HostError("NOT_FOUND", "Project does not exist");
    return { ...row } as Project;
  }
  listWorkspaces(projectId: string): Workspace[] {
    return this.db
      .prepare(
        "SELECT id, project_id AS projectId, owner, epoch FROM workspaces WHERE project_id = ? ORDER BY id LIMIT 1000",
      )
      .all(projectId)
      .map((row) => ({ ...row }) as Workspace);
  }
  workspace(id: string): Workspace {
    const row = this.db
      .prepare(
        "SELECT id, project_id AS projectId, owner, epoch FROM workspaces WHERE id = ?",
      )
      .get(id);
    if (!row) throw new HostError("NOT_FOUND", "Workspace does not exist");
    return { ...row } as Workspace;
  }
  assertOwner(id: string, owner: string, epoch: number): Workspace {
    const workspace = this.workspace(id);
    if (workspace.owner !== owner || workspace.epoch !== epoch)
      throw new HostError(
        "STALE_OWNERSHIP",
        "Workspace owner or epoch does not match",
      );
    if (epoch >= Number.MAX_SAFE_INTEGER)
      throw new HostError(
        "EPOCH_EXHAUSTED",
        "Ownership epoch cannot be incremented safely",
      );
    return workspace;
  }
  private assertIdle(id: string): void {
    if (
      this.db
        .prepare(
          "SELECT id FROM runs WHERE workspace_id = ? AND state IN ('launch-intent', 'running', 'uncertain') LIMIT 1",
        )
        .get(id)
    )
      throw new HostError(
        "WORKSPACE_BUSY",
        "Active or uncertain execution must be reconciled first",
      );
  }
  /** Coordinator primitive only. Caller must verify preparation before issuing a grant. */
  grant(
    operationId: string,
    workspaceId: string,
    source: string,
    target: string,
    epoch: number,
  ): Workspace {
    if (source === target)
      throw new HostError(
        "INVALID_TARGET",
        "Checkout target must differ from source",
      );
    return this.operation(
      operationId,
      ["grant", workspaceId, source, target, epoch],
      () => {
        this.assertOwner(workspaceId, source, epoch);
        this.assertIdle(workspaceId);
        if (
          this.db
            .prepare(
              "SELECT id FROM grants WHERE workspace_id = ? AND released = 0 LIMIT 1",
            )
            .get(workspaceId)
        )
          throw new HostError(
            "OUTSTANDING_GRANT",
            "Existing checkout must be released through verified return",
          );
        this.db
          .prepare(
            "UPDATE workspaces SET owner = ?, epoch = epoch + 1 WHERE id = ?",
          )
          .run(target, workspaceId);
        this.db
          .prepare(
            "INSERT INTO grants (id, workspace_id, source, target, epoch) VALUES (?, ?, ?, ?, ?)",
          )
          .run(operationId, workspaceId, source, target, epoch + 1);
        return this.workspace(workspaceId);
      },
    );
  }
  // No timeout or reclaim primitive: return requires verified import and child release.
  existingRunReservation(
    operationId: string,
    runId: string,
    workspaceId: string,
    sessionId: string,
    deviceId: string,
    epoch: number,
    prompt = "",
    permissionMode = "read-only",
  ): Run | undefined {
    const previous = this.db
      .prepare("SELECT fingerprint, result FROM operations WHERE id = ?")
      .get(operationId);
    if (!previous) return undefined;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          "reserve-run",
          runId,
          workspaceId,
          sessionId,
          deviceId,
          epoch,
          prompt,
          permissionMode,
        ]),
      )
      .digest("hex");
    if (previous.fingerprint !== fingerprint)
      throw new HostError(
        "OPERATION_CONFLICT",
        "Operation key was already used with different input",
      );
    const stored = JSON.parse(String(previous.result)) as Run;
    return this.run(stored.id);
  }
  reserveRun(
    operationId: string,
    runId: string,
    workspaceId: string,
    sessionId: string,
    deviceId: string,
    epoch: number,
    prompt = "",
    permissionMode = "read-only",
  ): { run: Run; launchAllowed: boolean } {
    let launchAllowed = false;
    const reserved = this.operation(
      operationId,
      [
        "reserve-run",
        runId,
        workspaceId,
        sessionId,
        deviceId,
        epoch,
        prompt,
        permissionMode,
      ],
      () => {
        this.assertOwner(workspaceId, deviceId, epoch);
        this.assertIdle(workspaceId);
        this.db
          .prepare(
            "INSERT INTO runs (id, workspace_id, session_id, device_id, epoch, state) VALUES (?, ?, ?, ?, ?, 'launch-intent')",
          )
          .run(runId, workspaceId, sessionId, deviceId, epoch);
        launchAllowed = true;
        return this.run(runId);
      },
    );
    return { run: this.run(reserved.id), launchAllowed };
  }
  run(id: string): Run {
    const row = this.db
      .prepare(
        "SELECT id, workspace_id AS workspaceId, session_id AS sessionId, device_id AS deviceId, epoch, state, cancel_requested AS cancelRequested, native_id AS nativeId FROM runs WHERE id = ?",
      )
      .get(id);
    if (!row) throw new HostError("NOT_FOUND", "Run does not exist");
    return { ...row } as Run;
  }
  recordLaunch(id: string, nativeId: string): Run {
    return this.transaction(() => {
      const run = this.run(id);
      this.assertOwner(run.workspaceId, run.deviceId, run.epoch);
      if (run.state !== "launch-intent")
        throw new HostError(
          "LAUNCH_NOT_ALLOWED",
          "Launch is already recorded or requires reconciliation",
        );
      this.db
        .prepare(
          "UPDATE runs SET state = 'running', native_id = ? WHERE id = ?",
        )
        .run(nativeId, id);
      return this.run(id);
    });
  }
  setRunState(id: string, state: RunState): Run {
    this.db.prepare("UPDATE runs SET state = ? WHERE id = ?").run(state, id);
    return this.run(id);
  }
  requestCancel(
    operationId: string,
    id: string,
    deviceId: string,
    epoch: number,
  ): Run {
    return this.operation(operationId, ["cancel", id, deviceId, epoch], () => {
      const run = this.run(id);
      this.assertOwner(run.workspaceId, deviceId, epoch);
      this.db
        .prepare("UPDATE runs SET cancel_requested = 1 WHERE id = ?")
        .run(id);
      return this.run(id);
    });
  }
  activeRuns(): Run[] {
    const rows = this.db
      .prepare(
        "SELECT id FROM runs WHERE state IN ('launch-intent', 'running', 'uncertain') ORDER BY id LIMIT 1001",
      )
      .all();
    if (rows.length > 1000)
      throw new HostError(
        "ACTIVE_RUN_LIMIT",
        "More than 1000 active runs require explicit recovery pagination",
      );
    return rows.map((row) => this.run(String(row.id)));
  }

  async reconcile(adapter?: RuntimeAdapter): Promise<Run[]> {
    const rows = this.db
      .prepare(
        "SELECT id FROM runs WHERE state IN ('launch-intent', 'running', 'uncertain') ORDER BY id",
      )
      .all();
    const result: Run[] = [];
    for (const row of rows) {
      const run = this.run(String(row.id));
      let state: RunState = "uncertain";
      if (adapter) {
        try {
          const inspected = await adapter.inspect(run);
          if (inspected !== "unknown") state = inspected;
          if (run.cancelRequested && state === "running") {
            await adapter.cancel(run);
            const after = await adapter.inspect(run);
            state = after === "unknown" ? "uncertain" : after;
          }
        } catch {
          state = "uncertain";
        }
      }
      this.db
        .prepare("UPDATE runs SET state = ? WHERE id = ?")
        .run(state, run.id);
      result.push(this.run(run.id));
    }
    return result;
  }
  appendEvent(event: Omit<SessionEvent, "cursor">): SessionEvent {
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1)
      throw new HostError(
        "INVALID_EVENT",
        "Sequence must be a positive safe integer",
      );
    const payload = JSON.stringify(event.payload);
    if (payload === undefined || Buffer.byteLength(payload) > 8192)
      throw new HostError(
        "INVALID_EVENT",
        "Event metadata exceeds 8 KiB; store artifact bytes separately",
      );
    return this.transaction(() => {
      const existing = this.db
        .prepare(
          "SELECT cursor, session_id AS sessionId, type, payload FROM events WHERE source_device = ? AND segment_id = ? AND sequence = ?",
        )
        .get(event.sourceDevice, event.segmentId, event.sequence);
      if (existing) {
        if (
          existing.sessionId !== event.sessionId ||
          existing.type !== event.type ||
          existing.payload !== payload
        )
          throw new HostError(
            "EVENT_CONFLICT",
            "Source event identity has different content",
          );
        return { ...event, cursor: Number(existing.cursor) };
      }
      const latest = this.db
        .prepare(
          "SELECT sequence, session_id AS sessionId FROM events WHERE source_device = ? AND segment_id = ? ORDER BY sequence DESC LIMIT 1",
        )
        .get(event.sourceDevice, event.segmentId);
      if (latest && latest.sessionId !== event.sessionId)
        throw new HostError(
          "EVENT_CONFLICT",
          "Execution segment belongs to another session",
        );
      const expected =
        latest?.sequence == null ? 1 : Number(latest.sequence) + 1;
      if (event.sequence !== expected)
        throw new HostError(
          "EVENT_GAP",
          `Expected source sequence ${expected}`,
        );
      const inserted = this.db
        .prepare(
          "INSERT INTO events (session_id, source_device, segment_id, sequence, type, payload) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          event.sessionId,
          event.sourceDevice,
          event.segmentId,
          event.sequence,
          event.type,
          payload,
        );
      return { ...event, cursor: Number(inserted.lastInsertRowid) };
    });
  }
  events(sessionId: string, after: number, limit: number): SessionEvent[] {
    return this.db
      .prepare(
        "SELECT cursor, session_id AS sessionId, source_device AS sourceDevice, segment_id AS segmentId, sequence, type, payload FROM events WHERE session_id = ? AND cursor > ? ORDER BY cursor LIMIT ?",
      )
      .all(sessionId, after, limit)
      .map(
        (row) =>
          ({
            ...row,
            payload: JSON.parse(String(row.payload)),
          }) as SessionEvent,
      );
  }
}
