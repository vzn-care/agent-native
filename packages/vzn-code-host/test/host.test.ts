import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, statSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { HostClient } from "../src/client.ts";
import { Journal } from "../src/journal.ts";
import { HostLease } from "../src/lease.ts";
import { parseRequest } from "../src/protocol.ts";
import { startHost } from "../src/service.ts";

const fixture = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vzn-h-")));
  const path = join(dir, "journal.sqlite");
  const journal = new Journal(path);
  journal.registerProject("project-op", {
    id: "project",
    root: dir,
    repository: "example.invalid/project",
  });
  journal.createWorkspace("workspace-op", "workspace", "project", "studio");
  return { dir, path, journal };
};

test("lost grant acknowledgement replays the same owner and never reclaims on restart", () => {
  const f = fixture();
  try {
    assert.deepEqual(
      f.journal.grant("checkout-1", "workspace", "studio", "child-a", 1),
      { id: "workspace", projectId: "project", owner: "child-a", epoch: 2 },
    );
    f.journal.close();
    f.journal = new Journal(f.path);
    assert.equal(
      f.journal.grant("checkout-1", "workspace", "studio", "child-a", 1).epoch,
      2,
    );
    assert.throws(
      () => f.journal.grant("checkout-2", "workspace", "studio", "child-b", 1),
      { code: "STALE_OWNERSHIP" },
    );
    assert.throws(
      () => f.journal.grant("checkout-1", "workspace", "studio", "child-b", 1),
      { code: "OPERATION_CONFLICT" },
    );
    assert.throws(
      () => f.journal.grant("checkout-3", "workspace", "child-a", "studio", 2),
      { code: "OUTSTANDING_GRANT" },
    );
    assert.equal(f.journal.workspace("workspace").owner, "child-a");
  } finally {
    f.journal.close();
    rmSync(f.dir, { recursive: true });
  }
});

test("simultaneous independent SQLite clients grant only one writer", async () => {
  const f = fixture();
  try {
    const module = new URL("../src/journal.ts", import.meta.url).href;
    const run = (target: string) =>
      new Promise<{ code: number | null; output: string }>(
        (resolve, reject) => {
          const child = spawn(process.execPath, [
            "--input-type=module",
            "-e",
            `import {Journal} from ${JSON.stringify(module)};const j=new Journal(${JSON.stringify(f.path)});try{console.log(JSON.stringify(j.grant(${JSON.stringify(target)},'workspace','studio',${JSON.stringify(target)},1)))}catch(e){console.log(e.code);process.exitCode=1}finally{j.close()}`,
          ]);
          let output = "";
          child.stdout.on("data", (chunk) => {
            output += chunk;
          });
          child.on("error", reject);
          child.on("exit", (code) => resolve({ code, output }));
        },
      );
    const outcomes = await Promise.all([run("child-a"), run("child-b")]);
    assert.equal(outcomes.filter((o) => o.code === 0).length, 1);
    assert.equal(
      outcomes.filter((o) => o.output.includes("STALE_OWNERSHIP")).length,
      1,
    );
    assert.equal(f.journal.workspace("workspace").epoch, 2);
  } finally {
    f.journal.close();
    rmSync(f.dir, { recursive: true });
  }
});

test("durable launch intent cannot be used twice and uncertain restart blocks a replacement writer", async () => {
  const f = fixture();
  try {
    const args = [
      "launch-op",
      "run",
      "workspace",
      "session",
      "studio",
      1,
    ] as const;
    assert.equal(f.journal.reserveRun(...args).launchAllowed, true);
    assert.equal(f.journal.reserveRun(...args).launchAllowed, false);
    f.journal.close();
    f.journal = new Journal(f.path);
    await f.journal.reconcile();
    const retry = f.journal.reserveRun(...args);
    assert.equal(retry.launchAllowed, false);
    assert.equal(retry.run.state, "uncertain");
    assert.throws(
      () =>
        f.journal.reserveRun(
          "other-op",
          "other-run",
          "workspace",
          "session",
          "studio",
          1,
        ),
      { code: "WORKSPACE_BUSY" },
    );
    assert.throws(
      () => f.journal.grant("checkout", "workspace", "studio", "child", 1),
      { code: "WORKSPACE_BUSY" },
    );
    assert.throws(() => f.journal.recordLaunch("run", "native-run"), {
      code: "LAUNCH_NOT_ALLOWED",
    });
  } finally {
    f.journal.close();
    rmSync(f.dir, { recursive: true });
  }
});

