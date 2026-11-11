import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  captureCheckpoint,
  checkpointDigest,
  restoreCheckpoint,
  verifyCheckpoint,
} from "./checkpoint.ts";

function git(root: string, ...args: string[]): Buffer {
  return execFileSync("git", ["-c", "commit.gpgSign=false", ...args], {
    cwd: root,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "vzn-checkpoint-test-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const source = path.join(dir, "source");
  await fs.mkdir(source);
  git(source, "init", "-b", "task");
  git(source, "config", "user.name", "Checkpoint test");
  git(source, "config", "user.email", "test@example.invalid");
  git(source, "config", "core.autocrlf", "false");
  for (const file of [
    "both.txt",
    "staged-delete.txt",
    "unstaged-delete.txt",
    "recreated.txt",
    "binary.bin",
    "executable.sh",
  ]) {
    await fs.writeFile(path.join(source, file), `original ${file}\n`);
  }
  await fs.writeFile(path.join(source, ".gitignore"), "ignored.txt\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "base");
  return { dir, source, target: path.join(dir, "restored") };
}
async function sourceState(root: string) {
  return {
    head: git(root, "rev-parse", "HEAD").toString(),
    index: await fs.readFile(path.join(root, ".git", "index")),
    staged: git(root, "diff", "--cached", "--binary"),
    unstaged: git(root, "diff", "--binary"),
    status: git(
      root,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ),
    remotes: git(root, "remote", "-v"),
  };
}
const metadata = {
  projectId: "project-test",
  repositoryId: "repository-test",
  writersPaused: true as const,
};

test("checkpoint restores independent index and working bytes, deletions, binary, modes, symlinks and untracked files", async (t) => {
  const { source, target } = await fixture(t);
  await fs.writeFile(path.join(source, "both.txt"), "staged content\n");
  await fs.writeFile(path.join(source, "staged-new.txt"), "staged new\n");
  git(source, "add", "both.txt", "staged-new.txt");
  await fs.writeFile(path.join(source, "both.txt"), "unstaged content\r\n");
  await fs.writeFile(path.join(source, "staged-new.txt"), "unstaged new\n");
  git(source, "rm", "staged-delete.txt", "recreated.txt");
  await fs.writeFile(
    path.join(source, "recreated.txt"),
    "untracked recreation\n",
  );
  await fs.unlink(path.join(source, "unstaged-delete.txt"));
  const binary = Buffer.from([0, 255, 1, 128, 13, 10, 0]);
  await fs.writeFile(path.join(source, "binary.bin"), Buffer.from([0, 2, 255]));
  git(source, "add", "binary.bin");
  await fs.writeFile(path.join(source, "binary.bin"), binary);
  await fs.writeFile(path.join(source, "untracked binary.bin"), binary);
  await fs.writeFile(
    path.join(source, "odd\nname.txt"),
    "untracked newline path\n",
  );
  await fs.chmod(path.join(source, "executable.sh"), 0o755);
  await fs.symlink("both.txt", path.join(source, "link"));
  await fs.writeFile(path.join(source, ".env.local"), "FAKE_SETTING=example\n");
  await fs.writeFile(path.join(source, "ignored.txt"), "explicitly included\n");
  const before = await sourceState(source);
  const manifest = await captureCheckpoint({
    ...metadata,
    repositoryPath: source,
    policy: { includeIgnoredPaths: ["ignored.txt"] },
  });
  assert.deepEqual(await sourceState(source), before);
  assert.deepEqual(manifest.excludedUntracked, [".env.local"]);
  assert.equal(manifest.sourceBranch, "task");
  await restoreCheckpoint({
    repositoryPath: source,
    destinationPath: target,
    manifest,
    expectedDigest: checkpointDigest(manifest),
  });
  assert.equal(git(target, "rev-parse", "HEAD").toString(), before.head);
  assert.deepEqual(git(target, "diff", "--cached", "--binary"), before.staged);
  assert.deepEqual(git(target, "diff", "--binary"), before.unstaged);
  const expectedStatus = before.status
    .toString()
    .replace("?? .env.local\0", "");
  assert.equal(
    git(
      target,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ).toString(),
    expectedStatus,
  );
  assert.deepEqual(await fs.readFile(path.join(target, "binary.bin")), binary);
  assert.deepEqual(
    await fs.readFile(path.join(target, "untracked binary.bin")),
    binary,
  );
  assert.equal(
    await fs.readFile(path.join(target, "odd\nname.txt"), "utf8"),
    "untracked newline path\n",
  );
  assert.equal(
    await fs.readFile(path.join(target, "ignored.txt"), "utf8"),
    "explicitly included\n",
  );
  assert.equal(await fs.readlink(path.join(target, "link")), "both.txt");
  await assert.rejects(fs.lstat(path.join(target, ".env.local")), {
    code: "ENOENT",
  });
  assert.deepEqual(await sourceState(source), before);
  assert.equal(
    git(source, "branch", "--show-current").toString().trim(),
    "task",
  );
  assert.equal(
    git(source, "for-each-ref", "--format=%(refname)", "refs/heads").toString(),
    "refs/heads/task\n",
  );
});

test("checkpoint objects survive exact-ref transfer to another clone and garbage collection", async (t) => {
  const { source, dir, target } = await fixture(t);
  await fs.writeFile(path.join(source, "both.txt"), "unpublished commit\n");
  git(source, "commit", "-am", "unpublished");
  await fs.writeFile(path.join(source, "both.txt"), "unfinished\n");
  const manifest = await captureCheckpoint({
    ...metadata,
    repositoryPath: source,
  });
  git(source, "gc", "--prune=now");
  const clone = path.join(dir, "clone");
  git(dir, "clone", "--no-local", source, clone);
  for (const layer of [manifest.index, manifest.tracked, manifest.untracked])
    git(clone, "fetch", source, `${layer.ref}:${layer.ref}`);
  await restoreCheckpoint({
    repositoryPath: clone,
    destinationPath: target,
    manifest,
    expectedDigest: checkpointDigest(manifest),
  });
  assert.equal(
    git(target, "rev-parse", "HEAD").toString().trim(),
    manifest.baseHead,
  );
  assert.equal(
    await fs.readFile(path.join(target, "both.txt"), "utf8"),
    "unfinished\n",
  );
  assert.equal(
    git(target, "show", "HEAD:both.txt").toString(),
    "unpublished commit\n",
  );
});

test("manifest tampering, missing objects and moved refs cannot activate a checkpoint", async (t) => {
  const { source, target } = await fixture(t);
  const manifest = await captureCheckpoint({
    ...metadata,
    repositoryPath: source,
  });
  const expectedDigest = checkpointDigest(manifest);
  const corrupted = structuredClone(manifest);
  const corruptedFile = corrupted.tracked.files[0];
  assert.ok(corruptedFile);
  corruptedFile.sha256 = "0".repeat(64);
  await assert.rejects(
    restoreCheckpoint({
      repositoryPath: source,
      destinationPath: target,
      manifest: corrupted,
      expectedDigest,
    }),
    /integrity/,
  );
  await assert.rejects(
    verifyCheckpoint({
      repositoryPath: source,
      manifest: corrupted,
      expectedDigest: checkpointDigest(corrupted),
    }),
    /file integrity/,
  );
  git(source, "update-ref", manifest.tracked.ref, manifest.baseHead);
  await assert.rejects(
    restoreCheckpoint({
      repositoryPath: source,
      destinationPath: target,
      manifest,
      expectedDigest,
    }),
    /do not match/,
  );
  git(source, "update-ref", manifest.tracked.ref, manifest.tracked.commit);
  git(source, "update-ref", "-d", manifest.untracked.ref);
  await assert.rejects(
    verifyCheckpoint({ repositoryPath: source, manifest, expectedDigest }),
  );
  await assert.rejects(fs.lstat(target), { code: "ENOENT" });
});

test("capture rejects conflicts, secret files, LFS, submodules and intent-to-add without changing the source", async (t) => {
  const cases = ["conflict", "secret", "lfs", "submodule", "intent"] as const;
  for (const scenario of cases) {
    await t.test(scenario, async (t) => {
      const { source } = await fixture(t);
      if (scenario === "secret") {
        await fs.writeFile(path.join(source, ".env"), "FAKE_SETTING=example\n");
        git(source, "add", ".env");
      }
      if (scenario === "lfs") {
        await fs.writeFile(
          path.join(source, "pointer"),
          `version https://git-lfs.github.com/spec/v1\noid sha256:${"0".repeat(64)}\nsize 123\n`,
        );
        git(source, "add", "pointer");
      }
      if (scenario === "submodule")
        git(
          source,
          "update-index",
          "--add",
          "--cacheinfo",
          `160000,${git(source, "rev-parse", "HEAD").toString().trim()},nested`,
        );
      if (scenario === "intent") {
        await fs.writeFile(path.join(source, "intent.txt"), "intent\n");
        git(source, "add", "-N", "intent.txt");
      }
      if (scenario === "conflict") {
        git(source, "checkout", "-b", "other");
        await fs.writeFile(path.join(source, "both.txt"), "other\n");
        git(source, "commit", "-am", "other");
        git(source, "checkout", "task");
        await fs.writeFile(path.join(source, "both.txt"), "task\n");
        git(source, "commit", "-am", "task");
        assert.throws(() => git(source, "merge", "other"));
      }
      const before = await sourceState(source);
      await assert.rejects(
        captureCheckpoint({ ...metadata, repositoryPath: source }),
        /conflicts|secret policy|LFS|Submodules|Intent-to-add/,
      );
      assert.deepEqual(await sourceState(source), before);
      assert.equal(git(source, "for-each-ref", "refs/vzn-code").length, 0);
    });
  }
});

test("capture interruption and retained-ref collision leave HEAD, index and source content unchanged", async (t) => {
  const { source } = await fixture(t);
  await fs.writeFile(
    path.join(source, "large.bin"),
    Buffer.alloc(8 * 1024 * 1024, 123),
  );
  const before = await sourceState(source);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30);
  try {
    await assert.rejects(
      captureCheckpoint({
        ...metadata,
        repositoryPath: source,
        signal: controller.signal,
      }),
      /abort/i,
    );
  } finally {
    clearTimeout(timer);
  }
  assert.deepEqual(await sourceState(source), before);
  assert.equal(git(source, "for-each-ref", "refs/vzn-code").length, 0);
  const first = await captureCheckpoint({
    ...metadata,
    repositoryPath: source,
    checkpointId: "collision",
  });
  await fs.writeFile(path.join(source, "both.txt"), "new changes\n");
  const changed = await sourceState(source);
  await assert.rejects(
    captureCheckpoint({
      ...metadata,
      repositoryPath: source,
      checkpointId: "collision",
    }),
    /failed/,
  );
  assert.deepEqual(await sourceState(source), changed);
  await verifyCheckpoint({
    repositoryPath: source,
    manifest: first,
    expectedDigest: checkpointDigest(first),
  });
});

test("restore never overwrites an occupied dirty target", async (t) => {
  const { source, target } = await fixture(t);
  const manifest = await captureCheckpoint({
    ...metadata,
    repositoryPath: source,
  });
  git(source, "worktree", "add", "--detach", target, "HEAD");
  await fs.writeFile(path.join(target, "both.txt"), "keep my changes\n");
  await fs.writeFile(path.join(target, "unique.txt"), "keep untracked\n");
  await assert.rejects(
    restoreCheckpoint({
      repositoryPath: source,
      destinationPath: target,
      manifest,
      expectedDigest: checkpointDigest(manifest),
    }),
    /already exists/,
  );
  assert.equal(
    await fs.readFile(path.join(target, "both.txt"), "utf8"),
    "keep my changes\n",
  );
  assert.equal(
    await fs.readFile(path.join(target, "unique.txt"), "utf8"),
    "keep untracked\n",
  );
});

test("capture detects an external writer and publishes no partial checkpoint", async (t) => {
  const { source } = await fixture(t);
  const file = path.join(source, "both.txt");
  let writes = Promise.resolve();
  const timer = setInterval(() => {
    writes = writes.then(() => fs.appendFile(file, "external edit\n"));
  }, 2);
  try {
    await assert.rejects(
      captureCheckpoint({ ...metadata, repositoryPath: source }),
      /Source changed during/,
    );
  } finally {
    clearInterval(timer);
    await writes;
  }
  assert.equal(git(source, "for-each-ref", "refs/vzn-code").length, 0);
  assert.equal(
    git(source, "show", "HEAD:both.txt").toString(),
    "original both.txt\n",
  );
});

test("capture refuses tracked directory symlinks without reading through them", async (t) => {
  const { source, dir } = await fixture(t);
  await fs.mkdir(path.join(source, "nested"));
  await fs.writeFile(path.join(source, "nested", "file"), "tracked\n");
  git(source, "add", "nested/file");
  await fs.rm(path.join(source, "nested"), { recursive: true });
  const outside = path.join(dir, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "file"), "outside\n");
  await fs.symlink(outside, path.join(source, "nested"));
  await assert.rejects(
    captureCheckpoint({ ...metadata, repositoryPath: source }),
    /Symlink directory traversal/,
  );
  assert.equal(git(source, "for-each-ref", "refs/vzn-code").length, 0);
});

test("interrupted restore removes its partial worktree and leaves the source unchanged", async (t) => {
  const { source, target } = await fixture(t);
  const manifest = await captureCheckpoint({
    ...metadata,
    repositoryPath: source,
  });
  const before = await sourceState(source);
  const controller = new AbortController();
  let polling = Promise.resolve();
  const timer = setInterval(() => {
    polling = polling.then(async () => {
      try {
        await fs.lstat(path.join(target, ".git"));
        controller.abort();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    });
  }, 2);
  try {
    await assert.rejects(
      restoreCheckpoint({
        repositoryPath: source,
        destinationPath: target,
        manifest,
        expectedDigest: checkpointDigest(manifest),
        signal: controller.signal,
      }),
      /abort/i,
    );
  } finally {
    clearInterval(timer);
    await polling;
  }
  await assert.rejects(fs.lstat(target), { code: "ENOENT" });
  assert.deepEqual(await sourceState(source), before);
  assert.equal(
    git(source, "worktree", "list", "--porcelain").toString().includes(target),
    false,
  );
});
