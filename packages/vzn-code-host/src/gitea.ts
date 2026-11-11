import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  GiteaAdapter,
  GiteaError,
  normalizePublicKey,
  validateGiteaSegment,
} from "@vzn-code/gitea";
import type { DeviceDeployKey, ProjectRepository } from "@vzn-code/gitea";

import { Journal } from "./journal.ts";
import { HostError, identifier } from "./protocol.ts";

type ProvisioningAdapter = Pick<
  GiteaAdapter,
  | "enrollRepository"
  | "configureCheckpointProtection"
  | "verifyCheckpointProtection"
  | "ensureDeployKey"
  | "listDeployKeys"
  | "revokeDeployKey"
>;

function privateOwnedFile(path: string): void {
  if (!isAbsolute(path))
    throw new HostError(
      "INVALID_GITEA_CONFIG",
      "Gitea file path must be absolute",
    );
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0
  )
    throw new HostError(
      "UNSAFE_GITEA_FILE",
      "Gitea file must be private and owned by this user",
    );
}

export function loadHostGitea(
  stateDir: string,
  journal: Journal,
): HostGitea | undefined {
  const path = join(stateDir, "gitea.json");
  try {
    lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
  privateOwnedFile(path);
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new HostError(
      "INVALID_GITEA_CONFIG",
      "Gitea configuration is not valid JSON",
    );
  }
  if (config === null || typeof config !== "object" || Array.isArray(config))
    throw new HostError(
      "INVALID_GITEA_CONFIG",
      "Gitea configuration must be an object",
    );
  const fields = config as Record<string, unknown>;
  const expected = [
    "instanceId",
    "serviceUrl",
    "owner",
    "studioUsername",
    "tokenFile",
  ];
  if (
    Object.keys(fields).some((key) => !expected.includes(key)) ||
    expected.some((key) => typeof fields[key] !== "string" || !fields[key])
  )
    throw new HostError(
      "INVALID_GITEA_CONFIG",
      "Gitea configuration fields are incomplete",
    );
  const tokenFile = fields.tokenFile as string;
  privateOwnedFile(tokenFile);
  const adapter = new GiteaAdapter({
    instanceId: fields.instanceId as string,
    serviceUrl: fields.serviceUrl as string,
    resolveToken: async () => {
      privateOwnedFile(tokenFile);
      return readFileSync(tokenFile, "utf8").trim();
    },
    keyIdentities: {
      claim: async (identity) => journal.claimKeyIdentity(identity),
    },
  });
  return new HostGitea(journal, adapter, {
    instanceId: fields.instanceId as string,
    owner: fields.owner as string,
    studioUsername: fields.studioUsername as string,
  });
}

export class HostGitea {
  readonly #journal: Journal;
  readonly #adapter: ProvisioningAdapter;
  readonly #instanceId: string;
  readonly #owner: string;
  readonly #studioUsername: string;
  readonly #pending = new Map<string, Promise<unknown>>();

  constructor(
    journal: Journal,
    adapter: ProvisioningAdapter,
    options: { instanceId: string; owner: string; studioUsername: string },
  ) {
    this.#journal = journal;
    this.#adapter = adapter;
    this.#instanceId = validateGiteaSegment(options.instanceId);
    this.#owner = validateGiteaSegment(options.owner);
    this.#studioUsername = validateGiteaSegment(options.studioUsername);
  }

  async #serialize<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#pending.get(projectId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    this.#pending.set(projectId, current);
    try {
      return await current;
    } catch (error) {
      if (error instanceof HostError) throw error;
      if (error instanceof GiteaError)
        throw new HostError(`GITEA_${error.code.toUpperCase()}`, error.message);
      throw new HostError(
        "GITEA_UNCERTAIN",
        "Provisioning result is uncertain; retry the same identity",
      );
    } finally {
      if (this.#pending.get(projectId) === current)
        this.#pending.delete(projectId);
    }
  }

