import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { isAbsolute, join } from "node:path";

import { HostController } from "./controller.ts";
import type { HostOptions } from "./controller.ts";
import { loadHostGitea } from "./gitea.ts";
import { Journal } from "./journal.ts";
import { HostLease } from "./lease.ts";
import { HostError, MAX_FRAME_BYTES, parseRequest } from "./protocol.ts";
import type { Request, Response } from "./protocol.ts";

export function privateDirectory(directory: string): string {
  if (process.platform === "win32")
    throw new HostError(
      "UNSUPPORTED_PLATFORM",
      "Protected Windows named-pipe transport is not implemented",
    );
  if (!isAbsolute(directory))
    throw new HostError(
      "INVALID_DIRECTORY",
      "State directory must be absolute",
    );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.()
  )
    throw new HostError(
      "UNSAFE_DIRECTORY",
      "State directory must be a real directory owned by this user",
    );
  chmodSync(directory, 0o700);
  return realpathSync(directory);
}
function privateFile(path: string): void {
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      stat.nlink !== 1
    )
      throw new HostError(
        "UNSAFE_FILE",
        "State file must be a private regular file owned by this user",
      );
    chmodSync(path, 0o600);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
}
export async function startHost(
  directory: string,
  options: HostOptions = {},
): Promise<{ socketPath: string; close: () => Promise<void> }> {
  const stateDir = privateDirectory(directory);
  const socketPath = join(stateDir, "host.sock");
  if (Buffer.byteLength(socketPath) > 100)
    throw new HostError(
      "SOCKET_PATH_TOO_LONG",
      "Use a shorter host state directory (socket path maximum 100 bytes)",
    );
  for (const name of [
    "host-lock.sqlite",
    "host-lock.sqlite-journal",
    "journal.sqlite",
    "journal.sqlite-journal",
    "journal.sqlite-wal",
    "journal.sqlite-shm",
  ])
    privateFile(join(stateDir, name));
  const lock = new HostLease(join(stateDir, "host-lock.sqlite"));
  let journal: Journal | undefined;
  let controller: HostController | undefined;
  const clients = new Set<Socket>();
  const server = createServer();
  try {
    privateFile(join(stateDir, "host-lock.sqlite"));
    journal = new Journal(join(stateDir, "journal.sqlite"));
    for (const name of [
      "journal.sqlite",
      "journal.sqlite-wal",
      "journal.sqlite-shm",
    ])
      privateFile(join(stateDir, name));
    const gitea = options.gitea ?? loadHostGitea(stateDir, journal);
    controller = new HostController(journal, {
      ...options,
      ...(gitea ? { gitea } : {}),
    });
    await controller.reconcile();
    const activeController = controller;
    const activeJournal = journal;
    try {
      const stat = lstatSync(socketPath);
      if (!stat.isSocket() || stat.uid !== process.getuid?.())
        throw new HostError(
          "UNSAFE_SOCKET",
          "Existing IPC path is not an owned socket",
        );
      unlinkSync(socketPath);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    server.on("connection", (socket) => {
      clients.add(socket);
      socket.on("close", () => clients.delete(socket));
      socket.on("error", () => socket.destroy());
      socket.setTimeout(30_000, () => socket.destroy());
      let buffer = Buffer.alloc(0);
      let negotiated = false;
      let inFlight = 0;
      let selected = new Set<string>();
      const reply = (response: Response) => {
        if (socket.writableLength > 1024 * 1024) {
          socket.destroy();
          return;
        }
        socket.write(JSON.stringify(response) + "\n");
      };
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
          const end = buffer.indexOf(10);
          if (end < 0) {
            if (buffer.length > MAX_FRAME_BYTES) socket.destroy();
            return;
          }
          if (end > MAX_FRAME_BYTES) {
            socket.destroy();
            return;
          }
          const line = buffer.subarray(0, end).toString("utf8");
          buffer = buffer.subarray(end + 1);
          let requestId = "invalid";
          try {
            const request = parseRequest(JSON.parse(line));
            requestId = request.requestId;
            if (request.kind === "hello") {
              if (negotiated)
                throw new HostError(
                  "ALREADY_NEGOTIATED",
                  "Connection already negotiated",
                );
              const unsupported = request.capabilities.filter(
                (capability) =>
                  !activeController.capabilities.some(
                    (known) => known === capability,
                  ),
              );
              if (unsupported.length)
                throw new HostError(
                  "UNSUPPORTED_CAPABILITY",
                  "Requested capability is not implemented",
                );
              selected = new Set(request.capabilities);
              negotiated = true;
              reply({
                protocolVersion: 1,
                requestId,
                ok: true,
                result: {
                  protocolVersion: 1,
                  capabilities: activeController.capabilities,
                  negotiated: request.capabilities,
                  executionAvailable: Boolean(options.runtime),
                  remoteControlAvailable: false,
                },
              });
              continue;
            }
            if (!negotiated)
              throw new HostError(
                "NEGOTIATION_REQUIRED",
                "Send hello before other requests",
              );
            const required = [
              "enroll-repository",
              "repository-status",
              "ensure-deploy-key",
              "revoke-deploy-key",
            ].includes(request.kind)
              ? "repository-provisioning"
              : request.kind === "session-events"
                ? "session-event-replay"
                : request.kind === "health"
                  ? undefined
                  : [
                        "start-run",
                        "cancel-run",
                        "run-status",
                        "run-transcript",
                      ].includes(request.kind)
                    ? "task-control"
                    : "project-catalog";
            if (required && !selected.has(required))
              throw new HostError(
                "CAPABILITY_REQUIRED",
                `Negotiate ${required} first`,
              );
            if (inFlight >= 32)
              throw new HostError(
                "TOO_MANY_REQUESTS",
                "Too many in-flight requests",
              );
            inFlight += 1;
            const result =
              request.kind === "register-project"
                ? Promise.resolve().then(() =>
                    registerProject(activeJournal, request),
                  )
                : activeController.dispatch(request);
            void result
              .then(
                (value) =>
                  reply({
                    protocolVersion: 1,
                    requestId,
                    ok: true,
                    result: value,
                  }),
                (error: unknown) =>
                  reply({
                    protocolVersion: 1,
                    requestId,
                    ok: false,
                    error:
                      error instanceof HostError
                        ? { code: error.code, message: error.message }
                        : {
                            code: "REQUEST_FAILED",
                            message:
                              "Request failed; reconcile operation state before retrying",
                          },
                  }),
              )
              .finally(() => {
                inFlight -= 1;
              });
          } catch (error) {
            reply({
              protocolVersion: 1,
              requestId,
              ok: false,
              error:
                error instanceof HostError
                  ? { code: error.code, message: error.message }
                  : {
                      code: "REQUEST_FAILED",
                      message:
                        "Request failed; no successful result was recorded",
                    },
            });
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    chmodSync(socketPath, 0o600);
  } catch (error) {
    server.close();
    journal?.close();
    lock.close();
    throw error;
  }
  let closed = false;
  return {
    socketPath,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      try {
        await controller?.stop();
      } finally {
        journal?.close();
        lock.close();
      }
    },
  };
}
function registerProject(
  journal: Journal,
  request: Extract<Request, { kind: "register-project" }>,
): unknown {
  if (!isAbsolute(request.root))
    throw new HostError("INVALID_ROOT", "Project root must be absolute");
  const root = realpathSync(request.root);
  if (!lstatSync(root).isDirectory())
    throw new HostError("INVALID_ROOT", "Project root is not a directory");
  return journal.registerProject(request.operationId, {
    id: request.projectId,
    root,
    repository: request.repository,
  });
}
