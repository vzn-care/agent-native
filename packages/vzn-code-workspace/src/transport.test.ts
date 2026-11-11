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
  publishCheckpoint,
  fetchCheckpoint,
} from "./index.ts";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgSign=false", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "vzn-private-transfer-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const source = path.join(dir, "source");
  const target = path.join(dir, "target");
  const remotePath = path.join(dir, "private.git");
  const origin = path.join(dir, "origin.git");
  await fs.mkdir(source);
  git(source, "init", "-b", "task");
  git(source, "config", "user.name", "Test");
  git(source, "config", "user.email", "test@example.invalid");
  await fs.writeFile(path.join(source, "file.txt"), "base\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "base");
  git(dir, "clone", "--no-local", source, target);
  git(dir, "init", "--bare", remotePath);
  git(dir, "init", "--bare", origin);
  git(source, "remote", "add", "origin", origin);
  await fs.writeFile(path.join(source, "file.txt"), "staged\n");
  git(source, "add", "file.txt");
  await fs.writeFile(path.join(source, "file.txt"), "unstaged\n");
  await fs.writeFile(
    path.join(source, "untracked.bin"),
    Buffer.from([0, 255, 13, 10]),
  );
  const manifest = await captureCheckpoint({
    repositoryPath: source,
    projectId: "project",
    repositoryId: "repository",
    writersPaused: true,
  });
  const remote = {
    kind: "local" as const,
    repositoryPath: remotePath,
    projectId: "project",
    repositoryId: "repository",
  };
  const input = {
    repositoryPath: source,
    manifest,
    expectedDigest: checkpointDigest(manifest),
    remote,
  };
  return { dir, source, target, remotePath, origin, input };
}

test("explicit private publication and fetch are idempotent and restore exact unfinished state without touching origin", async (t) => {
  const { dir, source, target, remotePath, origin, input } = await fixture(t);
  const sourceHead = git(source, "rev-parse", "HEAD");
  const sourceIndex = await fs.readFile(path.join(source, ".git", "index"));
  const targetHead = git(target, "rev-parse", "HEAD");
  const targetIndex = await fs.readFile(path.join(target, ".git", "index"));
  git(source, "config", `url.${origin}.pushInsteadOf`, remotePath);
  git(target, "config", `url.${origin}.insteadOf`, remotePath);
  assert.equal((await publishCheckpoint(input)).state, "transferred");
  assert.equal((await publishCheckpoint(input)).state, "already-present");
  const refs = git(remotePath, "for-each-ref", "--format=%(refname)").split(
    "\n",
  );
  assert.deepEqual(
    refs,
    ["index", "tracked", "untracked"].map(
      (layer) => `refs/heads/handoff/${input.manifest.checkpointId}/${layer}`,
    ),
  );
  assert.equal(
    (await fetchCheckpoint({ ...input, repositoryPath: target })).state,
    "transferred",
  );
  assert.equal(
    (await fetchCheckpoint({ ...input, repositoryPath: target })).state,
    "already-present",
  );
  const restored = path.join(dir, "restored");
  await restoreCheckpoint({
    ...input,
    repositoryPath: target,
    destinationPath: restored,
  });
  assert.equal(git(restored, "show", ":file.txt"), "staged");
  assert.equal(
    await fs.readFile(path.join(restored, "file.txt"), "utf8"),
    "unstaged\n",
  );
  assert.deepEqual(
    await fs.readFile(path.join(restored, "untracked.bin")),
    Buffer.from([0, 255, 13, 10]),
  );
  assert.equal(
    git(restored, "status", "--porcelain=v1"),
    git(source, "status", "--porcelain=v1"),
  );
  assert.equal(git(source, "rev-parse", "HEAD"), sourceHead);
  assert.equal(git(target, "rev-parse", "HEAD"), targetHead);
  assert.deepEqual(
    await fs.readFile(path.join(source, ".git", "index")),
    sourceIndex,
  );
  assert.deepEqual(
    await fs.readFile(path.join(target, ".git", "index")),
    targetIndex,
  );
  assert.equal(git(source, "branch", "--show-current"), "task");
  assert.equal(git(origin, "for-each-ref"), "");
  assert.equal(git(source, "remote", "get-url", "origin"), origin);
});

test("binding, digest and immutable-ref mismatches fail before accepting checkpoint refs", async (t) => {
  const { target, remotePath, input } = await fixture(t);
  await assert.rejects(
    publishCheckpoint({
      ...input,
      remote: { ...input.remote, projectId: "different-project" },
    }),
    /binding/,
  );
  await assert.rejects(
    publishCheckpoint({ ...input, expectedDigest: "0".repeat(64) }),
    /binding or digest/,
  );
  assert.equal(git(remotePath, "for-each-ref"), "");
  await publishCheckpoint(input);
  const ref = `refs/heads/handoff/${input.manifest.checkpointId}/tracked`;
  git(remotePath, "update-ref", ref, input.manifest.baseHead);
  await assert.rejects(publishCheckpoint(input), /different object identity/);
  await assert.rejects(
    fetchCheckpoint({ ...input, repositoryPath: target }),
    /different object identity/,
  );
  assert.equal(git(remotePath, "rev-parse", ref), input.manifest.baseHead);
  assert.equal(git(target, "for-each-ref", "refs/vzn-code"), "");
  git(remotePath, "update-ref", ref, input.manifest.tracked.commit);
  git(
    remotePath,
    "update-ref",
    "-d",
    `refs/heads/handoff/${input.manifest.checkpointId}/untracked`,
  );
  await assert.rejects(
    fetchCheckpoint({ ...input, repositoryPath: target }),
    /incomplete/,
  );
  assert.equal(git(target, "for-each-ref", "refs/vzn-code"), "");
  await publishCheckpoint(input);
  git(target, "update-ref", input.manifest.index.ref, input.manifest.baseHead);
  await assert.rejects(
    fetchCheckpoint({ ...input, repositoryPath: target }),
    /different object identity/,
  );
  assert.equal(
    git(target, "rev-parse", input.manifest.index.ref),
    input.manifest.baseHead,
  );
});

test("checkpoint publication refuses the normal origin even when explicitly supplied as transport", async (t) => {
  const { origin, input } = await fixture(t);
  await assert.rejects(
    publishCheckpoint({
      ...input,
      remote: { ...input.remote, repositoryPath: origin },
    }),
    /normal origin/,
  );
  assert.equal(git(origin, "for-each-ref"), "");
});

test("interrupted private fetch leaves the target branch, index and retained refs unchanged", async (t) => {
  const { target, input } = await fixture(t);
  await publishCheckpoint(input);
  const head = git(target, "rev-parse", "HEAD");
  const index = await fs.readFile(path.join(target, ".git", "index"));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20);
  try {
    await assert.rejects(
      fetchCheckpoint({
        ...input,
        repositoryPath: target,
        signal: controller.signal,
      }),
      /abort/i,
    );
  } finally {
    clearTimeout(timer);
  }
  assert.equal(git(target, "rev-parse", "HEAD"), head);
  assert.deepEqual(
    await fs.readFile(path.join(target, ".git", "index")),
    index,
  );
  assert.equal(git(target, "for-each-ref", "refs/vzn-code"), "");
  assert.equal(
    (await fetchCheckpoint({ ...input, repositoryPath: target })).state,
    "transferred",
  );
});
