import { realpathSync } from "node:fs";

import type {
  AgentNativeRuntime,
  RuntimeEvent,
} from "../../vzn-code-runtime/src/index.ts";
import type { HostGitea } from "./gitea.ts";
import { Journal } from "./journal.ts";
import type { Run } from "./journal.ts";
import { CAPABILITIES, HostError, identifier } from "./protocol.ts";
import type { Request } from "./protocol.ts";

export type HostRuntime = Pick<
  AgentNativeRuntime,
  "start" | "inspect" | "cancel" | "transcript" | "readiness"
>;
export type HostOptions = {
  runtime?: HostRuntime;
  deviceId?: string;
  gitea?: HostGitea;
};
export class HostController {
  readonly journal: Journal;
  readonly deviceId: string;
  readonly runtime: HostRuntime | undefined;
  readonly gitea: HostGitea | undefined;
  private active = new Set<Promise<void>>();
  private persistenceFailure = false;
  private starting = new Set<Promise<unknown>>();
  private launchRequests = new Set<Promise<unknown>>();
  private stopping = false;
  constructor(journal: Journal, options: HostOptions = {}) {
    this.journal = journal;
    this.deviceId = identifier(options.deviceId ?? "studio", "deviceId");
    this.runtime = options.runtime;
    this.gitea = options.gitea;
  }
  get capabilities(): string[] {
    return [
      ...CAPABILITIES,
      ...(this.runtime ? ["task-control"] : []),
      ...(this.gitea ? ["repository-provisioning"] : []),
    ];
  }
  async reconcile(): Promise<void> {
    const runs = this.journal.activeRuns();
    await this.journal.reconcile(this.runtime);
    if (this.runtime) {
      for (const run of runs) {
        try {
          this.runtime
            .transcript(run)
            .forEach((event, index) =>
              this.appendRuntimeEvent(run, event, index + 1),
            );
        } catch {
          this.journal.setRunState(run.id, "uncertain");
        }
      }
    }
  }
  private appendRuntimeEvent(
    run: Run,
    event: RuntimeEvent,
    sequence: number,
  ): void {
    this.journal.appendEvent({
      sessionId: run.sessionId,
      sourceDevice: run.deviceId,
      segmentId: run.id,
      sequence,
      type: "runtime-event",
      payload: {
        nativeEventId: event.id,
        nativeSessionId: event.nativeSessionId,
        kind: event.kind,
        createdAt: event.createdAt,
      },
    });
  }
  private requireRuntime(): HostRuntime {
    if (!this.runtime)
      throw new HostError(
        "RUNTIME_UNAVAILABLE",
        "Select an installed Agent-Native CLI to enable task execution",
      );
    return this.runtime;
  }
  async dispatch(
    request: Exclude<Request, { kind: "hello" | "register-project" }>,
  ): Promise<unknown> {
    switch (request.kind) {
      case "health":
        return {
          status: this.persistenceFailure ? "degraded" : "ready",
          protocolVersion: 1,
          schemaVersion: 2,
          pid: process.pid,
          deviceId: this.deviceId,
          executionAvailable: Boolean(this.runtime),
          providerAuthentication: "unverified",
          transport: "unix-socket",
        };
      case "list-projects":
        return { projects: this.journal.listProjects() };
      case "repository-status":
        return this.journal.repositoryIntent(request.projectId) ?? null;
      case "enroll-repository":
        if (!this.gitea)
          throw new HostError(
            "GITEA_UNAVAILABLE",
            "Private Git is not configured",
          );
        return this.gitea.enrollProject(request.projectId);
      case "ensure-deploy-key":
        if (!this.gitea)
          throw new HostError(
            "GITEA_UNAVAILABLE",
            "Private Git is not configured",
          );
        return this.gitea.ensureDeviceKey(request);
      case "revoke-deploy-key":
        if (!this.gitea)
          throw new HostError(
            "GITEA_UNAVAILABLE",
            "Private Git is not configured",
          );
        await this.gitea.revokeDeviceKey(request.projectId, request.deviceId);
        return this.journal.deployKeyIntent(
          request.projectId,
          request.deviceId,
        );
      case "create-workspace":
        return this.journal.createWorkspace(
          request.operationId,
          request.workspaceId,
          request.projectId,
          this.deviceId,
        );
      case "list-workspaces":
        return { workspaces: this.journal.listWorkspaces(request.projectId) };
      case "session-events": {
        const events = this.journal.events(
          request.sessionId,
          request.after,
          request.limit,
        );
        return { events, nextCursor: events.at(-1)?.cursor ?? request.after };
      }
      case "run-status":
        return this.journal.run(request.runId);
      case "run-transcript": {
        const run = this.journal.run(request.runId);
        return { events: this.requireRuntime().transcript(run) };
      }
      case "start-run": {
        if (this.stopping || this.persistenceFailure)
          throw new HostError(
            "HOST_NOT_READY",
            "Host is stopping or requires journal recovery",
          );
        const launched = this.start(request);
        this.launchRequests.add(launched);
        void launched.then(
          () => {
            this.launchRequests.delete(launched);
          },
          () => {
            this.launchRequests.delete(launched);
          },
        );
        return launched;
      }
      case "cancel-run": {
        const runtime = this.requireRuntime();
        try {
          this.journal.run(request.runId);
        } catch (error) {
          if (!(error instanceof HostError && error.code === "NOT_FOUND"))
            throw error;
          await Promise.allSettled(this.launchRequests);
        }
        const run = this.journal.requestCancel(
          request.operationId,
          request.runId,
          this.deviceId,
          request.expectedEpoch,
        );
        if (
          run.state === "completed" ||
          run.state === "cancelled" ||
          run.state === "errored"
        )
          return run;
        try {
          await Promise.allSettled(this.starting);
          await runtime.cancel(this.journal.run(run.id));
          const state = await runtime.inspect(run);
          return this.journal.setRunState(
            run.id,
            state === "unknown" ? "uncertain" : state,
          );
        } catch {
          this.journal.setRunState(run.id, "uncertain");
          throw new HostError(
            "CANCELLATION_UNCERTAIN",
            "Cancellation is recorded but process termination could not be verified",
          );
        }
      }
    }
  }
  private async start(
    request: Extract<Request, { kind: "start-run" }>,
  ): Promise<Run> {
    const runtime = this.requireRuntime();
    if (!request.prompt.trim())
      throw new HostError(
        "INVALID_PROMPT",
        "Prompt must contain non-whitespace text",
      );
    const prior = this.journal.existingRunReservation(
      request.operationId,
      request.runId,
      request.workspaceId,
      request.sessionId,
      this.deviceId,
      request.expectedEpoch,
      request.prompt,
      request.permissionMode ?? "read-only",
    );
    if (prior) return prior;
    const workspace = this.journal.workspace(request.workspaceId);
    const project = this.journal.project(workspace.projectId);
    if (realpathSync(project.root) !== project.root)
      throw new HostError(
        "ROOT_CHANGED",
        "Registered project root has changed",
      );
    this.journal.assertOwner(
      workspace.id,
      this.deviceId,
      request.expectedEpoch,
    );
    const readiness = await runtime.readiness(project.root);
    if (!readiness.available)
      throw new HostError(
        "CLI_UNAVAILABLE",
        "Installed CLI did not pass readiness; no run was reserved or launched",
      );
    const reserved = this.journal.reserveRun(
      request.operationId,
      request.runId,
      workspace.id,
      request.sessionId,
      this.deviceId,
      request.expectedEpoch,
      request.prompt,
      request.permissionMode ?? "read-only",
    );
    if (!reserved.launchAllowed) return reserved.run;
    let sequence = 0;
    const append = (event: RuntimeEvent) => {
      sequence += 1;
      this.appendRuntimeEvent(reserved.run, event, sequence);
    };
    try {
      const starting = runtime.start(
        {
          id: request.runId,
          sessionId: request.sessionId,
          workspaceRoot: project.root,
          prompt: request.prompt,
          permissionMode: request.permissionMode ?? "read-only",
        },
        { onEvent: append },
      );
      this.starting.add(starting);
      let started: Awaited<typeof starting>;
      try {
        started = await starting;
      } finally {
        this.starting.delete(starting);
      }
      const run = this.journal.recordLaunch(request.runId, started.nativeId);
      const completion = started.completion.then(
        (result) => {
          const state =
            result.state === "completed" ||
            result.state === "cancelled" ||
            result.state === "errored"
              ? result.state
              : "uncertain";
          this.journal.setRunState(request.runId, state);
        },
        () => {
          this.journal.setRunState(request.runId, "uncertain");
        },
      );
      this.active.add(completion);
      void completion.then(
        () => {
          this.active.delete(completion);
        },
        () => {
          this.persistenceFailure = true;
          this.active.delete(completion);
        },
      );
      return run;
    } catch (error) {
      const noLaunch =
        error instanceof Error &&
        "code" in error &&
        [
          "CLI_UNAVAILABLE",
          "INVALID_PROMPT",
          "INVALID_PERMISSION_MODE",
          "INVALID_WORKSPACE",
        ].includes(String(error.code));
      this.journal.setRunState(
        request.runId,
        noLaunch ? "errored" : "uncertain",
      );
      if (noLaunch)
        throw new HostError(
          "LAUNCH_REJECTED",
          "No task was launched; correct the runtime setup before starting a new operation",
        );
      throw new HostError(
        "LAUNCH_UNCERTAIN",
        "Launch did not complete successfully; reconciliation is required before any retry",
      );
    }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled(this.launchRequests);
    await Promise.allSettled(this.starting);
    if (this.runtime) {
      const runs = this.journal.activeRuns();
      for (const run of runs) {
        try {
          await this.runtime.cancel(run);
        } catch {
          this.journal.setRunState(run.id, "uncertain");
        }
      }
    }
    await Promise.allSettled(this.active);
    if (this.persistenceFailure)
      throw new HostError(
        "JOURNAL_WRITE_FAILED",
        "Run completion could not be persisted; reconcile before resuming",
      );
  }
}
