import assert from "node:assert/strict";
import { test } from "node:test";

import { GiteaAdapter, GiteaError } from "./index.ts";
import type {
  KeyIdentity,
  KeyIdentityRegistry,
  ProjectRepository,
} from "./index.ts";

function fakePublicKey(fill: number): string {
  const type = Buffer.from("ssh-ed25519");
  const typeLength = Buffer.alloc(4);
  typeLength.writeUInt32BE(type.length);
  const keyLength = Buffer.alloc(4);
  keyLength.writeUInt32BE(32);
  return `ssh-ed25519 ${Buffer.concat([typeLength, type, keyLength, Buffer.alloc(32, fill)]).toString("base64")}`;
}
const publicKey = fakePublicKey(0);
const otherKey = fakePublicKey(1);
const input = {
  projectId: "project-a",
  enrollmentId: "attempt-a",
  owner: "studio",
  name: "project-a",
  ownerType: "user" as const,
};
const repo = {
  id: 42,
  private: true,
  full_name: "studio/project-a",
  description: "vzn-code project=project-a enrollment=attempt-a",
};
const binding: ProjectRepository = {
  instanceId: "studio-a",
  projectId: "project-a",
  enrollmentId: "attempt-a",
  repositoryId: 42,
  owner: "studio",
  name: "project-a",
  webUrl: "https://git.example.test/studio/project-a",
  cloneUrl: "https://git.example.test/studio/project-a.git",
};
const deviceInput = { deviceId: "child-a", publicKey, readOnly: false };
const apiKey = {
  id: 7,
  title: "vzn-code:project-a:child-a",
  key: publicKey,
  read_only: false,
};
const keyBinding = {
  instanceId: "studio-a",
  projectId: "project-a",
  repositoryId: 42,
  deviceId: "child-a",
  keyId: 7,
  publicKey,
  readOnly: false,
};
const protectedRule = {
  rule_name: "handoff/**",
  priority: 1,
  enable_push: true,
  enable_push_whitelist: true,
  push_whitelist_usernames: ["studio"],
  push_whitelist_teams: [],
  push_whitelist_deploy_keys: false,
  enable_force_push: false,
  enable_force_push_allowlist: false,
  force_push_allowlist_deploy_keys: false,
  force_push_allowlist_usernames: [],
  force_push_allowlist_teams: [],
  enable_merge_whitelist: true,
  merge_whitelist_usernames: ["studio"],
  merge_whitelist_teams: [],
  enable_bypass_allowlist: false,
  bypass_allowlist_usernames: [],
  bypass_allowlist_teams: [],
  block_admin_merge_override: true,
  unprotected_file_patterns: "",
};

function registry(): KeyIdentityRegistry {
  const claims = new Map<string, KeyIdentity>();
  return {
    async claim(identity) {
      const old = claims.get(identity.publicKey);
      if (
        old &&
        (old.instanceId !== identity.instanceId ||
          old.projectId !== identity.projectId ||
          old.deviceId !== identity.deviceId)
      )
        return false;
      claims.set(identity.publicKey, identity);
      return true;
    },
  };
}

type Reply = { status: number; body?: unknown } | Error;
function harness(replies: Reply[], keyIdentities = registry()) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const adapter = new GiteaAdapter({
    instanceId: "studio-a",
    serviceUrl: "https://git.example.test",
    keyIdentities,
    resolveToken: async () => "FAKE_TEST_TOKEN_DO_NOT_USE",
    fetch: async (url, init) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.origin, "https://git.example.test");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.credentials, "omit");
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "token FAKE_TEST_TOKEN_DO_NOT_USE",
      );
      assert.equal(parsed.searchParams.has("token"), false);
      calls.push({
        method: init?.method ?? "GET",
        path: parsed.pathname + parsed.search,
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const reply = replies.shift();
      assert.ok(reply, "Unexpected network request");
      if (reply instanceof Error) throw reply;
      return new Response(
        reply.status === 204 ? null : JSON.stringify(reply.body),
        { status: reply.status },
      );
    },
  });
  return { adapter, calls, exhausted: () => assert.equal(replies.length, 0) };
}

function errorCode(code: string) {
  return (error: unknown) => error instanceof GiteaError && error.code === code;
}

test("creates only a private repository and persists an identity stable across retries", async () => {
  const h = harness([
    { status: 404 },
    { status: 200, body: { login: "studio" } },
    { status: 201, body: repo },
    { status: 200, body: repo },
    { status: 200, body: repo },
  ]);
  assert.deepEqual(await h.adapter.enrollRepository(input), binding);
  assert.deepEqual(
    await h.adapter.enrollRepository({ ...input, expectedRepositoryId: 42 }),
    binding,
  );
  assert.equal(h.calls.filter((call) => call.method === "POST").length, 1);
  assert.deepEqual(h.calls[2]?.body, {
    name: "project-a",
    description: repo.description,
    private: true,
    auto_init: false,
  });
  h.exhausted();
});

