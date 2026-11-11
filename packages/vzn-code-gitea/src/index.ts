export type GiteaErrorCode =
  | "invalid_input"
  | "authentication"
  | "transport"
  | "http"
  | "invalid_response"
  | "identity_conflict"
  | "not_private"
  | "verification_failed";

export class GiteaError extends Error {
  readonly code: GiteaErrorCode;
  readonly status: number | undefined;

  constructor(code: GiteaErrorCode, status?: number) {
    super(
      `Gitea operation failed: ${code}${status === undefined ? "" : ` (${status})`}`,
    );
    this.name = "GiteaError";
    this.code = code;
    this.status = status;
  }
}

export interface KeyIdentity {
  instanceId: string;
  projectId: string;
  deviceId: string;
  publicKey: string;
}

export interface KeyIdentityRegistry {
  /** Atomically persist a permanent key-to-identity claim; reject a different identity. */
  claim(identity: KeyIdentity): Promise<boolean>;
}

export interface GiteaOptions {
  instanceId: string;
  /** Trusted host configuration, never request- or model-supplied. HTTPS only. */
  serviceUrl: string;
  /** Resolve in Studio's credential store. Never pass a credential through an action. */
  resolveToken(): Promise<string>;
  keyIdentities: KeyIdentityRegistry;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface ProjectRepository {
  instanceId: string;
  projectId: string;
  enrollmentId: string;
  repositoryId: number;
  owner: string;
  name: string;
  webUrl: string;
  cloneUrl: string;
}

export interface RepositoryEnrollment {
  projectId: string;
  owner: string;
  name: string;
  ownerType: "user" | "organization";
  /** Persist before provisioning; use the same value after an interrupted request. */
  enrollmentId: string;
  expectedRepositoryId?: number;
}

export interface DeviceDeployKey {
  instanceId: string;
  projectId: string;
  repositoryId: number;
  deviceId: string;
  keyId: number;
  publicKey: string;
  readOnly: boolean;
}

type JsonObject = Record<string, unknown>;
type ApiResult = { status: number; body: unknown };
type ApiKey = { id: number; title: string; key: string; readOnly: boolean };
const PAGE_SIZE = 50;
const MAX_PAGES = 100;

function fail(code: GiteaErrorCode): never {
  throw new GiteaError(code);
}

export function validateGiteaSegment(value: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value) ||
    value.endsWith(".git")
  ) {
    fail("invalid_input");
  }
  return value;
}
const segment = validateGiteaSegment;

function positiveId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail("invalid_response");
  }
  return value;
}

function object(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("invalid_response");
  }
  return value as JsonObject;
}

export function normalizePublicKey(value: string): string {
  // Only public SSH keys; strip comments so identity cannot change with a label.
  const match =
    /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?$/.exec(
      value,
    );
  if (
    !match ||
    !match[1] ||
    !match[2] ||
    match[2].length < 32 ||
    value.length > 16384
  ) {
    fail("invalid_input");
  }
  let decoded: string;
  try {
    decoded = atob(match[2]);
  } catch {
    fail("invalid_input");
  }
  const fields: string[] = [];
  for (let offset = 0; offset < decoded.length; ) {
    if (offset + 4 > decoded.length) fail("invalid_input");
    const size =
      decoded.charCodeAt(offset) * 0x1000000 +
      decoded.charCodeAt(offset + 1) * 0x10000 +
      decoded.charCodeAt(offset + 2) * 0x100 +
      decoded.charCodeAt(offset + 3);
    offset += 4;
    if (size === 0 || offset + size > decoded.length) fail("invalid_input");
    fields.push(decoded.slice(offset, offset + size));
    offset += size;
  }
  if (
    fields[0] !== match[1] ||
    (match[1] === "ssh-ed25519" &&
      (fields.length !== 2 || fields[1]?.length !== 32)) ||
    (match[1] === "ssh-rsa" && fields.length !== 3) ||
    (match[1].startsWith("ecdsa-") &&
      (fields.length !== 3 || fields[1] !== match[1].slice(11)))
  ) {
    fail("invalid_input");
  }
  if (
    match[1] === "ssh-rsa" &&
    fields
      .slice(1)
      .some(
        (field) =>
          field.charCodeAt(0) >= 128 ||
          (field.charCodeAt(0) === 0 &&
            (field.length === 1 || field.charCodeAt(1) < 128)),
      )
  ) {
    fail("invalid_input");
  }
  if (match[1].startsWith("ecdsa-")) {
    const point = fields[2];
    const size =
      fields[1] === "nistp256" ? 65 : fields[1] === "nistp384" ? 97 : 133;
    if (!point || point.charCodeAt(0) !== 4 || point.length !== size)
      fail("invalid_input");
  }
  return `${match[1]} ${btoa(decoded)}`;
}

