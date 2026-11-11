import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { AgentNativeRuntime } from "../../vzn-code-runtime/src/index.ts";
import { HostController } from "../src/controller.ts";
import { Journal } from "../src/journal.ts";

function setup() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "vzn-control-")));
  const options = {
    stateDirectory: join(directory, "runtime"),
    executable: process.execPath,
    prefixArgs: [
      fileURLToPath(
        new URL("../../vzn-code-runtime/test/fake-cli.ts", import.meta.url),
      ),
    ],
  };
  const journal = new Journal(join(directory, "journal.sqlite"));
  journal.registerProject("register", {
    id: "project",
    root: directory,
    repository: "example.invalid/project",
  });
  const runtime = new AgentNativeRuntime(options);
  const controller = new HostController(journal, { runtime });
  return { directory, options, journal, controller };
}
const envelope = { protocolVersion: 1, requestId: "request" } as const;
const start = {
  ...envelope,
  kind: "start-run",
  operationId: "launch",
  runId: "run",
  workspaceId: "workspace",
  sessionId: "session",
  expectedEpoch: 1,
  prompt: "Inspect project",
} as const;

test("controller starts existing CLI once, replays events after restart, and prohibits aliased project workspaces", async () => {
  const f = setup();
  try {
    await f.controller.dispatch({
      ...envelope,
      kind: "create-workspace",
      operationId: "create",
      workspaceId: "workspace",
      projectId: "project",
    });
    await assert.rejects(
      f.controller.dispatch({
        ...envelope,
        kind: "create-workspace",
        operationId: "alias",
        workspaceId: "alias",
        projectId: "project",
      }),
      { code: "PROJECT_WORKSPACE_EXISTS" },
    );
    await Promise.all([
      f.controller.dispatch(start),
      f.controller.dispatch(start),
    ]);
    await assert.rejects(
      f.controller.dispatch({ ...start, prompt: "different" }),
      { code: "OPERATION_CONFLICT" },
    );
    const deadline = Date.now() + 5000;
    while (f.journal.run("run").state === "running" && Date.now() < deadline)
      await setTimeout(20);
    assert.equal(f.journal.run("run").state, "completed");
    assert.equal(f.journal.events("session", 0, 20).length, 1);
    await f.controller.stop();
    f.journal.close();
    f.journal = new Journal(join(f.directory, "journal.sqlite"));
    f.controller = new HostController(f.journal, {
      runtime: new AgentNativeRuntime(f.options),
    });
    await f.controller.reconcile();
    const replay = (await f.controller.dispatch({
      ...envelope,
      kind: "run-transcript",
      runId: "run",
    })) as { events: { message: string }[] };
    assert.equal(replay.events[0]?.message, "Recorded response");
    assert.equal(
      ((await f.controller.dispatch(start)) as { state: string }).state,
      "completed",
    );
    assert.equal(f.journal.events("session", 0, 20).length, 1);
  } finally {
    await f.controller.stop();
    f.journal.close();
    rmSync(f.directory, { recursive: true });
  }
});

test("cancellation racing initial CLI readiness stays durable and terminates the owned run", async () => {
  const f = setup();
  try {
    f.journal.createWorkspace("create", "workspace", "project", "studio");
    const starting = f.controller.dispatch({ ...start, prompt: "wait" });
    const cancelling = f.controller.dispatch({
      ...envelope,
      kind: "cancel-run",
      operationId: "cancel",
      runId: "run",
      expectedEpoch: 1,
    });
    await starting;
    await cancelling;
    assert.equal(f.journal.run("run").state, "cancelled");
    assert.equal(f.journal.run("run").cancelRequested, 1);
    assert.equal(
      (
        (await f.controller.dispatch({ ...start, prompt: "wait" })) as {
          state: string;
        }
      ).state,
      "cancelled",
    );
  } finally {
    await f.controller.stop();
    f.journal.close();
    rmSync(f.directory, { recursive: true });
  }
});

test("missing native association after launch reservation stays uncertain without blocking host reconciliation", async () => {
  const f = setup();
  try {
    f.journal.createWorkspace("create", "workspace", "project", "studio");
    f.journal.reserveRun(
      "launch",
      "run",
      "workspace",
      "session",
      "studio",
      1,
      "Inspect project",
    );
    await f.controller.reconcile();
    assert.equal(f.journal.run("run").state, "uncertain");
    assert.equal(
      ((await f.controller.dispatch(start)) as { state: string }).state,
      "uncertain",
    );
  } finally {
    await f.controller.stop();
    f.journal.close();
    rmSync(f.directory, { recursive: true });
  }
});