test("does not adopt public, unrelated, replaced, or removed enrolled repositories", async () => {
  for (const [body, code] of [
    [{ ...repo, private: false }, "not_private"],
    [{ ...repo, description: "unrelated work" }, "identity_conflict"],
    [{ ...repo, id: 99 }, "identity_conflict"],
  ] as const) {
    const h = harness([{ status: 200, body }]);
    await assert.rejects(
      h.adapter.enrollRepository({ ...input, expectedRepositoryId: 42 }),
      errorCode(code),
    );
    assert.deepEqual(
      h.calls.map((call) => call.method),
      ["GET"],
    );
  }
  const removed = harness([{ status: 404 }]);
  await assert.rejects(
    removed.adapter.enrollRepository({ ...input, expectedRepositoryId: 42 }),
    errorCode("identity_conflict"),
  );
  assert.equal(removed.calls.length, 1);
});

test("reconciles concurrent creation but refuses an unrelated winner", async () => {
  for (const winner of [repo, { ...repo, description: "other enrollment" }]) {
    const h = harness([
      { status: 404 },
      { status: 200, body: { login: "studio" } },
      { status: 409 },
      { status: 200, body: winner },
    ]);
    if (winner === repo)
      assert.deepEqual(await h.adapter.enrollRepository(input), binding);
    else
      await assert.rejects(
        h.adapter.enrollRepository(input),
        errorCode("identity_conflict"),
      );
    h.exhausted();
  }
});

test("organization provisioning does not use the administrative user creation endpoint", async () => {
  const h = harness([
    { status: 404 },
    { status: 201, body: repo },
    { status: 200, body: repo },
  ]);
  await h.adapter.enrollRepository({ ...input, ownerType: "organization" });
  assert.equal(h.calls[1]?.path, "/api/v1/orgs/studio/repos");
  h.exhausted();
});

test("authentication and server failures never turn into absence or expose provider content", async () => {
  for (const status of [401, 403, 429, 500]) {
    const h = harness([
      { status, body: { message: "FAKE_TEST_TOKEN_DO_NOT_USE" } },
    ]);
    await assert.rejects(
      h.adapter.enrollRepository(input),
      (error: unknown) => {
        assert.ok(error instanceof GiteaError);
        assert.equal(error.status, status);
        assert.equal(String(error).includes("FAKE_TEST_TOKEN"), false);
        return true;
      },
    );
    assert.equal(h.calls.length, 1);
  }
  const h = harness([
    new Error("FAKE_TEST_TOKEN_DO_NOT_USE in underlying headers"),
  ]);
  await assert.rejects(h.adapter.enrollRepository(input), (error: unknown) => {
    assert.ok(error instanceof GiteaError);
    assert.equal(error.code, "transport");
    assert.equal(error.cause, undefined);
    assert.equal(String(error).includes("FAKE_TEST_TOKEN"), false);
    return true;
  });
});

test("rejects insecure or ambiguous service URLs and path traversal before a request", async () => {
  for (const serviceUrl of [
    "http://git.example.test",
    "https://user:password@git.example.test",
    "https://git.example.test?token=fake",
    "https://git.example.test/#fragment",
    "https://git.example.test/api/v1",
    "https://git.example.test/a/../b",
    "https://git.example.test/%2e%2e/",
  ]) {
    assert.throws(
      () =>
        new GiteaAdapter({
          serviceUrl,
          instanceId: "studio-a",
          resolveToken: async () => "FAKE",
          keyIdentities: registry(),
        }),
      errorCode("invalid_input"),
    );
  }
  const h = harness([]);
  await assert.rejects(
    h.adapter.enrollRepository({ ...input, owner: "../other" }),
    errorCode("invalid_input"),
  );
  assert.equal(h.calls.length, 0);
});

test("creates an individual device key, verifies it, and repeats without mutation", async () => {
  const h = harness([
    { status: 200, body: repo },
    { status: 200, body: [] },
    { status: 201, body: apiKey },
    { status: 200, body: [apiKey] },
    { status: 200, body: repo },
    { status: 200, body: [apiKey] },
  ]);
  assert.deepEqual(
    await h.adapter.ensureDeployKey(binding, {
      ...deviceInput,
      publicKey: `${publicKey} device comment`,
    }),
    keyBinding,
  );
  assert.deepEqual(
    await h.adapter.ensureDeployKey(binding, deviceInput),
    keyBinding,
  );
  assert.deepEqual(
    h.calls.filter((call) => call.method === "POST").map((call) => call.body),
    [{ title: "vzn-code:project-a:child-a", key: publicKey, read_only: false }],
  );
  h.exhausted();
});

