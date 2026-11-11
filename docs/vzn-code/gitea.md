# Private Gitea adapter and rollout gates

`packages/vzn-code-gitea` is a private, dependency-free TypeScript provisioning package for Studio. It does not install Gitea, change Studio configuration, read credentials from the environment, execute Git, or enable handoff. A separate Mac pilot validated selected operations against Gitea 28.3.0; the offline tests alone do not prove server enforcement.

## Host integration

The trusted Studio host now constructs `GiteaAdapter` from a private `gitea.json` file with a pinned `instanceId`, private HTTPS `serviceUrl`, token-file resolver, and durable journal-backed `keyIdentities` registry. The instance URL is administrator-controlled configuration: do not accept it from a model, browser, task, or remote request. Private-network destinations are intentional for this transport. TLS verification stays enabled. Redirects, URL credentials, query strings, fragments, traversal, and HTTP are rejected. Subpath installations are supported. See [host.md](host.md) for the configuration and local-owner CLI.

Provisioning credentials stay inside the callback and Authorization header. Errors contain a fixed classification and optional HTTP status, never URLs, response bodies, token values, or underlying exception causes. This is an internal server package; do not expose its constructor or credential callback through agent actions. The host must authorize the current caller's project/device before using the adapter.

Persist an enrollment intent before calling `enrollRepository`: project ID, unique enrollment ID, instance ID, owner, repository name, and owner type. Retain the same intent for retries. Persist the returned repository ID and pass `expectedRepositoryId` for future enrollment checks. A repository must be private, have the exact owner/name, and carry the exact enrollment marker. The marker is recovery metadata, not an authorization mechanism. No unrelated repository is adopted or overwritten, and a missing previously registered repository is not automatically recreated. User-owned creation verifies the authenticated user's login; organization-owned creation uses the organization endpoint without creating organizations or accounts.

Persist the complete `ProjectRepository` and `DeviceDeployKey` bindings in host-owned state. Every key/protection operation rereads and checks repository identity and privacy. API-returned clone URLs are not trusted: the adapter derives HTTPS links from the configured origin and validated owner/name. Configure the SSH host, port, username, clone path, and pinned host key separately during deployment; do not derive an SSH trust decision from an arbitrary API response. Keep `origin` unchanged and resolve any existing `studio` remote collision before adding a managed remote.

The key registry's `claim({instanceId, projectId, deviceId, publicKey})` returns `true` only for a newly persisted claim or the identical existing identity. It returns `false` for a public key previously bound to any different instance, project, or device. This must be an atomic durable uniqueness constraint, not an in-memory cache or lookup followed by a non-atomic write. The host journal supplies `claimKeyIdentity`; adapt it with `claim: async (identity) => journal.claimKeyIdentity(identity)`. Claims remain reserved after request failure and revocation. The adapter normalizes SSH key wire encoding and removes comments before claiming. Devices generate and protect their private keys; only public keys enter this API.

Use `readOnly: true` for preview/test copies and `false` for upload-capable devices. Existing device/key identity or permission mismatches fail instead of silently replacing a key or expanding access. A changed key needs an explicit rotation workflow with revocation and a new key record. Store the repository deploy-key `id`, not the global public-key `key_id`. `revokeDeployKey` checks the bound identity, deletes only that repository key, and rereads to verify absence. Repeated revocation is safe. Registry claims are never released for reuse.

The host must serialize enrollment/revocation for a device/project and record revocation intent before calling Gitea, then reject stale enrollment requests for revoked key records. A new, explicitly authorized `ensureDeployKey` request can recreate an absent key for the same identity; the public-key uniqueness registry alone is not a revocation ledger. Repository checks and subsequent API writes are also separate requests, so administration must not rename, replace, or change privacy of managed repositories concurrently with provisioning. Reconcile any ambiguous network failure against durable enrollment intent before enabling a device.

## Checkpoint branch protection

`configureCheckpointProtection(repository, studioUsername)` creates or updates only `handoff/**`; it preserves normal source-branch rules. The intended rule has highest priority, restricts push and merge to the named Studio user, excludes deploy keys and teams, disables force-push and bypass allowlists, blocks administrative merge override, and removes unprotected-file exceptions. `verifyCheckpointProtection` checks the persisted policy and rejects competing rules at equal or higher priority. Unknown or missing security fields fail closed. An older server that does not support these fields must not be treated as compatible merely because a create request returned success.

API readback verifies configuration, **not enforcement**. In particular, creation/deletion permissions, wildcard selection, key authorization, and administrator behavior must be tested on the pinned Gitea release. Studio must publish accepted refs as its allowlisted user; its repository deploy key is deliberately excluded. The host still enforces immutable accepted object IDs and ownership epochs. Branch rules alone do not prevent an authorized Studio writer from advancing a branch, and they do not grant workspace ownership.

