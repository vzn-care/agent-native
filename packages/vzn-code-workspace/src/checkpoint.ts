import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CheckpointError } from "./errors.ts";
import { git, gitText } from "./git.ts";

export type FileMode = "100644" | "100755" | "120000";
export interface CheckpointFile {
  path: string;
  mode: FileMode;
  objectId: string;
  sha256: string;
  size: number;
}
export interface CheckpointLayer {
  tree: string;
  commit: string;
  ref: string;
  files: CheckpointFile[];
}
export interface CheckpointManifest {
  schemaVersion: 1;
  checkpointId: string;
  projectId: string;
  repositoryId: string;
  sourceBranch: string | null;
  baseHead: string;
  objectFormat: "sha1" | "sha256";
  index: CheckpointLayer;
  tracked: CheckpointLayer;
  untracked: CheckpointLayer;
  excludedUntracked: string[];
  environmentRecipeDigest: string | null;
  taskId: string | null;
  sessionId: string | null;
  requiredCapabilities: string[];
}
export interface CheckpointPolicy {
  /** Additional repository-relative paths or directory prefixes to deny. */
  secretPaths?: string[];
  /** Additional untracked paths or directory prefixes to omit. */
  excludedPaths?: string[];
  /** Exact ignored files required by the application, never secret paths. */
  includeIgnoredPaths?: string[];
}
export { CheckpointError } from "./errors.ts";
const LAYERS = ["index", "tracked", "untracked"] as const;
const MAX_OUTPUT = 64 * 1024 * 1024;