test("claims prohibit cross-project and cross-device public-key reuse", async () => {
  const claims = registry();
  const first = harness(
    [
      { status: 200, body: repo },
      { status: 200, body: [apiKey] },
    ],
    claims,
  );
  await first.adapter.ensureDeployKey(binding, deviceInput);
  for (const target of [
    binding,
    { ...binding, projectId: "project-b", name: "project-b", repositoryId: 43 },
  ]) {
    const targetRepo = {
      ...repo,
      id: target.repositoryId,
      full_name: `${target.owner}/${target.name}`,
      description: `vzn-code project=${target.projectId} enrollment=attempt-a`,
    };
    const h = harness([{ status: 200, body: targetRepo }], claims);
    await assert.rejects(
      h.adapter.ensureDeployKey(target, {
        ...deviceInput,
        deviceId: "child-b",
      }),
      errorCode("identity_conflict"),
    );
    assert.equal(h.calls.length, 1);
  }
});

test("never silently widens a read-only device key or replaces a different key", async () => {
  for (const conflicting of [
    { ...apiKey, read_only: true },
    { ...apiKey, key: otherKey },
  ]) {
    const h = harness([
      { status: 200, body: repo },
      { status: 200, body: [conflicting] },
    ]);
    await assert.rejects(
      h.adapter.ensureDeployKey(binding, deviceInput),
      errorCode("identity_conflict"),
    );
    assert.equal(
      h.calls.some((call) => call.method !== "GET"),
      false,
    );
  }
});

test("key listing includes later pages and preserves read-only status", async () => {
  const unrelated = Array.from({ length: 50 }, (_, index) => ({
    ...apiKey,
    id: index + 100,
    title: `manual-${index}`,
  }));
  const h = harness([
    { status: 200, body: repo },
    { status: 200, body: unrelated },
    { status: 200, body: [{ ...apiKey, read_only: true }] },
  ]);
  assert.deepEqual(await h.adapter.listDeployKeys(binding), [
    { ...keyBinding, readOnly: true },
  ]);
  assert.equal(
    h.calls[2]?.path,
    "/api/v1/repos/studio/project-a/keys?limit=50&page=2",
  );
  h.exhausted();
});

test("rejects cross-project key handles and repository replacement before deletion", async () => {
  const wrongHandle = harness([]);
  await assert.rejects(
    wrongHandle.adapter.revokeDeployKey(binding, {
      ...keyBinding,
      projectId: "project-b",
    }),
    errorCode("identity_conflict"),
  );
  assert.equal(wrongHandle.calls.length, 0);
  const replacement = harness([{ status: 200, body: { ...repo, id: 43 } }]);
  await assert.rejects(
    replacement.adapter.revokeDeployKey(binding, keyBinding),
    errorCode("identity_conflict"),
  );
  assert.equal(replacement.calls.length, 1);
});

test("revokes only the bound key, confirms absence, and is idempotent", async () => {
  const h = harness([
    { status: 200, body: repo },
    { status: 200, body: [apiKey] },
    { status: 204 },
    { status: 200, body: [] },
    { status: 200, body: repo },
    { status: 200, body: [] },
  ]);
  await h.adapter.revokeDeployKey(binding, keyBinding);
  await h.adapter.revokeDeployKey(binding, keyBinding);
  assert.deepEqual(
    h.calls.filter((call) => call.method === "DELETE").map((call) => call.path),
    ["/api/v1/repos/studio/project-a/keys/7"],
  );
  h.exhausted();
});

test("does not report revocation success when the key remains or identity changed", async () => {
  const remains = harness([
    { status: 200, body: repo },
    { status: 200, body: [apiKey] },
    { status: 204 },
    { status: 200, body: [apiKey] },
  ]);
  await assert.rejects(
    remains.adapter.revokeDeployKey(binding, keyBinding),
    errorCode("verification_failed"),
  );
  const changed = harness([
    { status: 200, body: repo },
    { status: 200, body: [{ ...apiKey, title: "manual-key" }] },
  ]);
  await assert.rejects(
    changed.adapter.revokeDeployKey(binding, keyBinding),
    errorCode("identity_conflict"),
  );
  assert.equal(changed.calls.length, 2);
});

test("configures checkpoint protection and verifies persisted restrictions", async () => {
  const h = harness([
    { status: 200, body: repo },
    { status: 404 },
    { status: 201, body: protectedRule },
    { status: 200, body: repo },
    { status: 200, body: [protectedRule] },
  ]);
  await h.adapter.configureCheckpointProtection(binding, "studio");
  assert.deepEqual(h.calls[2]?.body, protectedRule);
  h.exhausted();
});