  async #repository(projectId: string): Promise<ProjectRepository> {
    const intent = this.#journal.repositoryIntent(projectId);
    if (!intent || intent.repositoryId === null || !intent.protectionVerified)
      throw new HostError(
        "REPOSITORY_NOT_READY",
        "Repository is not enrolled and protected",
      );
    if (intent.instanceId !== this.#instanceId || intent.owner !== this.#owner)
      throw new HostError(
        "REPOSITORY_CONFLICT",
        "Repository belongs to another configured instance",
      );
    const repository = await this.#adapter.enrollRepository({
      projectId,
      owner: intent.owner,
      name: intent.name,
      ownerType: "user",
      enrollmentId: intent.enrollmentId,
      expectedRepositoryId: intent.repositoryId,
    });
    await this.#adapter.verifyCheckpointProtection(
      repository,
      this.#studioUsername,
    );
    return repository;
  }

  enrollProject(
    projectId: string,
    repositoryName?: string,
  ): Promise<ProjectRepository> {
    identifier(projectId, "projectId");
    return this.#serialize(projectId, async () => {
      validateGiteaSegment(projectId);
      const project = this.#journal.project(projectId);
      const name = validateGiteaSegment(
        repositoryName ??
          this.#journal.repositoryIntent(projectId)?.name ??
          project.repository,
      );
      const intent = this.#journal.beginRepositoryIntent({
        projectId,
        instanceId: this.#instanceId,
        enrollmentId: randomUUID(),
        owner: this.#owner,
        name,
      });
      const repository = await this.#adapter.enrollRepository({
        projectId,
        owner: intent.owner,
        name: intent.name,
        ownerType: "user",
        enrollmentId: intent.enrollmentId,
        ...(intent.repositoryId === null
          ? {}
          : { expectedRepositoryId: intent.repositoryId }),
      });
      this.#journal.bindRepository(projectId, repository.repositoryId);
      await this.#adapter.configureCheckpointProtection(
        repository,
        this.#studioUsername,
      );
      this.#journal.verifyRepositoryProtection(
        projectId,
        repository.repositoryId,
      );
      return repository;
    });
  }

  ensureDeviceKey(input: {
    projectId: string;
    deviceId: string;
    publicKey: string;
    readOnly: boolean;
  }): Promise<DeviceDeployKey> {
    identifier(input.projectId, "projectId");
    identifier(input.deviceId, "deviceId");
    return this.#serialize(input.projectId, async () => {
      const repository = await this.#repository(input.projectId);
      validateGiteaSegment(input.deviceId);
      const key = normalizePublicKey(input.publicKey);
      this.#journal.beginDeployKeyIntent({
        projectId: input.projectId,
        deviceId: input.deviceId,
        publicKey: key,
        readOnly: input.readOnly,
      });
      const enrolled = await this.#adapter.ensureDeployKey(repository, {
        deviceId: input.deviceId,
        publicKey: key,
        readOnly: input.readOnly,
      });
      this.#journal.bindDeployKey(
        input.projectId,
        input.deviceId,
        enrolled.keyId,
      );
      return enrolled;
    });
  }

  revokeDeviceKey(projectId: string, deviceId: string): Promise<void> {
    identifier(projectId, "projectId");
    identifier(deviceId, "deviceId");
    return this.#serialize(projectId, async () => {
      const intent = this.#journal.beginDeployKeyRevocation(
        projectId,
        deviceId,
      );
      const repository = await this.#repository(projectId);
      let keyId = intent.keyId;
      if (keyId === null) {
        const matching = (
          await this.#adapter.listDeployKeys(repository)
        ).filter((key) => key.deviceId === deviceId);
        if (matching.length !== 1 || !matching[0])
          throw new HostError(
            "REVOCATION_UNCERTAIN",
            "Unbound key must be reconciled before revocation can finish",
          );
        if (
          matching[0].publicKey !== intent.publicKey ||
          matching[0].readOnly !== intent.readOnly
        )
          throw new HostError(
            "DEVICE_KEY_CONFLICT",
            "Remote key differs from revocation intent",
          );
        keyId = matching[0].keyId;
      }
      await this.#adapter.revokeDeployKey(repository, {
        instanceId: repository.instanceId,
        projectId,
        repositoryId: repository.repositoryId,
        deviceId,
        keyId,
        publicKey: intent.publicKey,
        readOnly: intent.readOnly,
      });
      this.#journal.finishDeployKeyRevocation(projectId, deviceId);
    });
  }
}
