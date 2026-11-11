# VZN Code workspace checkpoints

Dependency-free Node/Git primitives for C11 and the source-transfer portion of C12. Capture and restore do not contact a remote. Separate explicit transport calls require a configured repository binding. These functions do not grant editing ownership, pause writers, authenticate a device, or publish to GitHub. Desktop and host callers can share this package without importing Electron or Core's Portal publisher.

```ts
import {
  captureCheckpoint,
  checkpointDigest,
  restoreCheckpoint,
} from "@vzn-code/workspace";

// The host first pauses managed writers and holds the checkout grant.
const manifest = await captureCheckpoint({
  repositoryPath: "/projects/example",
  projectId: "example-project",
  repositoryId: "example-repository",
  writersPaused: true,
});
const expectedDigest = checkpointDigest(manifest);

// Persist the manifest and digest in the trusted host journal. A private
// transport must transfer all three exact refs before restoring elsewhere.
const workspace = await restoreCheckpoint({
  repositoryPath: "/projects/example",
  destinationPath: "/worktrees/example-task", // must not already exist
  manifest,
  expectedDigest,
});
```

`captureCheckpoint` records base HEAD, source branch, object format, index tree, tracked working-tree tree, and a separate eligible untracked tree. Each layer has a synthetic commit parented by base HEAD, an exact retained ref, and a file inventory containing blob IDs, byte sizes, SHA-256 digests and Git modes. Environment recipe digest, task/session identifiers and required filesystem capabilities travel as metadata. Files remain Git objects, not JSON payloads.

Capture reads the source index without refreshing it, uses separate temporary indexes, compares two complete observations of HEAD/index/files, and fails on detected concurrent changes. The caller must keep managed writers paused throughout capture; two observations cannot replace a filesystem lock against arbitrary external writers. A single Git ref transaction retains all layers under `refs/vzn-code/checkpoints/<checkpointId>/<layer>`. Existing checkpoint identities cannot be overwritten. Capture never changes the source HEAD, branch or index and never pushes. Cancellation before publication may leave unreachable objects for normal Git garbage collection; the atomic publication transaction itself is the final non-cancellable commit point.

`verifyCheckpoint` requires the digest already accepted by the trusted journal. Never compute this trusted value from an unverified incoming manifest. It verifies refs, exact commits/parents/trees, complete file inventories, raw bytes and policy. All three refs must exist locally, including after private transfer. Pinning a digest establishes integrity, not device identity or authorization.

`restoreCheckpoint` verifies before creating a detached worktree at base HEAD. It materializes raw bytes without invoking clean/smudge filters, installs the captured index independently, verifies the result, and returns the path only after completion. Staged, unstaged, new and deleted content remain distinct, including staged deletion followed by an untracked recreation. The source branch name remains manifest metadata; restore does not move or check out that branch. The destination's parent must exist. Every occupied destination is refused, including empty directories and clean or dirty repositories. A failed restore removes only its newly reserved worktree; existing workspaces are never reset or cleaned.

Default untracked exclusions include Git-ignored files, dependency/build/cache directories, log files, environment files, credential files and private-key file extensions. `policy.secretPaths` and `policy.excludedPaths` add exact paths or directory prefixes. `policy.includeIgnoredPaths` admits exact ignored application files, subject to the secret and exclusion policies. Secret-policy files in the base tree or index block capture instead of silently disappearing. This is a path policy, not a secret-content scanner or a historical repository audit; enrollment and private publication must apply their own trusted repository policy.

The initial implementation rejects conflicts, submodules, nested repositories, Git LFS pointers, sparse/assume-unchanged indexes, intent-to-add entries, non-UTF-8 paths, case/normalization collisions, and directory symlink traversal. It preserves ordinary files, binary bytes, executable modes and symlinks on compatible filesystems. A Git command's captured output is bounded at 64 MiB. Cross-platform compatibility acceptance, environment preparation, Gitea enforcement, backup and retention remain separate work items. No new app action/UI is introduced at this package boundary.

## Explicit private source transport

`publishCheckpoint` and `fetchCheckpoint` take the manifest, trusted digest, local repository path, and a `CheckpointRemote` previously bound by the host to the same project/repository IDs. The remote is either an SSH URL with a scoped SSH configuration file or a local bare repository for offline transfer. A configuration passed to these functions must come from trusted enrollment, never directly from an agent message. A configured normal `origin` URL is rejected. Neither operation changes remote configuration, normal branches, HEAD, the index, or working files.

Remote branches are `refs/heads/handoff/<checkpointId>/{index,tracked,untracked}`. Publication compares each existing ref with its exact accepted object ID, skips identical refs, rejects any mismatch, and atomically creates missing refs. Empty expected-value leases are used only for creation, so a ref created concurrently cannot be overwritten. No ref is force-updated or deleted. The Gitea service must independently restrict these branches to its Studio automation identity; a client check cannot enforce server authorization. The child proposal/host approval workflow remains a separate host responsibility.

Fetch requests exactly those three branches into a disposable bare staging repository, verifies every object against the trusted manifest, imports objects through a local bundle, and atomically creates only missing local retained refs. Partial or mismatched remote publication never activates a workspace. Idempotent retries return `already-present`; interrupted commands may have transferred bytes or completed publication, so callers retry and verify instead of inferring remote state from cancellation. The return value contains only checkpoint identity, digest and transfer state.

Network Git commands run from disposable repositories with global/system Git configuration disabled, preventing source repository URL rewrite settings from redirecting the configured remote. For SSH, a temporary executable adapter invokes `ssh -F <scoped-config>` using argument arrays, mandatory batch mode and strict host-key checking. The config path is passed privately to the child process; its contents are never read, logged or returned. The SSH configuration must pin the host and project-specific identity. The adapter currently refuses Windows; Windows SSH and live Gitea deploy-key isolation/revocation/protection acceptance have not been validated.

Run the real temporary-repository contract suite with `node --test src/*.test.ts` from this package. It uses local Git repositories without network access and does not modify the developer's repository or Git configuration.