test("correct protection is idempotent; unsafe deployed rules fail verification", async () => {
  const h = harness([
    { status: 200, body: repo },
    { status: 200, body: protectedRule },
    { status: 200, body: repo },
    { status: 200, body: [protectedRule, { rule_name: "main", priority: 2 }] },
  ]);
  await h.adapter.configureCheckpointProtection(binding, "studio");
  assert.equal(
    h.calls.some((call) => call.method !== "GET"),
    false,
  );
  for (const rules of [
    [{ ...protectedRule, push_whitelist_deploy_keys: true }],
    [{ ...protectedRule, unprotected_file_patterns: "**" }],
    [{ ...protectedRule, enable_force_push: true }],
    [{ ...protectedRule, enable_bypass_allowlist: true }],
    [{ ...protectedRule, push_whitelist_usernames: ["studio", "child"] }],
    [protectedRule, { rule_name: "*", priority: 1 }],
    [],
  ]) {
    const bad = harness([
      { status: 200, body: repo },
      { status: 200, body: rules },
    ]);
    await assert.rejects(
      bad.adapter.verifyCheckpointProtection(binding, "studio"),
      errorCode("verification_failed"),
    );
  }
});

test("malformed provider results fail closed", async () => {
  for (const body of [
    null,
    {},
    "wrong",
    [{ ...apiKey, read_only: undefined }],
  ]) {
    const h = harness([
      { status: 200, body: repo },
      { status: 200, body },
    ]);
    await assert.rejects(
      h.adapter.listDeployKeys(binding),
      errorCode("invalid_response"),
    );
  }
});

test("private key material and mismatched SSH wire types are rejected before provisioning", async () => {
  const h = harness([]);
  for (const key of [
    "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE",
    publicKey.replace("ssh-ed25519 ", "ssh-rsa "),
    "ssh-ed25519 invalid",
  ]) {
    await assert.rejects(
      h.adapter.ensureDeployKey(binding, { ...deviceInput, publicKey: key }),
      errorCode("invalid_input"),
    );
  }
  assert.equal(h.calls.length, 0);
});

test("creation errors preserve reserved identity and retries reconcile without duplicate keys", async () => {
  const claims = registry();
  const interrupted = harness(
    [
      { status: 200, body: repo },
      { status: 200, body: [] },
      new Error("ambiguous transport failure"),
    ],
    claims,
  );
  await assert.rejects(
    interrupted.adapter.ensureDeployKey(binding, deviceInput),
    errorCode("transport"),
  );
  const retry = harness(
    [
      { status: 200, body: repo },
      { status: 200, body: [apiKey] },
    ],
    claims,
  );
  assert.deepEqual(
    await retry.adapter.ensureDeployKey(binding, deviceInput),
    keyBinding,
  );
  assert.equal(
    retry.calls.some((call) => call.method === "POST"),
    false,
  );
  const reused = harness([{ status: 200, body: repo }], claims);
  await assert.rejects(
    reused.adapter.ensureDeployKey(binding, {
      ...deviceInput,
      deviceId: "another-device",
    }),
    errorCode("identity_conflict"),
  );
});

test("unsafe protection gets patched and a server ignoring the policy is detected", async () => {
  const unsafe = { ...protectedRule, enable_force_push: true };
  const h = harness([
    { status: 200, body: repo },
    { status: 200, body: unsafe },
    { status: 200, body: protectedRule },
    { status: 200, body: repo },
    { status: 200, body: [unsafe] },
  ]);
  await assert.rejects(
    h.adapter.configureCheckpointProtection(binding, "studio"),
    errorCode("verification_failed"),
  );
  assert.equal(h.calls[2]?.method, "PATCH");
  assert.deepEqual(h.calls[2]?.body, protectedRule);
});

test("credential resolver failures are redacted and redirect responses cannot authorize another origin", async () => {
  let called = false;
  const adapter = new GiteaAdapter({
    instanceId: "studio-a",
    serviceUrl: "https://git.example.test",
    keyIdentities: registry(),
    resolveToken: async () => {
      throw new Error("FAKE_SECRET_FROM_VAULT");
    },
    fetch: async () => {
      called = true;
      return new Response(null, { status: 204 });
    },
  });
  await assert.rejects(adapter.enrollRepository(input), (error: unknown) => {
    assert.ok(error instanceof GiteaError);
    assert.equal(error.code, "authentication");
    assert.equal(String(error).includes("FAKE_SECRET"), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(called, false);
  const redirected = harness([
    { status: 302, body: { location: "https://untrusted.example.test" } },
  ]);
  await assert.rejects(
    redirected.adapter.enrollRepository(input),
    errorCode("http"),
  );
  assert.equal(redirected.calls.length, 1);
});