function digest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function splitNull(bytes: Buffer): string[] {
  const decoded = bytes.toString("utf8");
  if (!Buffer.from(decoded).equals(bytes))
    throw new CheckpointError("Non-UTF-8 paths are unsupported.");
  return decoded.split("\0").filter(Boolean);
}
function assertPath(value: string): void {
  if (
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git" ||
          /[:]/.test(part),
      )
  ) {
    throw new CheckpointError(
      "Checkpoint contains an unsafe or unsupported path.",
    );
  }
}
function matchesPath(file: string, paths: string[] = []): boolean {
  return paths.some(
    (entry) =>
      file === entry || file.startsWith(`${entry.replace(/\/$/, "")}/`),
  );
}
function isSecret(file: string, policy: CheckpointPolicy): boolean {
  return (
    matchesPath(file, policy.secretPaths) ||
    file
      .split("/")
      .some(
        (part) =>
          /^\.env(?:\.|$)/i.test(part) ||
          /\.(pem|key|p12|pfx)$/i.test(part) ||
          /^(?:\.npmrc|\.netrc|credentials(?:\.json)?|id_rsa|id_ed25519)$/i.test(
            part,
          ),
      )
  );
}
function isExcluded(file: string, policy: CheckpointPolicy): boolean {
  return (
    isSecret(file, policy) ||
    matchesPath(file, policy.excludedPaths) ||
    file
      .split("/")
      .some((part) =>
        /^(node_modules|dist|build|coverage|\.cache|\.next|\.vzn-code)$/.test(
          part,
        ),
      ) ||
    /\.log$/i.test(file)
  );
}
function assertFileSet(files: { path: string }[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    assertPath(file.path);
    const key = file.path.normalize("NFC").toLowerCase();
    if (seen.has(key))
      throw new CheckpointError("Checkpoint contains colliding paths.");
    seen.add(key);
  }
  for (const file of files) {
    const parts = file.path.normalize("NFC").toLowerCase().split("/");
    parts.pop();
    while (parts.length) {
      if (seen.has(parts.join("/")))
        throw new CheckpointError(
          "Checkpoint contains file/directory collisions.",
        );
      parts.pop();
    }
  }
}
interface TreeEntry {
  path: string;
  mode: FileMode;
  objectId: string;
}
function parseEntries(bytes: Buffer, index: boolean): TreeEntry[] {
  return splitNull(bytes).map((record) => {
    const tab = record.indexOf("\t");
    const [mode, second, third] = record.slice(0, tab).split(" ");
    if (tab < 0 || !mode || !["100644", "100755", "120000"].includes(mode)) {
      throw new CheckpointError(
        "Submodules and unsupported file modes cannot be checkpointed.",
      );
    }
    if (index && third !== "0")
      throw new CheckpointError(
        "Unresolved index conflicts block checkpoint capture.",
      );
    const objectId = index ? second : third;
    if (!objectId || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(objectId))
      throw new CheckpointError(
        "Git returned an invalid checkpoint object identity.",
      );
    const file = {
      path: record.slice(tab + 1),
      mode: mode as FileMode,
      objectId,
    };
    assertPath(file.path);
    return file;
  });
}
async function treeEntries(
  root: string,
  tree: string,
  signal?: AbortSignal,
): Promise<TreeEntry[]> {
  return parseEntries(
    await git(root, ["ls-tree", "-r", "-z", tree], { signal }),
    false,
  );
}
async function fileFromBlob(
  root: string,
  entry: TreeEntry,
  signal?: AbortSignal,
): Promise<CheckpointFile> {
  const bytes = await git(root, ["cat-file", "blob", entry.objectId], {
    signal,
  });
  if (
    bytes
      .subarray(0, 100)
      .toString()
      .startsWith("version https://git-lfs.github.com/spec/v1")
  ) {
    throw new CheckpointError("Git LFS content is unsupported.");
  }
  return { ...entry, sha256: digest(bytes), size: bytes.length };
}
async function fileFromDisk(
  root: string,
  file: string,
  signal?: AbortSignal,
): Promise<CheckpointFile | null> {
  assertPath(file);
  const full = path.join(root, file);
  let stat;
  try {
    const segments = file.split("/");
    segments.pop();
    let parent = root;
    for (const segment of segments) {
      parent = path.join(parent, segment);
      if (!(await fs.lstat(parent)).isDirectory())
        throw new CheckpointError(
          "Symlink directory traversal is unsupported.",
        );
    }
    stat = await fs.lstat(full);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() && !stat.isSymbolicLink())
    throw new CheckpointError(
      "Nested repositories and non-file entries are unsupported.",
    );
  if (stat.size > MAX_OUTPUT)
    throw new CheckpointError("A file exceeds the checkpoint byte limit.");
  const bytes = stat.isSymbolicLink()
    ? await fs.readlink(full, { encoding: "buffer" })
    : await fs.readFile(full);
  if (
    stat.isSymbolicLink() &&
    !Buffer.from(bytes.toString("utf8")).equals(bytes)
  )
    throw new CheckpointError("Non-UTF-8 symlink targets are unsupported.");
  if (
    bytes
      .subarray(0, 100)
      .toString()
      .startsWith("version https://git-lfs.github.com/spec/v1")
  ) {
    throw new CheckpointError("Git LFS content is unsupported.");
  }
  const mode: FileMode = stat.isSymbolicLink()
    ? "120000"
    : stat.mode & 0o111
      ? "100755"
      : "100644";
  const objectId = await gitText(
    root,
    ["hash-object", "-w", "--stdin", "--no-filters"],
    { input: bytes, signal },
  );
  return {
    path: file,
    mode,
    objectId,
    sha256: digest(bytes),
    size: bytes.length,
  };
}
async function makeTree(
  root: string,
  files: CheckpointFile[],
  indexFile: string,
  signal?: AbortSignal,
): Promise<string> {
  const options = { indexFile, signal };
  await git(root, ["read-tree", "--empty"], options);
  await git(root, ["update-index", "-z", "--index-info"], {
    ...options,
    input: files
      .map((file) => `${file.mode} ${file.objectId}\t${file.path}\0`)
      .join(""),
  });
  return await gitText(root, ["write-tree"], options);
}
async function inspect(
  root: string,
  policy: CheckpointPolicy,
  temp: string,
  signal?: AbortSignal,
) {
  const baseHead = await gitText(root, ["rev-parse", "--verify", "HEAD"], {
    signal,
  });
  const sourceBranch = await gitText(root, ["branch", "--show-current"], {
    signal,
  });
  const indexBytes = await git(root, ["ls-files", "--stage", "-z"], { signal });
  const entries = parseEntries(indexBytes, true);
  const flags = splitNull(
    await git(root, ["ls-files", "-v", "-z"], { signal }),
  );
  if (flags.some((file) => !file.startsWith("H ")))
    throw new CheckpointError(
      "Sparse and assume-unchanged indexes are unsupported.",
    );
  const debug = await gitText(root, ["ls-files", "--debug"], { signal });
  if (
    [...debug.matchAll(/flags: ([0-9a-f]+)/g)].some((match) => {
      if (!match[1])
        throw new CheckpointError("Git returned invalid index flags.");
      return (parseInt(match[1], 16) & 0x20000000) !== 0;
    })
  ) {
    throw new CheckpointError("Intent-to-add index entries are unsupported.");
  }
  const baseEntries = await treeEntries(root, baseHead, signal);
  for (const entry of [...baseEntries, ...entries]) {
    if (isSecret(entry.path, policy))
      throw new CheckpointError(
        "A tracked file violates the checkpoint secret policy.",
      );
    if (path.posix.basename(entry.path) === ".gitmodules")
      throw new CheckpointError("Submodules are unsupported.");
  }
  // Inspect base blobs too: staged removal must not hide LFS content retained by base HEAD.
  for (const entry of baseEntries) await fileFromBlob(root, entry, signal);
  const index: CheckpointFile[] = [];
  const tracked: CheckpointFile[] = [];
  for (const entry of entries) {
    index.push(await fileFromBlob(root, entry, signal));
    const disk = await fileFromDisk(root, entry.path, signal);
    if (disk) tracked.push(disk);
  }
  const candidates = new Set(
    splitNull(
      await git(root, ["ls-files", "--others", "--exclude-standard", "-z"], {
        signal,
      }),
    ),
  );
  for (const file of policy.includeIgnoredPaths ?? []) {
    assertPath(file);
    if (isSecret(file, policy))
      throw new CheckpointError(
        "An explicitly included file violates the secret policy.",
      );
    if (!entries.some((entry) => entry.path === file)) candidates.add(file);
  }
  const untracked: CheckpointFile[] = [];
  const excludedUntracked: string[] = [];
  for (const file of [...candidates].sort()) {
    assertPath(file);
    if (isExcluded(file, policy)) {
      excludedUntracked.push(file);
      continue;
    }
    const disk = await fileFromDisk(root, file, signal);
    if (!disk)
      throw new CheckpointError("An untracked file changed during capture.");
    untracked.push(disk);
  }
  assertFileSet(index);
  assertFileSet([...tracked, ...untracked]);
  return {
    baseHead,
    sourceBranch: sourceBranch || null,
    index,
    tracked,
    untracked,
    excludedUntracked,
    indexTree: await makeTree(root, index, path.join(temp, "index"), signal),
    trackedTree: await makeTree(
      root,
      tracked,
      path.join(temp, "tracked"),
      signal,
    ),
    untrackedTree: await makeTree(
      root,
      untracked,
      path.join(temp, "untracked"),
      signal,
    ),
    indexDigest: digest(indexBytes),
  };
}