function keyTitle(projectId: string, deviceId: string): string {
  return `vzn-code:${segment(projectId)}:${segment(deviceId)}`;
}

function apiKey(value: unknown): ApiKey {
  const key = object(value);
  if (
    typeof key.title !== "string" ||
    typeof key.key !== "string" ||
    typeof key.read_only !== "boolean"
  ) {
    fail("invalid_response");
  }
  let normalized: string;
  try {
    normalized = normalizePublicKey(key.key);
  } catch {
    fail("invalid_response");
  }
  return {
    id: positiveId(key.id),
    title: key.title,
    key: normalized,
    readOnly: key.read_only,
  };
}

function marker(input: RepositoryEnrollment): string {
  return `vzn-code project=${segment(input.projectId)} enrollment=${segment(input.enrollmentId)}`;
}

function policy(studioUsername: string): JsonObject {
  return {
    rule_name: "handoff/**",
    priority: 1,
    enable_push: true,
    enable_push_whitelist: true,
    push_whitelist_usernames: [segment(studioUsername)],
    push_whitelist_teams: [],
    push_whitelist_deploy_keys: false,
    enable_force_push: false,
    enable_force_push_allowlist: false,
    force_push_allowlist_deploy_keys: false,
    force_push_allowlist_usernames: [],
    force_push_allowlist_teams: [],
    enable_merge_whitelist: true,
    merge_whitelist_usernames: [studioUsername],
    merge_whitelist_teams: [],
    enable_bypass_allowlist: false,
    bypass_allowlist_usernames: [],
    bypass_allowlist_teams: [],
    block_admin_merge_override: true,
    unprotected_file_patterns: "",
  };
}

function matchesPolicy(actual: JsonObject, expected: JsonObject): boolean {
  return Object.entries(expected).every(([key, value]) => {
    const found = actual[key];
    return Array.isArray(value)
      ? Array.isArray(found) &&
          value.length === found.length &&
          value.every((item) => found.includes(item))
      : found === value;
  });
}