## Operational preflight and acceptance record

Perform these steps on a disposable pilot before enabling private handoff. Record the tested Gitea version, Git versions on both operating systems, configuration digest, instance/repository IDs, public host-key fingerprint, timestamp, exact commands, exit statuses, and before/after ref IDs in the compatibility record. Never record provisioning tokens or private keys.

1. Install and supervise the pinned Gitea release independently of Desktop, with local storage outside synchronized folders and its own SQLite database. Use the documented macOS package deployment path.
2. Confirm private HTTPS and built-in SSH reachability only through the approved private network, valid TLS, pinned SSH host key, disabled public signup and anonymous repository access, and automatic service restart. Create a dedicated automation identity limited to managed repositories and required API operations. Token endpoint scopes alone do not establish repository isolation.
3. Create two disposable private projects, A and B. Repeating enrollment must return the same repository ID. Attempt enrollment over an unrelated existing repository and confirm rejection without changes.
4. Generate separate project-specific child keys. Register A's write key and a separate A read-only key. Keep B's key different. Verify the adapter refuses reusing A's key under B or another device identity. Restart the host and repeat this check to prove durable claims.
5. Configure protection and read it back. Audit all overlapping patterns and normal source rules in the Gitea UI. Disable handoff if any acceptance row below fails; do not weaken a failed assertion to make the pilot pass.

| Identity and operation                                                                       | Required observed result                                                      |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Child A key clones/fetches repository A                                                      | Success                                                                       |
| Child A key clones/fetches/pushes repository B                                               | Denied                                                                        |
| A read-only key pushes `incoming/child/probe`                                                | Denied                                                                        |
| A write key pushes an explicit `incoming/child/probe` ref                                    | Success                                                                       |
| A write key creates a new nested `handoff/task/probe` ref                                    | Denied                                                                        |
| A write key fast-forwards, force-updates, or deletes an existing accepted ref                | Every operation denied; object ID unchanged                                   |
| Studio user publishes a new accepted ref                                                     | Success; object ID verified against the journal                               |
| Studio or child force-updates an existing accepted ref                                       | Denied by server policy; host also refuses any accepted-ID rewrite            |
| Child pushes an exact accepted ref through HTTPS or API using any available child credential | Denied; children never receive provisioning credentials                       |
| Key revoked via adapter, followed by a new SSH connection                                    | Clone/fetch/push denied; another enrolled key still works                     |
| Revocation retried and host restarted                                                        | Key remains absent; old public key still cannot enroll under another identity |
| Transfer interrupted and repeated                                                            | Reconciles the intended repo/key identity; no unrelated mutation              |

Use isolated SSH sessions with `IdentitiesOnly=yes`, `StrictHostKeyChecking=yes`, an explicitly pinned `UserKnownHostsFile`, the selected project key, and connection multiplexing disabled so cached sessions cannot hide a revocation failure. Use explicit push refspecs. Never test with `push --mirror` or `push --all`. Run each denied operation separately and inspect both its nonzero status and the unchanged remote ref. Test nested ref names, a nonexistent destination, and an existing destination. Confirm neither normal source branches nor GitHub receives synthetic checkpoint commits.

6. Complete a coordinated off-Studio backup and isolated restore before irreplaceable work. Pause new transfers and publication, drain Git operations, and stop Gitea for the backup window. Include database, configuration, repositories, keys, stored objects, the coordinated host journal, and external artifact references. Restart and verify health. Restore in recovery mode until outstanding ownership grants are reconciled.

## Local verification

From the framework checkout:

```sh
pnpm --filter @vzn-code/gitea test
pnpm --filter @vzn-code/gitea typecheck
```

Tests run using Node's built-in test runner and type stripping; there are no runtime or test dependency additions. Typechecking uses the workspace TypeScript compiler. Offline coverage exercises enrollment idempotency and collisions, private-repository guards, key ownership and read-only checks, pagination, cross-project claim rejection, confirmed revocation, interrupted creation, branch-policy drift, and redacted failures. The separate Mac pilot in [verification.md](verification.md) proved selected live SSH and protection behavior. Backup integrity and cross-device checkpoint transfer remain unverified.

## API references

- [Repository deploy-key creation](https://docs.gitea.com/api/operations/repo-create-key/)
- [Branch-protection API](https://docs.gitea.com/api/operations/repo-create-branch-protection/)
- [Protected branch rule matching and enforcement](https://docs.gitea.com/usage/access-control/protected-branches/)
- [API usage](https://docs.gitea.com/development/api-usage/)
- [Backup and restore](https://docs.gitea.com/administration/backup-and-restore/)

These references were inspected for adapter design; compatibility remains contingent on recording and testing the deployed version.