test("reconciliation cancels an identity-verified real process and persists cancellation after restart", async () => {
  const f = fixture();
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  try {
    await once(child, "spawn");
    f.journal.reserveRun("launch", "run", "workspace", "session", "studio", 1);
    f.journal.recordLaunch("run", "fixture-native-run");
    f.journal.requestCancel("cancel", "run", "studio", 1);
    f.journal.close();
    f.journal = new Journal(f.path);
    let cancelled = false;
    await f.journal.reconcile({
      inspect: async (run) => {
        assert.equal(run.nativeId, "fixture-native-run");
        return cancelled ? "cancelled" : "running";
      },
      cancel: async () => {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
        cancelled = true;
      },
    });
    assert.equal(child.signalCode, "SIGTERM");
    assert.equal(f.journal.run("run").state, "cancelled");
    assert.equal(
      f.journal.reserveRun(
        "second-launch",
        "run-2",
        "workspace",
        "session",
        "studio",
        1,
      ).launchAllowed,
      true,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    f.journal.close();
    rmSync(f.dir, { recursive: true });
  }
});

test("event reconnect preserves cursor order, deduplicates source identities, and rejects gaps or conflicting replay", () => {
  const f = fixture();
  try {
    const base = {
      sessionId: "session",
      sourceDevice: "studio",
      segmentId: "segment",
      type: "status",
      payload: { status: "running" },
    };
    const first = f.journal.appendEvent({ ...base, sequence: 1 });
    const second = f.journal.appendEvent({ ...base, sequence: 2 });
    f.journal.close();
    f.journal = new Journal(f.path);
    assert.deepEqual(f.journal.appendEvent({ ...base, sequence: 1 }), first);
    assert.deepEqual(f.journal.events("session", first.cursor, 20), [second]);
    assert.deepEqual(f.journal.events("other-session", 0, 20), []);
    assert.throws(
      () =>
        f.journal.appendEvent({
          ...base,
          sequence: 1,
          payload: { status: "other" },
        }),
      { code: "EVENT_CONFLICT" },
    );
    assert.throws(() => f.journal.appendEvent({ ...base, sequence: 4 }), {
      code: "EVENT_GAP",
    });
  } finally {
    f.journal.close();
    rmSync(f.dir, { recursive: true });
  }
});

test("private IPC requires negotiated capabilities, rejects duplicates, and survives client closure and host restart", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vzn-ipc-")));
  let host = await startHost(dir);
  let client = new HostClient(host.socketPath);
  try {
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(host.socketPath).mode & 0o777, 0o600);
    await assert.rejects(startHost(dir), { code: "HOST_ALREADY_RUNNING" });
    await assert.rejects(client.request({ kind: "health" }), {
      code: "NEGOTIATION_REQUIRED",
    });
    await assert.rejects(
      client.request({ kind: "hello", capabilities: ["execute-shell"] }),
      { code: "UNSUPPORTED_CAPABILITY" },
    );
    await client.request({ kind: "hello", capabilities: ["project-catalog"] });
    const project = {
      kind: "register-project",
      operationId: "register",
      projectId: "project",
      root: dir,
      repository: "example.invalid/project",
    } as const;
    await client.request(project);
    await assert.rejects(
      client.request({
        kind: "session-events",
        sessionId: "session",
        after: 0,
        limit: 10,
      }),
      { code: "CAPABILITY_REQUIRED" },
    );
    client.close();
    client = new HostClient(host.socketPath);
    await client.request({ kind: "hello", capabilities: ["project-catalog"] });
    assert.deepEqual(await client.request({ kind: "list-projects" }), {
      projects: [
        { id: "project", root: dir, repository: "example.invalid/project" },
      ],
    });
    client.close();
    await host.close();
    host = await startHost(dir);
    client = new HostClient(host.socketPath);
    await client.request({ kind: "hello", capabilities: ["project-catalog"] });
    assert.deepEqual(await client.request(project), {
      id: "project",
      root: dir,
      repository: "example.invalid/project",
    });
    await assert.rejects(
      client.request({ ...project, repository: "different" }),
      { code: "OPERATION_CONFLICT" },
    );
  } finally {
    client.close();
    await host.close();
    rmSync(dir, { recursive: true });
  }
});

test("protocol rejects unsupported versions, smuggled fields, unbounded pagination, and invalid identities", () => {
  const common = { protocolVersion: 1, requestId: "request" };
  for (const request of [
    { ...common, kind: "health", protocolVersion: 2 },
    { ...common, kind: "health", targetDeviceId: "untrusted" },
    { ...common, kind: "session-events", sessionId: "s", after: -1, limit: 10 },
    {
      ...common,
      kind: "session-events",
      sessionId: "s",
      after: 0,
      limit: 10000,
    },
    { ...common, kind: "health", requestId: "../escape" },
  ])
    assert.throws(() => parseRequest(request));
});

test("CLI serves health and project catalog through a separate supervised process", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vzn-cli-")));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const service = spawn(process.execPath, [cli, "serve", "--state-dir", dir]);
  let serviceError = "";
  service.stderr.on("data", (chunk) => {
    serviceError += chunk;
  });
  const ready = Promise.race([
    once(service.stdout, "data"),
    once(service, "exit").then(([code]) => {
      throw new Error(`Host exited before ready: ${code}; ${serviceError}`);
    }),
  ]);
  try {
    await ready;
    const invoke = (args: string[]) =>
      new Promise<unknown>((resolve, reject) => {
        const child = spawn(process.execPath, [
          cli,
          ...args,
          "--state-dir",
          dir,
        ]);
        let output = "";
        let errors = "";
        child.stdout.on("data", (data) => {
          output += data;
        });
        child.stderr.on("data", (data) => {
          errors += data;
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code === 0) resolve(JSON.parse(output));
          else reject(new Error(errors));
        });
      });
    assert.equal(
      ((await invoke(["health"])) as { status: string }).status,
      "ready",
    );
    await invoke([
      "register-project",
      "project",
      dir,
      "example.invalid/project",
      "register",
    ]);
    assert.deepEqual(await invoke(["list-projects"]), {
      projects: [
        { id: "project", root: dir, repository: "example.invalid/project" },
      ],
    });
  } finally {
    if (service.exitCode === null && service.signalCode === null) {
      const exited = once(service, "exit");
      service.kill("SIGTERM");
      await exited;
    }
    rmSync(dir, { recursive: true });
  }
});

test("OS lease denies a competing host and releases automatically after process death", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vzn-lease-")));
  const path = join(dir, "host-lock.sqlite");
  const module = new URL("../src/lease.ts", import.meta.url).href;
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    `import {HostLease} from ${JSON.stringify(module)};new HostLease(${JSON.stringify(path)});console.log('locked');setInterval(()=>{},1000);`,
  ]);
  try {
    await once(child.stdout, "data");
    assert.throws(() => new HostLease(path), { code: "HOST_ALREADY_RUNNING" });
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const lease = new HostLease(path);
    lease.close();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    rmSync(dir, { recursive: true });
  }
});
