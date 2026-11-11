import { spawn } from "node:child_process";
import { devNull } from "node:os";

import { CheckpointError } from "./errors.ts";

export interface GitOptions {
  signal?: AbortSignal;
  indexFile?: string;
  input?: Buffer | string;
  sshExecutable?: string;
  sshConfigPath?: string;
  isolatedConfig?: boolean;
}
const MAX_OUTPUT = 64 * 1024 * 1024;

export async function git(
  root: string,
  args: string[],
  options: GitOptions = {},
): Promise<Buffer> {
  options.signal?.throwIfAborted();
  const env = { ...process.env };
  // Inherited Git routing variables must never redirect a source or target operation.
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "VZN checkpoint",
    GIT_AUTHOR_EMAIL: "checkpoint@example.invalid",
    GIT_COMMITTER_NAME: "VZN checkpoint",
    GIT_COMMITTER_EMAIL: "checkpoint@example.invalid",
    ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}),
    ...(options.sshExecutable
      ? {
          GIT_SSH: options.sshExecutable,
          GIT_SSH_VARIANT: "ssh",
          VZN_CODE_SSH_CONFIG: options.sshConfigPath,
        }
      : {}),
    ...(options.isolatedConfig ? { GIT_CONFIG_GLOBAL: devNull } : {}),
  });
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        `core.hooksPath=${devNull}`,
        ...args,
      ],
      {
        cwd: root,
        env,
        shell: false,
        signal: options.signal,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const output: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let processError: Error | undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) {
        overflow = true;
        child.kill();
      } else output.push(chunk);
    });
    // Git diagnostics may contain file content or credential-bearing configuration.
    child.stderr.resume();
    child.on("error", (error) => {
      processError = error;
    });
    child.stdin.on("error", (error) => {
      processError = error;
    });
    child.on("close", (code) => {
      if (options.signal?.aborted) reject(options.signal.reason);
      else if (processError) reject(processError);
      else if (overflow)
        reject(
          new CheckpointError("Git output exceeded the checkpoint limit."),
        );
      else if (code !== 0)
        reject(new CheckpointError(`Git ${args[0]} failed (exit ${code}).`));
      else resolve(Buffer.concat(output));
    });
    child.stdin.end(options.input);
  });
}
export async function gitText(
  root: string,
  args: string[],
  options: GitOptions = {},
): Promise<string> {
  return (await git(root, args, options)).toString("utf8").trim();
}
