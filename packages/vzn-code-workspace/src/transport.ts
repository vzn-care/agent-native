import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CheckpointError,
  checkpointDigest,
  verifyCheckpoint,
} from "./checkpoint.ts";
import type { CheckpointManifest, CheckpointPolicy } from "./checkpoint.ts";
import { git, gitText } from "./git.ts";
import type { GitOptions } from "./git.ts";

export type CheckpointRemote = {
  projectId: string;
  repositoryId: string;
} & (
  | { kind: "ssh"; url: string; sshConfigPath: string }
  | { kind: "local"; repositoryPath: string }
);
export interface CheckpointTransferInput {
  repositoryPath: string;
  manifest: CheckpointManifest;
  expectedDigest: string;
  remote: CheckpointRemote;
  policy?: CheckpointPolicy;
  signal?: AbortSignal;
}
export interface CheckpointTransferResult {
  checkpointId: string;
  digest: string;
  state: "transferred" | "already-present";
}
const LAYERS = ["index", "tracked", "untracked"] as const;

function assertBinding(input: CheckpointTransferInput): void {
  if (
    input.manifest.projectId !== input.remote.projectId ||
    input.manifest.repositoryId !== input.remote.repositoryId ||
    checkpointDigest(input.manifest) !== input.expectedDigest ||
    input.manifest.schemaVersion !== 1 ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(input.manifest.checkpointId)
  ) {
    throw new CheckpointError(
      "Checkpoint does not match the trusted repository binding or digest.",
    );
  }
  const width =
    input.manifest.objectFormat === "sha1"
      ? 40
      : input.manifest.objectFormat === "sha256"
        ? 64
        : 0;
  for (const name of LAYERS) {
    if (
      !width ||
      !new RegExp(`^[a-f0-9]{${width}}$`).test(input.manifest[name].commit) ||
      input.manifest[name].ref !==
        `refs/vzn-code/checkpoints/${input.manifest.checkpointId}/${name}`
    ) {
      throw new CheckpointError("Invalid checkpoint transfer object or ref.");
    }
  }
}
function remoteRef(
  manifest: CheckpointManifest,
  layer: (typeof LAYERS)[number],
): string {
  return `refs/heads/handoff/${manifest.checkpointId}/${layer}`;
}
function readRefs(output: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of output.split("\n").filter(Boolean)) {
    const [objectId, ref] = line.split(/\s+/);
    if (!objectId || !ref || refs.has(ref))
      throw new CheckpointError("Invalid checkpoint ref response.");
    refs.set(ref, objectId);
  }
  return refs;
}
async function remoteIdentity(
  value: string,
  repositoryPath: string,
): Promise<string> {
  if (value.includes("://"))
    return new URL(value).toString().replace(/\/$/, "");
  const scp = value.match(/^([^/]+@[^/:]+):(.+)$/);
  if (scp)
    return new URL(`ssh://${scp[1]}/${scp[2]}`).toString().replace(/\/$/, "");
  const local = path.resolve(repositoryPath, value);
  try {
    return await fs.realpath(local);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return local;
    throw error;
  }
}
function missingLayers(
  input: CheckpointTransferInput,
  refs: Map<string, string>,
  remote: boolean,
) {
  return LAYERS.filter((name) => {
    const actual = refs.get(
      remote ? remoteRef(input.manifest, name) : input.manifest[name].ref,
    );
    if (actual && actual !== input.manifest[name].commit)
      throw new CheckpointError(
        "An immutable checkpoint ref has a different object identity.",
      );
    return !actual;
  });
}
async function transportContext(input: CheckpointTransferInput) {
  assertBinding(input);
  const temp = await fs.mkdtemp(
    path.join(tmpdir(), "vzn-checkpoint-transfer-"),
  );
  const options: GitOptions = { signal: input.signal, isolatedConfig: true };
  try {
    let remote: string;
    if (input.remote.kind === "local") {
      remote = await fs.realpath(input.remote.repositoryPath);
      if (remote.includes("\n"))
        throw new CheckpointError("Unsupported local repository path.");
      if (
        (await gitText(
          remote,
          ["rev-parse", "--is-bare-repository"],
          options,
        )) !== "true"
      ) {
        throw new CheckpointError(
          "Local checkpoint transport requires a configured bare repository.",
        );
      }
    } else {
      const url = new URL(input.remote.url);
      if (
        url.protocol !== "ssh:" ||
        url.password ||
        url.search ||
        url.hash ||
        !url.hostname ||
        !url.pathname ||
        url.pathname === "/"
      ) {
        throw new CheckpointError(
          "Checkpoint SSH transport requires a trusted credential-free repository URL.",
        );
      }
      remote = url.toString();
      const config = await fs.realpath(input.remote.sshConfigPath);
      if (!(await fs.stat(config)).isFile())
        throw new CheckpointError("SSH configuration is not a file.");
      if (process.platform === "win32" || /[\r\n]/.test(process.execPath)) {
        throw new CheckpointError(
          "The scoped SSH adapter is not validated on this platform.",
        );
      }
      const adapter = path.join(temp, "git-ssh");
      await fs.writeFile(
        adapter,
        `#!${process.execPath}\n` +
          'const { spawn } = require("node:child_process");\n' +
          'const child = spawn("ssh", ["-F", process.env.VZN_CODE_SSH_CONFIG, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", ...process.argv.slice(2)], { shell: false, stdio: "inherit" });\n' +
          'child.on("error", () => process.exit(1));\nchild.on("exit", (code) => process.exit(code === null ? 1 : code));\n',
        { mode: 0o700 },
      );
      options.sshExecutable = adapter;
      options.sshConfigPath = config;
    }
    const remotes = (
      await gitText(input.repositoryPath, ["remote"], options)
    ).split("\n");
    if (remotes.includes("origin")) {
      const originUrls = [
        ...(
          await gitText(
            input.repositoryPath,
            ["remote", "get-url", "--all", "origin"],
            options,
          )
        ).split("\n"),
        ...(
          await gitText(
            input.repositoryPath,
            ["remote", "get-url", "--push", "--all", "origin"],
            options,
          )
        ).split("\n"),
      ];
      const targetIdentity = await remoteIdentity(remote, input.repositoryPath);
      for (const url of originUrls) {
        if (
          (await remoteIdentity(url, input.repositoryPath)) === targetIdentity
        ) {
          throw new CheckpointError(
            "Checkpoint transport must not target the normal origin remote.",
          );
        }
      }
    }
    const stage = path.join(temp, "stage.git");
    await git(
      temp,
      [
        "init",
        "--bare",
        `--object-format=${input.manifest.objectFormat}`,
        stage,
      ],
      options,
    );
    return { temp, stage, remote, options };
  } catch (error) {
    await fs.rm(temp, { recursive: true, force: true });
    throw error;
  }
}
function receipt(
  input: CheckpointTransferInput,
  changed: boolean,
): CheckpointTransferResult {
  return {
    checkpointId: input.manifest.checkpointId,
    digest: input.expectedDigest,
    state: changed ? "transferred" : "already-present",
  };
}

