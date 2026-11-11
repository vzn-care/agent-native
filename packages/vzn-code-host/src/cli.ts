import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { AgentNativeRuntime } from "../../vzn-code-runtime/src/index.ts";
import { HostClient } from "./client.ts";
import { HostError } from "./protocol.ts";
import { startHost, privateDirectory } from "./service.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift();
  const dirIndex = args.indexOf("--state-dir");
  let stateDir = join(homedir(), ".vzn-code-host");
  if (dirIndex !== -1) {
    const value = args[dirIndex + 1];
    if (!value)
      throw new HostError("USAGE", "--state-dir requires an absolute path");
    stateDir = value;
    args.splice(dirIndex, 2);
  }
  let runtimeExecutable: string | undefined;
  const runtimeIndex = args.indexOf("--runtime-executable");
  if (runtimeIndex !== -1) {
    runtimeExecutable = args[runtimeIndex + 1];
    if (!runtimeExecutable || command !== "serve")
      throw new HostError(
        "USAGE",
        "--runtime-executable requires an absolute CLI executable path and serve command",
      );
    args.splice(runtimeIndex, 2);
  }
  if (command === "serve") {
    if (args.length)
      throw new HostError("USAGE", "serve accepts only --state-dir");
    stateDir = privateDirectory(stateDir);
    const runtime = runtimeExecutable
      ? new AgentNativeRuntime({
          stateDirectory: join(stateDir, "runtime"),
          executable: runtimeExecutable,
        })
      : undefined;
    const host = await startHost(stateDir, { runtime });
    console.log(
      JSON.stringify({
        status: "ready",
        socketPath: host.socketPath,
        pid: process.pid,
      }),
    );
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      host.close().then(
        () => {
          process.exitCode = 0;
        },
        (error: unknown) => {
          console.error(error);
          process.exitCode = 1;
        },
      );
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    return;
  }
  if (
    command !== "health" &&
    command !== "list-projects" &&
    command !== "register-project" &&
    command !== "gitea-enroll" &&
    command !== "gitea-status" &&
    command !== "gitea-key-add" &&
    command !== "gitea-key-revoke"
  )
    throw new HostError(
      "USAGE",
      "Commands: serve, health, list-projects, register-project <id> <absolute-root> <repository-identity> [operation-id], gitea-enroll <project-id> [gitea-repository-name], gitea-status <project-id>, gitea-key-add <project-id> <device-id> <absolute-public-key-file> <read|write>, gitea-key-revoke <project-id> <device-id>; all accept --state-dir <absolute-directory>",
    );
  const client = new HostClient(join(stateDir, "host.sock"));
  try {
    const provisioning = command.startsWith("gitea-");
    await client.request({
      kind: "hello",
      capabilities: [
        provisioning ? "repository-provisioning" : "project-catalog",
      ],
    });
    if (command === "register-project") {
      const [projectId, root, repository, operationId = randomUUID()] = args;
      if (!projectId || !root || !repository || args.length > 4)
        throw new HostError(
          "USAGE",
          "register-project requires id, absolute root, repository identity, and optional operation ID",
        );
      console.log(
        JSON.stringify(
          await client.request({
            kind: command,
            projectId,
            root,
            repository,
            operationId,
          }),
        ),
      );
    } else if (command === "gitea-enroll" || command === "gitea-status") {
      const [projectId, repositoryName] = args;
      if (!projectId || args.length > (command === "gitea-enroll" ? 2 : 1))
        throw new HostError("USAGE", `${command} requires a project ID`);
      console.log(
        JSON.stringify(
          await client.request({
            kind:
              command === "gitea-enroll"
                ? "enroll-repository"
                : "repository-status",
            projectId,
            ...(command === "gitea-enroll" && repositoryName
              ? { repositoryName }
              : {}),
          }),
        ),
      );
    } else if (command === "gitea-key-add") {
      const [projectId, deviceId, publicKeyFile, access] = args;
      if (
        !projectId ||
        !deviceId ||
        !publicKeyFile ||
        !isAbsolute(publicKeyFile) ||
        (access !== "read" && access !== "write") ||
        args.length !== 4
      )
        throw new HostError(
          "USAGE",
          "gitea-key-add requires project ID, device ID, absolute public-key file, and read or write",
        );
      const key = (await client.request({
        kind: "ensure-deploy-key",
        projectId,
        deviceId,
        publicKey: readFileSync(publicKeyFile, "utf8").trim(),
        readOnly: access === "read",
      })) as { keyId: number; readOnly: boolean };
      console.log(
        JSON.stringify({
          projectId,
          deviceId,
          keyId: key.keyId,
          readOnly: key.readOnly,
        }),
      );
    } else if (command === "gitea-key-revoke") {
      const [projectId, deviceId] = args;
      if (!projectId || !deviceId || args.length !== 2)
        throw new HostError(
          "USAGE",
          "gitea-key-revoke requires project ID and device ID",
        );
      const result = await client.request({
        kind: "revoke-deploy-key",
        projectId,
        deviceId,
      });
      console.log(JSON.stringify(result));
    } else {
      if (args.length)
        throw new HostError("USAGE", `${command} accepts only --state-dir`);
      console.log(JSON.stringify(await client.request({ kind: command })));
    }
  } finally {
    client.close();
  }
}
main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      error: error instanceof HostError ? error.code : "HOST_FAILED",
      message: error instanceof Error ? error.message : "Unknown host failure",
    }),
  );
  process.exitCode = 1;
});
