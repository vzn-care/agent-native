import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { AgentNativeRuntime, RuntimeError } from "../src/index.ts";
import type { RuntimeEvent } from "../src/index.ts";
const fixture = fileURLToPath(new URL("./fake-cli.ts", import.meta.url));
function setup() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "vzn-runtime-")));
  const options = {
    stateDirectory: join(directory, "runtime"),
    executable: process.execPath,
    prefixArgs: [fixture],
  };
  return { directory, options, runtime: new AgentNativeRuntime(options) };
}

test("executes literal argv in the explicit workspace and replays native events after restart", async () => {
  const { directory, options, runtime } = setup();
  try {
    const events: RuntimeEvent[] = [];
    const prompt = '--full-auto $(touch should-not-exist) "two words"';
    const launched = await runtime.start(
      {
        id: "host-run",
        sessionId: "host-session",
        workspaceRoot: directory,
        prompt,
      },
      { onEvent: (event) => events.push(event) },
    );
    assert.deepEqual(await launched.completion, {
      state: "completed",
      nativeSessionId: "native-session",
      exitCode: 0,
    });
    assert.deepEqual(
      JSON.parse(
        readFileSync(
          join(directory, "runtime", "host-run", "native", "arguments.json"),
          "utf8",
        ),
      ),
      {
        args: ["code", "exec", "--permission-mode", "read-only", "--", prompt],
        cwd: directory,
      },
    );
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      id: "native-event",
      runId: "host-run",
      sessionId: "host-session",
      nativeSessionId: "native-session",
      kind: "note",
      message: "Recorded response",
      createdAt: "2026-11-09T00:00:00.000Z",
      metadata: { role: "assistant" },
    });
    const restarted = new AgentNativeRuntime(options);
    assert.equal(
      await restarted.inspect({ id: "host-run", nativeId: launched.nativeId }),
      "completed",
    );
    assert.deepEqual(restarted.transcript({ id: "host-run" }), events);
    await assert.rejects(
      restarted.start({
        id: "host-run",
        sessionId: "host-session",
        workspaceRoot: directory,
        prompt,
      }),
      (error: unknown) =>
        error instanceof RuntimeError && error.code === "RUN_ALREADY_RESERVED",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cancels its owned process but refuses to kill a runner owned by a previous host instance", async () => {
  const { directory, options, runtime } = setup();
  let launched: Awaited<ReturnType<typeof runtime.start>> | undefined;
  try {
    let observed: (() => void) | undefined;
    const firstEvent = new Promise<void>((resolve) => {
      observed = resolve;
    });
    launched = await runtime.start(
      {
        id: "cancel-run",
        sessionId: "session",
        workspaceRoot: directory,
        prompt: "wait",
      },
      { onEvent: () => observed?.() },
    );
    await firstEvent;
    const restarted = new AgentNativeRuntime(options);
    assert.equal(await restarted.inspect({ id: "cancel-run" }), "unknown");
    await assert.rejects(
      restarted.cancel({ id: "cancel-run" }),
      (error: unknown) =>
        error instanceof RuntimeError &&
        error.code === "CANCELLATION_UNCERTAIN",
    );
    await runtime.cancel({ id: "cancel-run" });
    assert.equal((await launched.completion).state, "cancelled");
    assert.equal(await restarted.inspect({ id: "cancel-run" }), "cancelled");
  } finally {
    if (launched) await runtime.cancel({ id: "cancel-run" });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preserves nonzero runner failure and reports unavailable executable without starting a run", async () => {
  const { directory, options, runtime } = setup();
  try {
    const launched = await runtime.start({
      id: "failed-run",
      sessionId: "session",
      workspaceRoot: directory,
      prompt: "fail",
    });
    assert.deepEqual(await launched.completion, {
      state: "errored",
      nativeSessionId: "native-session",
      exitCode: 7,
    });
    assert.equal(await runtime.inspect({ id: "failed-run" }), "errored");
    const restarted = new AgentNativeRuntime(options);
    assert.equal(await restarted.inspect({ id: "failed-run" }), "errored");
    await restarted.cancel({ id: "failed-run" });
    const retry = await restarted.start({
      id: "retry-run",
      sessionId: "session",
      workspaceRoot: directory,
      prompt: "retry",
    });
    assert.equal((await retry.completion).state, "completed");
    const missing = new AgentNativeRuntime({
      stateDirectory: join(directory, "missing-state"),
      executable: join(directory, "missing-cli"),
    });
    const readiness = await missing.readiness(directory);
    assert.equal(readiness.available, false);
    assert.equal(readiness.provider, "unverified");
    await assert.rejects(
      missing.start({
        id: "absent-run",
        sessionId: "session",
        workspaceRoot: directory,
        prompt: "test",
      }),
      (error: unknown) =>
        error instanceof RuntimeError && error.code === "CLI_UNAVAILABLE",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a truncated terminal transcript even when the native record claims completion", async () => {
  const { directory, runtime } = setup();
  try {
    const launched = await runtime.start({
      id: "partial-run",
      sessionId: "session",
      workspaceRoot: directory,
      prompt: "partial",
    });
    assert.deepEqual(await launched.completion, {
      state: "errored",
      nativeSessionId: "native-session",
      exitCode: 0,
      reason: "TRUNCATED_TRANSCRIPT",
    });
    assert.equal(await runtime.inspect({ id: "partial-run" }), "errored");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("does not release an orphaned runner when its native record says completed before process exit", async () => {
  const { directory, options, runtime } = setup();
  let launched: Awaited<ReturnType<typeof runtime.start>> | undefined;
  try {
    let observed: (() => void) | undefined;
    const firstEvent = new Promise<void>((resolve) => {
      observed = resolve;
    });
    launched = await runtime.start(
      {
        id: "still-live-run",
        sessionId: "session",
        workspaceRoot: directory,
        prompt: "completed-live",
      },
      { onEvent: () => observed?.() },
    );
    await firstEvent;
    const nativeRecord = JSON.parse(
      readFileSync(
        join(
          directory,
          "runtime",
          "still-live-run",
          "native",
          "runs",
          "native-session.json",
        ),
        "utf8",
      ),
    );
    assert.equal(nativeRecord.status, "completed");
    assert.equal(await runtime.inspect({ id: "still-live-run" }), "running");
    const restarted = new AgentNativeRuntime(options);
    assert.equal(await restarted.inspect({ id: "still-live-run" }), "unknown");
    await assert.rejects(
      restarted.cancel({ id: "still-live-run" }),
      (error: unknown) =>
        error instanceof RuntimeError &&
        error.code === "CANCELLATION_UNCERTAIN",
    );
    await runtime.cancel({ id: "still-live-run" });
    assert.equal((await launched.completion).state, "cancelled");
    assert.equal(
      await restarted.inspect({ id: "still-live-run" }),
      "cancelled",
    );
  } finally {
    if (launched) await runtime.cancel({ id: "still-live-run" });
    rmSync(directory, { recursive: true, force: true });
  }
});