/** Explicitly publish immutable checkpoint branches to the registered private repository. */
export async function publishCheckpoint(
  input: CheckpointTransferInput,
): Promise<CheckpointTransferResult> {
  assertBinding(input);
  await verifyCheckpoint(input);
  const context = await transportContext(input);
  try {
    const { stage, remote, options } = context;
    const objects = await fs.realpath(
      path.resolve(
        input.repositoryPath,
        await gitText(
          input.repositoryPath,
          ["rev-parse", "--git-path", "objects"],
          options,
        ),
      ),
    );
    if (objects.includes("\n"))
      throw new CheckpointError("Unsupported source object directory.");
    await fs.writeFile(
      path.join(stage, "objects", "info", "alternates"),
      `${objects}\n`,
    );
    const refs = readRefs(
      await gitText(
        stage,
        [
          "ls-remote",
          "--refs",
          remote,
          ...LAYERS.map((name) => remoteRef(input.manifest, name)),
        ],
        options,
      ),
    );
    const missing = missingLayers(input, refs, true);
    if (missing.length) {
      // An empty expected-value lease permits creation only, including a race after ls-remote.
      await git(
        stage,
        [
          "push",
          "--atomic",
          "--porcelain",
          ...missing.map(
            (name) => `--force-with-lease=${remoteRef(input.manifest, name)}:`,
          ),
          remote,
          ...missing.map(
            (name) =>
              `${input.manifest[name].commit}:${remoteRef(input.manifest, name)}`,
          ),
        ],
        options,
      );
    }
    const verified = readRefs(
      await gitText(
        stage,
        [
          "ls-remote",
          "--refs",
          remote,
          ...LAYERS.map((name) => remoteRef(input.manifest, name)),
        ],
        options,
      ),
    );
    if (missingLayers(input, verified, true).length)
      throw new CheckpointError(
        "Private checkpoint publication is incomplete.",
      );
    return receipt(input, missing.length > 0);
  } finally {
    await fs.rm(context.temp, { recursive: true, force: true });
  }
}

/** Fetch and verify all layers in isolation before accepting their local retained refs. */
export async function fetchCheckpoint(
  input: CheckpointTransferInput,
): Promise<CheckpointTransferResult> {
  const context = await transportContext(input);
  try {
    const { stage, remote, options } = context;
    const remoteRefs = readRefs(
      await gitText(
        stage,
        [
          "ls-remote",
          "--refs",
          remote,
          ...LAYERS.map((name) => remoteRef(input.manifest, name)),
        ],
        options,
      ),
    );
    if (missingLayers(input, remoteRefs, true).length)
      throw new CheckpointError(
        "Private checkpoint publication is incomplete.",
      );
    await git(
      stage,
      [
        "fetch",
        "--atomic",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        remote,
        ...LAYERS.map(
          (name) =>
            `${remoteRef(input.manifest, name)}:${input.manifest[name].ref}`,
        ),
      ],
      options,
    );
    await verifyCheckpoint({ ...input, repositoryPath: stage });
    const localRefs = readRefs(
      await gitText(
        input.repositoryPath,
        [
          "for-each-ref",
          "--format=%(objectname) %(refname)",
          ...LAYERS.map((name) => input.manifest[name].ref),
        ],
        options,
      ),
    );
    const missing = missingLayers(input, localRefs, false);
    if (missing.length) {
      const bundle = path.join(context.temp, "checkpoint.bundle");
      await git(
        stage,
        [
          "bundle",
          "create",
          bundle,
          ...LAYERS.map((name) => input.manifest[name].ref),
        ],
        options,
      );
      await git(input.repositoryPath, ["bundle", "unbundle", bundle], options);
      await git(input.repositoryPath, ["update-ref", "--stdin"], {
        ...options,
        input: `start\n${missing.map((name) => `create ${input.manifest[name].ref} ${input.manifest[name].commit}\n`).join("")}prepare\ncommit\n`,
      });
    }
    await verifyCheckpoint(input);
    return receipt(input, missing.length > 0);
  } finally {
    await fs.rm(context.temp, { recursive: true, force: true });
  }
}
