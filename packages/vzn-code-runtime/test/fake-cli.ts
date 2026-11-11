import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args.join(" ") === "code --help") {
  process.stdout.write("agent-native code --permission-mode\n");
} else {
  const store = process.env.AGENT_NATIVE_CODE_AGENTS_HOME;
  if (!store) throw new Error("Missing isolated store");
  const prompt = args.at(-1);
  mkdirSync(join(store, "runs"), { recursive: true });
  mkdirSync(join(store, "transcripts"), { recursive: true });
  writeFileSync(
    join(store, "arguments.json"),
    JSON.stringify({ args, cwd: process.cwd() }),
  );
  const record = {
    schemaVersion: 1,
    id: "native-session",
    cwd: process.cwd(),
    status:
      prompt === "fail"
        ? "errored"
        : prompt === "credential-gap"
          ? "paused"
          : prompt === "wait"
            ? "running"
            : "completed",
  };
  writeFileSync(
    join(store, "runs", "native-session.json"),
    JSON.stringify(record),
  );
  writeFileSync(
    join(store, "transcripts", "native-session.jsonl"),
    JSON.stringify({
      schemaVersion: 1,
      id: "native-event",
      runId: "native-session",
      kind: prompt === "credential-gap" ? "status" : "note",
      message:
        prompt === "credential-gap"
          ? "No provider key is configured"
          : "Recorded response",
      createdAt: "2026-11-09T00:00:00.000Z",
      metadata: { role: "assistant" },
      ...(prompt === "credential-gap" ? { signal: "credential-gap" } : {}),
    }) + "\n",
  );
  if (prompt === "partial")
    appendFileSync(
      join(store, "transcripts", "native-session.jsonl"),
      '{"partial":',
    );
  if (prompt === "wait" || prompt === "completed-live")
    setInterval(() => {}, 1000);
  if (prompt === "fail") process.exitCode = 7;
}
