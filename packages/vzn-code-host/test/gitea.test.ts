import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GiteaError } from "../../vzn-code-gitea/src/index.ts";
import type { ProjectRepository } from "../../vzn-code-gitea/src/index.ts";
import { HostGitea } from "../src/gitea.ts";
import { Journal } from "../src/journal.ts";
import { startHost } from "../src/service.ts";

function fakePublicKey(): string {
  const type = Buffer.from("ssh-ed25519");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(type.length);
  const keySize = Buffer.alloc(4);
  keySize.writeUInt32BE(32);
  return `ssh-ed25519 ${Buffer.concat([size, type, keySize, Buffer.alloc(32, 7)]).toString("base64")}`;
}

void test("repository, key, and revocation intents survive interrupted API calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vzn-gitea-host-"));
  const db = join(dir, "journal.sqlite");
  let journal = new Journal(db);
  journal.registerProject("register", {
    id: "pilot",
    root: dir,
    repository: "github.com/example/pilot-git",
  });
  let failRepository = true;
  let failKey = true;
  let failRevoke = true;
  const enrollmentIds: string[] = [];
  const keys = new Map<
    string,
    { keyId: number; publicKey: string; readOnly: boolean }
  >();
  const adapter = {
    enrollRepository: async (input: {
      enrollmentId: string;
    }): Promise<ProjectRepository> => {
      enrollmentIds.push(input.enrollmentId);
      if (failRepository) throw new GiteaError("transport");
      return {
        instanceId: "private-git",
        projectId: "pilot",
        enrollmentId: input.enrollmentId,
        repositoryId: 19,
        owner: "studio",
        name: "pilot-git",
        webUrl: "https://git.example.test/studio/pilot-git",
        cloneUrl: "https://git.example.test/studio/pilot-git.git",
      };
    },
    configureCheckpointProtection: async () => undefined,
    verifyCheckpointProtection: async () => undefined,
    ensureDeployKey: async (
      _repo: ProjectRepository,
      input: { deviceId: string; publicKey: string; readOnly: boolean },
    ) => {
      if (failKey) throw new GiteaError("transport");
      const key = {
        keyId: 23,
        publicKey: input.publicKey,
        readOnly: input.readOnly,
      };
      keys.set(input.deviceId, key);
      return {
        instanceId: "private-git",
        projectId: "pilot",
        repositoryId: 19,
        deviceId: input.deviceId,
        ...key,
      };
    },
    listDeployKeys: async () =>
      [...keys].map(([deviceId, key]) => ({
        instanceId: "private-git",
        projectId: "pilot",
        repositoryId: 19,
        deviceId,
        ...key,
      })),
    revokeDeployKey: async (
      _repo: ProjectRepository,
      key: { deviceId: string },
    ) => {
      if (failRevoke) throw new GiteaError("transport");
      keys.delete(key.deviceId);
    },
  } as ConstructorParameters<typeof HostGitea>[1];
  const host = () =>
    new HostGitea(journal, adapter, {
      instanceId: "private-git",
      owner: "studio",
      studioUsername: "studio",
    });
  try {
    await assert.rejects(host().enrollProject("pilot", "pilot-git"), {
      code: "GITEA_TRANSPORT",
    });
    const firstIntent = journal.repositoryIntent("pilot");
    assert.ok(firstIntent);
    assert.equal(firstIntent.repositoryId, null);
    journal.close();
    journal = new Journal(db);
    failRepository = false;
    await host().enrollProject("pilot");
    await assert.rejects(host().enrollProject("pilot", "other-git"), {
      code: "REPOSITORY_CONFLICT",
    });
    assert.deepEqual(enrollmentIds, [
      firstIntent.enrollmentId,
      firstIntent.enrollmentId,
    ]);
    assert.equal(journal.repositoryIntent("pilot")?.repositoryId, 19);
    assert.equal(journal.repositoryIntent("pilot")?.protectionVerified, true);
    journal.registerProject("other-register", {
      id: "other",
      root: join(dir, "other"),
      repository: "pilot-git",
    });
    await assert.rejects(host().enrollProject("other"), {
      code: "REPOSITORY_CONFLICT",
    });

    const input = {
      projectId: "pilot",
      deviceId: "child-a",
      publicKey: fakePublicKey() + " comment",
      readOnly: false,
    };
    await assert.rejects(host().ensureDeviceKey(input), {
      code: "GITEA_TRANSPORT",
    });
    assert.equal(
      journal.deployKeyIntent("pilot", "child-a")?.state,
      "enroll-intent",
    );
    failKey = false;
    await host().ensureDeviceKey(input);
    assert.equal(journal.deployKeyIntent("pilot", "child-a")?.keyId, 23);
    assert.equal(
      journal.deployKeyIntent("pilot", "child-a")?.publicKey,
      fakePublicKey(),
    );

    await assert.rejects(host().revokeDeviceKey("pilot", "child-a"), {
      code: "GITEA_TRANSPORT",
    });
    assert.equal(
      journal.deployKeyIntent("pilot", "child-a")?.state,
      "revoke-intent",
    );
    journal.close();
    journal = new Journal(db);
    failRevoke = false;
    await host().revokeDeviceKey("pilot", "child-a");
    await host().revokeDeviceKey("pilot", "child-a");
    assert.equal(journal.deployKeyIntent("pilot", "child-a")?.state, "revoked");
    await assert.rejects(host().ensureDeviceKey(input), {
      code: "DEVICE_KEY_CONFLICT",
    });

    failKey = true;
    const ambiguous = { ...input, deviceId: "child-b" };
    await assert.rejects(host().ensureDeviceKey(ambiguous), {
      code: "GITEA_TRANSPORT",
    });
    await assert.rejects(host().revokeDeviceKey("pilot", "child-b"), {
      code: "REVOCATION_UNCERTAIN",
    });
    assert.equal(
      journal.deployKeyIntent("pilot", "child-b")?.state,
      "revoke-intent",
    );
    await assert.rejects(host().ensureDeviceKey(ambiguous), {
      code: "DEVICE_KEY_CONFLICT",
    });
  } finally {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("host refuses a shared Gitea configuration file before opening IPC", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vzn-gitea-config-"));
  try {
    writeFileSync(join(dir, "gitea.json"), "{}", { mode: 0o644 });
    await assert.rejects(startHost(dir), { code: "UNSAFE_GITEA_FILE" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