/** Provisioning only. Git transport, SSH trust, and checkout ownership belong to the host. */
export class GiteaAdapter {
  readonly #options: GiteaOptions;
  readonly #base: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  constructor(options: GiteaOptions) {
    segment(options.instanceId);
    let url: URL;
    try {
      url = new URL(options.serviceUrl);
    } catch {
      fail("invalid_input");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*\/?$/.test(url.pathname) ||
      /[\\\s]/.test(options.serviceUrl) ||
      options.serviceUrl.includes("/api/v1") ||
      options.serviceUrl.replace(/\/$/, "") !== url.href.replace(/\/$/, "")
    ) {
      fail("invalid_input");
    }
    this.#options = { ...options };
    this.#base = url.href.replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 15000;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1 ||
      this.#timeoutMs > 120000
    ) {
      fail("invalid_input");
    }
  }

  async #request(
    method: string,
    path: string,
    body?: JsonObject,
  ): Promise<ApiResult> {
    let token: string;
    try {
      token = await this.#options.resolveToken();
    } catch {
      fail("authentication");
    }
    if (
      typeof token !== "string" ||
      !token ||
      /[\s\x00-\x1f\x7f]/.test(token)
    ) {
      fail("authentication");
    }
    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      // Fetch exceptions may contain request headers or URLs; never preserve their cause.
      fail("transport");
    }
    if (response.status === 401 || response.status === 403)
      throw new GiteaError("authentication", response.status);
    if (!response.ok) return { status: response.status, body: undefined };
    if (response.status === 204)
      return { status: response.status, body: undefined };
    try {
      return { status: response.status, body: await response.json() };
    } catch {
      fail("invalid_response");
    }
  }

  #expect(result: ApiResult, statuses: number[]): unknown {
    if (!statuses.includes(result.status))
      throw new GiteaError("http", result.status);
    return result.body;
  }

  #path(repository: Pick<ProjectRepository, "owner" | "name">): string {
    return `/repos/${segment(repository.owner)}/${segment(repository.name)}`;
  }

  #repository(value: unknown, input: RepositoryEnrollment): ProjectRepository {
    const repo = object(value);
    if (repo.private !== true) fail("not_private");
    if (
      repo.full_name !== `${input.owner}/${input.name}` ||
      repo.description !== marker(input)
    ) {
      fail("identity_conflict");
    }
    const id = positiveId(repo.id);
    if (
      input.expectedRepositoryId !== undefined &&
      id !== input.expectedRepositoryId
    )
      fail("identity_conflict");
    const webUrl = `${this.#base}/${input.owner}/${input.name}`;
    return {
      instanceId: this.#options.instanceId,
      projectId: input.projectId,
      enrollmentId: input.enrollmentId,
      repositoryId: id,
      owner: input.owner,
      name: input.name,
      webUrl,
      cloneUrl: `${webUrl}.git`,
    };
  }

  async enrollRepository(
    input: RepositoryEnrollment,
  ): Promise<ProjectRepository> {
    const description = marker(input);
    const path = this.#path(input);
    if (input.ownerType !== "user" && input.ownerType !== "organization")
      fail("invalid_input");
    const existing = await this.#request("GET", path);
    if (existing.status === 200) return this.#repository(existing.body, input);
    this.#expect(existing, [404]);
    if (input.expectedRepositoryId !== undefined) fail("identity_conflict");
    if (input.ownerType === "user") {
      const user = object(
        this.#expect(await this.#request("GET", "/user"), [200]),
      );
      if (user.login !== input.owner) fail("identity_conflict");
    }
    const createPath =
      input.ownerType === "user" ? "/user/repos" : `/orgs/${input.owner}/repos`;
    const created = await this.#request("POST", createPath, {
      name: input.name,
      description,
      private: true,
      auto_init: false,
    });
    // A competing or interrupted creation may have won. Reconcile, never overwrite.
    this.#expect(created, [201, 409, 422]);
    const confirmed = await this.#request("GET", path);
    return this.#repository(this.#expect(confirmed, [200]), input);
  }

  async #verifyRepository(repository: ProjectRepository): Promise<string> {
    if (repository.instanceId !== this.#options.instanceId)
      fail("identity_conflict");
    segment(repository.projectId);
    positiveId(repository.repositoryId);
    const path = this.#path(repository);
    const repo = object(this.#expect(await this.#request("GET", path), [200]));
    if (repo.private !== true) fail("not_private");
    if (
      repo.id !== repository.repositoryId ||
      repo.full_name !== `${repository.owner}/${repository.name}` ||
      repo.description !==
        `vzn-code project=${repository.projectId} enrollment=${segment(repository.enrollmentId)}`
    ) {
      fail("identity_conflict");
    }
    return path;
  }

  async #keys(path: string): Promise<ApiKey[]> {
    const keys: ApiKey[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = this.#expect(
        await this.#request(
          "GET",
          `${path}/keys?limit=${PAGE_SIZE}&page=${page}`,
        ),
        [200],
      );
      if (!Array.isArray(body)) fail("invalid_response");
      keys.push(...body.map(apiKey));
      if (body.length < PAGE_SIZE) return keys;
    }
    fail("invalid_response");
  }

  async listDeployKeys(
    repository: ProjectRepository,
  ): Promise<DeviceDeployKey[]> {
    const path = await this.#verifyRepository(repository);
    const prefix = `vzn-code:${repository.projectId}:`;
    return (await this.#keys(path))
      .filter((key) => key.title.startsWith(prefix))
      .map((key) => ({
        instanceId: repository.instanceId,
        projectId: repository.projectId,
        repositoryId: repository.repositoryId,
        deviceId: segment(key.title.slice(prefix.length)),
        keyId: key.id,
        publicKey: key.key,
        readOnly: key.readOnly,
      }));
  }

  async ensureDeployKey(
    repository: ProjectRepository,
    input: {
      deviceId: string;
      publicKey: string;
      readOnly: boolean;
    },
  ): Promise<DeviceDeployKey> {
    const title = keyTitle(repository.projectId, input.deviceId);
    const key = normalizePublicKey(input.publicKey);
    if (typeof input.readOnly !== "boolean") fail("invalid_input");
    const path = await this.#verifyRepository(repository);
    let claimed: boolean;
    try {
      claimed = await this.#options.keyIdentities.claim({
        instanceId: repository.instanceId,
        projectId: repository.projectId,
        deviceId: input.deviceId,
        publicKey: key,
      });
    } catch {
      fail("verification_failed");
    }
    if (claimed !== true) fail("identity_conflict");
    const check = (keys: ApiKey[]) => {
      const matches = keys.filter(
        (entry) => entry.title === title || entry.key === key,
      );
      if (matches.length === 0) return undefined;
      const found = matches[0];
      if (
        matches.length !== 1 ||
        !found ||
        found.title !== title ||
        found.key !== key ||
        found.readOnly !== input.readOnly
      ) {
        fail("identity_conflict");
      }
      return found;
    };
    let found = check(await this.#keys(path));
    if (!found) {
      const created = await this.#request("POST", `${path}/keys`, {
        title,
        key,
        read_only: input.readOnly,
      });
      this.#expect(created, [201, 409, 422]);
      found = check(await this.#keys(path));
    }
    if (!found) fail("verification_failed");
    return {
      instanceId: repository.instanceId,
      projectId: repository.projectId,
      repositoryId: repository.repositoryId,
      deviceId: input.deviceId,
      keyId: found.id,
      publicKey: key,
      readOnly: found.readOnly,
    };
  }

  async revokeDeployKey(
    repository: ProjectRepository,
    key: DeviceDeployKey,
  ): Promise<void> {
    if (
      key.instanceId !== repository.instanceId ||
      key.projectId !== repository.projectId ||
      key.repositoryId !== repository.repositoryId
    )
      fail("identity_conflict");
    positiveId(key.keyId);
    const title = keyTitle(repository.projectId, key.deviceId);
    const expectedKey = normalizePublicKey(key.publicKey);
    const path = await this.#verifyRepository(repository);
    const found = (await this.#keys(path)).find(
      (entry) => entry.id === key.keyId,
    );
    if (!found) return;
    if (
      found.title !== title ||
      found.key !== expectedKey ||
      found.readOnly !== key.readOnly
    )
      fail("identity_conflict");
    this.#expect(
      await this.#request("DELETE", `${path}/keys/${key.keyId}`),
      [204, 404],
    );
    if ((await this.#keys(path)).some((entry) => entry.id === key.keyId))
      fail("verification_failed");
  }

  async configureCheckpointProtection(
    repository: ProjectRepository,
    studioUsername: string,
  ): Promise<void> {
    const expected = policy(studioUsername);
    const path = `${await this.#verifyRepository(repository)}/branch_protections`;
    const rulePath = `${path}/${encodeURIComponent("handoff/**")}`;
    const existing = await this.#request("GET", rulePath);
    this.#expect(existing, [200, 404]);
    if (
      existing.status === 404 ||
      !matchesPolicy(object(existing.body), expected)
    ) {
      const result = await this.#request(
        existing.status === 404 ? "POST" : "PATCH",
        existing.status === 404 ? path : rulePath,
        expected,
      );
      this.#expect(result, existing.status === 404 ? [201, 409, 422] : [200]);
    }
    await this.verifyCheckpointProtection(repository, studioUsername);
  }

  async verifyCheckpointProtection(
    repository: ProjectRepository,
    studioUsername: string,
  ): Promise<void> {
    const expected = policy(studioUsername);
    const path = `${await this.#verifyRepository(repository)}/branch_protections`;
    const body = this.#expect(await this.#request("GET", path), [200]);
    if (!Array.isArray(body)) fail("invalid_response");
    const rules = body.map(object);
    const handoff = rules.filter((rule) => rule.rule_name === "handoff/**");
    if (
      handoff.length !== 1 ||
      !handoff[0] ||
      !matchesPolicy(handoff[0], expected) ||
      rules.some(
        (rule) =>
          rule !== handoff[0] &&
          (typeof rule.priority !== "number" || rule.priority <= 1),
      )
    ) {
      fail("verification_failed");
    }
  }
}