test("SSH key identity cannot be reused for a different project or device after restart", () => {
  const f = setup();
  const key = {
    instanceId: "instance",
    projectId: "project",
    deviceId: "child",
    publicKey: "ssh-ed25519 deliberately-fake-public-key",
  };
  try {
    assert.equal(f.journal.claimKeyIdentity(key), true);
    f.journal.close();
    f.journal = new Journal(join(f.directory, "journal.sqlite"));
    assert.equal(f.journal.claimKeyIdentity(key), true);
    assert.equal(
      f.journal.claimKeyIdentity({ ...key, projectId: "different" }),
      false,
    );
    assert.equal(
      f.journal.claimKeyIdentity({ ...key, deviceId: "different" }),
      false,
    );
  } finally {
    f.journal.close();
    rmSync(f.directory, { recursive: true });
  }
});

test("invalid prompt and unavailable CLI reserve no execution and corrected setup can retry", async () => {
  const f = setup();
  try {
    f.journal.createWorkspace("create", "workspace", "project", "studio");
    await assert.rejects(f.controller.dispatch({ ...start, prompt: "   " }), {
      code: "INVALID_PROMPT",
    });
    assert.throws(() => f.journal.run("run"), { code: "NOT_FOUND" });
    const missing = new HostController(f.journal, {
      runtime: new AgentNativeRuntime({
        stateDirectory: join(f.directory, "missing-runtime"),
        executable: join(f.directory, "absent-executable"),
      }),
    });
    await assert.rejects(missing.dispatch(start), { code: "CLI_UNAVAILABLE" });
    assert.throws(() => f.journal.run("run"), { code: "NOT_FOUND" });
    await f.controller.dispatch(start);
    const deadline = Date.now() + 5000;
    while (f.journal.run("run").state === "running" && Date.now() < deadline)
      await setTimeout(20);
    assert.equal(f.journal.run("run").state, "completed");
  } finally {
    await f.controller.stop();
    f.journal.close();
    rmSync(f.directory, { recursive: true });
  }
});

test("verified failed task permits a fresh run while permission mode remains bound to its operation", async () => {
  const f = setup();
  try {
    f.journal.createWorkspace("create", "workspace", "project", "studio");
    await f.controller.dispatch({
      ...start,
      prompt: "fail",
      permissionMode: "full-auto",
    });
    const deadline = Date.now() + 5000;
    while (f.journal.run("run").state === "running" && Date.now() < deadline)
      await setTimeout(20);
    assert.equal(f.journal.run("run").state, "errored");
    const invocation = JSON.parse(
      readFileSync(
        join(f.directory, "runtime", "run", "native", "arguments.json"),
        "utf8",
      ),
    ) as { args: string[] };
    assert.equal(invocation.args[3], "full-auto");
    await assert.rejects(
      f.controller.dispatch({
        ...start,
        prompt: "fail",
        permissionMode: "read-only",
      }),
      { code: "OPERATION_CONFLICT" },
    );
    await f.controller.dispatch({
      ...start,
      operationId: "retry",
      runId: "retry-run",
    });
    const retryDeadline = Date.now() + 5000;
    while (
      f.journal.run("retry-run").state === "running" &&
      Date.now() < retryDeadline
    )
      await setTimeout(20);
    assert.equal(f.journal.run("retry-run").state, "completed");
  } finally {
    await f.controller.stop();
    f.journal.close();
    rmSync(f.directory, { recursive: true });
  }
});

test("restart imports missed native transcript callbacks once before accepting new work", async () => {
  const f = setup();
  try {
    f.journal.createWorkspace("create", "workspace", "project", "studio");
    f.journal.reserveRun(
      "launch",
      "run",
      "workspace",
      "session",
      "studio",
      1,
      "Inspect project",
    );
    const runtime = new AgentNativeRuntime(f.options);
    const native = await runtime.start({
      id: "run",
      sessionId: "session",
      workspaceRoot: f.directory,
      prompt: "Inspect project",
    });
    f.journal.recordLaunch("run", native.nativeId);
    await native.completion;
    assert.deepEqual(f.journal.events("session", 0, 10), []);
    f.journal.close();
    f.journal = new Journal(join(f.directory, "journal.sqlite"));
    f.controller = new HostController(f.journal, {
      runtime: new AgentNativeRuntime(f.options),
    });
    await f.controller.reconcile();
    assert.equal(f.journal.run("run").state, "completed");
    assert.equal(f.journal.events("session", 0, 10).length, 1);
    await f.controller.reconcile();
    assert.equal(f.journal.events("session", 0, 10).length, 1);
  } finally {
    await f.controller.stop();
    f.journal.close();
    rmSync(f.directory, { recursive: true });
  }
});