export async function captureCheckpoint(input: {
  repositoryPath: string;
  projectId: string;
  repositoryId: string;
  writersPaused: true;
  checkpointId?: string;
  policy?: CheckpointPolicy;
  environmentRecipeDigest?: string;
  taskId?: string;
  sessionId?: string;
  signal?: AbortSignal;
}): Promise<CheckpointManifest> {
  if (input.writersPaused !== true)
    throw new CheckpointError("Managed writers must be paused before capture.");
  const checkpointId = input.checkpointId ?? randomUUID();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(checkpointId))
    throw new CheckpointError("Invalid checkpoint identity.");
  if (!input.projectId || !input.repositoryId)
    throw new CheckpointError(
      "Project and repository identities are required.",
    );
  const root = await gitText(
    input.repositoryPath,
    ["rev-parse", "--show-toplevel"],
    { signal: input.signal },
  );
  const objectFormat = await gitText(
    root,
    ["rev-parse", "--show-object-format"],
    { signal: input.signal },
  );
  if (objectFormat !== "sha1" && objectFormat !== "sha256")
    throw new CheckpointError("Unsupported Git object format.");
  const temp = await fs.mkdtemp(path.join(tmpdir(), "vzn-checkpoint-"));
  try {
    const first = await inspect(root, input.policy ?? {}, temp, input.signal);
    const second = await inspect(root, input.policy ?? {}, temp, input.signal);
    if (JSON.stringify(first) !== JSON.stringify(second))
      throw new CheckpointError(
        "Source changed during checkpoint capture; pause writers and retry.",
      );
    const layers = {} as Record<(typeof LAYERS)[number], CheckpointLayer>;
    for (const name of LAYERS) {
      const tree = first[`${name}Tree`];
      const commit = await gitText(
        root,
        [
          "-c",
          "commit.gpgSign=false",
          "commit-tree",
          tree,
          "-p",
          first.baseHead,
        ],
        {
          input: `VZN checkpoint ${checkpointId} ${name}\n`,
          signal: input.signal,
        },
      );
      layers[name] = {
        tree,
        commit,
        ref: `refs/vzn-code/checkpoints/${checkpointId}/${name}`,
        files: first[name],
      };
    }
    const manifest: CheckpointManifest = {
      schemaVersion: 1,
      checkpointId,
      projectId: input.projectId,
      repositoryId: input.repositoryId,
      sourceBranch: first.sourceBranch,
      baseHead: first.baseHead,
      objectFormat,
      ...layers,
      excludedUntracked: first.excludedUntracked,
      environmentRecipeDigest: input.environmentRecipeDigest ?? null,
      taskId: input.taskId ?? null,
      sessionId: input.sessionId ?? null,
      requiredCapabilities: [
        `git:${objectFormat}`,
        ...([...first.index, ...first.tracked, ...first.untracked].some(
          (file) => file.mode === "120000",
        )
          ? ["filesystem:symlinks"]
          : []),
        ...([...first.index, ...first.tracked, ...first.untracked].some(
          (file) => file.mode === "100755",
        )
          ? ["filesystem:executable-bits"]
          : []),
      ],
    };
    input.signal?.throwIfAborted();
    // The publication transaction is the non-cancellable commit point; it creates all refs or none.
    await git(root, ["update-ref", "--stdin"], {
      input: `start\n${LAYERS.map((name) => `create ${layers[name].ref} ${layers[name].commit}\n`).join("")}prepare\ncommit\n`,
    });
    return manifest;
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

/** Pin this digest in the trusted host journal before accepting a transferred manifest. */
export function checkpointDigest(manifest: CheckpointManifest): string {
  return digest(JSON.stringify(manifest));
}

export async function verifyCheckpoint(input: {
  repositoryPath: string;
  manifest: CheckpointManifest;
  expectedDigest: string;
  policy?: CheckpointPolicy;
  signal?: AbortSignal;
}): Promise<void> {
  const { manifest: m, repositoryPath: root, signal } = input;
  if (
    m.schemaVersion !== 1 ||
    checkpointDigest(m) !== input.expectedDigest ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(m.checkpointId)
  ) {
    throw new CheckpointError(
      "Checkpoint manifest integrity verification failed.",
    );
  }
  const format = await gitText(root, ["rev-parse", "--show-object-format"], {
    signal,
  });
  if (format !== m.objectFormat)
    throw new CheckpointError("Git object format mismatch.");
  const idPattern = new RegExp(`^[a-f0-9]{${format === "sha256" ? 64 : 40}}$`);
  if (!idPattern.test(m.baseHead))
    throw new CheckpointError("Invalid base object identity.");
  await git(root, ["cat-file", "-e", `${m.baseHead}^{commit}`], { signal });
  for (const entry of await treeEntries(root, m.baseHead, signal)) {
    if (isSecret(entry.path, input.policy ?? {}))
      throw new CheckpointError("Tracked content violates the secret policy.");
    if (path.posix.basename(entry.path) === ".gitmodules")
      throw new CheckpointError("Submodules are unsupported.");
    await fileFromBlob(root, entry, signal);
  }
  for (const name of LAYERS) {
    const layer = m[name];
    if (
      !idPattern.test(layer.tree) ||
      !idPattern.test(layer.commit) ||
      layer.ref !== `refs/vzn-code/checkpoints/${m.checkpointId}/${name}`
    ) {
      throw new CheckpointError("Invalid checkpoint object identity.");
    }
    if (
      (await gitText(root, ["rev-parse", "--verify", layer.ref], {
        signal,
      })) !== layer.commit ||
      (await gitText(root, ["rev-parse", `${layer.commit}^{tree}`], {
        signal,
      })) !== layer.tree ||
      (await gitText(root, ["rev-list", "--parents", "-n", "1", layer.commit], {
        signal,
      })) !== `${layer.commit} ${m.baseHead}`
    ) {
      throw new CheckpointError(
        "Checkpoint refs, trees, or parents do not match the manifest.",
      );
    }
    assertFileSet(layer.files);
    const entries = await treeEntries(root, layer.tree, signal);
    if (entries.length !== layer.files.length)
      throw new CheckpointError(
        "Checkpoint file inventory does not match its tree.",
      );
    for (const entry of entries) {
      if (isSecret(entry.path, input.policy ?? {}))
        throw new CheckpointError(
          "Checkpoint content violates the secret policy.",
        );
      const expected = layer.files.find((file) => file.path === entry.path);
      const actual = await fileFromBlob(root, entry, signal);
      if (
        !expected ||
        expected.objectId !== actual.objectId ||
        expected.mode !== actual.mode ||
        expected.size !== actual.size ||
        expected.sha256 !== actual.sha256
      ) {
        throw new CheckpointError(
          "Checkpoint file integrity verification failed.",
        );
      }
    }
  }
  assertFileSet([...m.tracked.files, ...m.untracked.files]);
  const indexedPaths = new Set(m.index.files.map((file) => file.path));
  if (
    m.tracked.files.some((file) => !indexedPaths.has(file.path)) ||
    m.untracked.files.some((file) => indexedPaths.has(file.path))
  ) {
    throw new CheckpointError(
      "Checkpoint tracked/untracked classification does not match its index.",
    );
  }
}

export async function restoreCheckpoint(input: {
  repositoryPath: string;
  destinationPath: string;
  manifest: CheckpointManifest;
  expectedDigest: string;
  policy?: CheckpointPolicy;
  signal?: AbortSignal;
}): Promise<{
  workspacePath: string;
  baseHead: string;
  sourceBranch: string | null;
}> {
  await verifyCheckpoint(input);
  const destination = path.resolve(input.destinationPath);
  try {
    await fs.lstat(destination);
    throw new CheckpointError(
      "Restore destination already exists; existing work is never overwritten.",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const root = await fs.realpath(
    await gitText(input.repositoryPath, ["rev-parse", "--show-toplevel"], {
      signal: input.signal,
    }),
  );
  const parent = await fs.realpath(path.dirname(destination));
  const workspacePath = path.join(parent, path.basename(destination));
  if (workspacePath === root || workspacePath.startsWith(`${root}${path.sep}`))
    throw new CheckpointError(
      "Restore requires a separate isolated directory.",
    );
  // Reserve the directory exclusively so a racing caller cannot claim the target between checks.
  await fs.mkdir(workspacePath);
  let registered = false;
  try {
    await git(
      root,
      [
        "worktree",
        "add",
        "--detach",
        "--no-checkout",
        workspacePath,
        input.manifest.baseHead,
      ],
      { signal: input.signal },
    );
    registered = true;
    for (const file of [
      ...input.manifest.tracked.files,
      ...input.manifest.untracked.files,
    ]) {
      input.signal?.throwIfAborted();
      const full = path.join(workspacePath, file.path);
      await fs.mkdir(path.dirname(full), { recursive: true });
      const bytes = await git(root, ["cat-file", "blob", file.objectId], {
        signal: input.signal,
      });
      if (file.mode === "120000")
        await fs.symlink(bytes.toString("utf8"), full);
      else {
        await fs.writeFile(full, bytes, {
          flag: "wx",
          mode: file.mode === "100755" ? 0o755 : 0o644,
        });
        await fs.chmod(full, file.mode === "100755" ? 0o755 : 0o644);
      }
    }
    await git(workspacePath, ["read-tree", input.manifest.index.tree], {
      signal: input.signal,
    });
    for (const file of [
      ...input.manifest.tracked.files,
      ...input.manifest.untracked.files,
    ]) {
      const restored = await fileFromDisk(
        workspacePath,
        file.path,
        input.signal,
      );
      if (
        !restored ||
        restored.objectId !== file.objectId ||
        restored.mode !== file.mode
      )
        throw new CheckpointError(
          "Restored filesystem content does not match the checkpoint.",
        );
    }
    if (
      (await gitText(workspacePath, ["write-tree"], {
        signal: input.signal,
      })) !== input.manifest.index.tree
    )
      throw new CheckpointError(
        "Restored index does not match the checkpoint.",
      );
    return {
      workspacePath,
      baseHead: input.manifest.baseHead,
      sourceBranch: input.manifest.sourceBranch,
    };
  } catch (error) {
    const worktrees = splitNull(
      await git(root, ["worktree", "list", "--porcelain", "-z"]),
    );
    if (registered || worktrees.includes(`worktree ${workspacePath}`))
      await git(root, ["worktree", "remove", "--force", workspacePath]);
    else await fs.rm(workspacePath, { recursive: true, force: true });
    throw error;
  }
}
