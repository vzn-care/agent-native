# Framework baseline and fork compatibility

The framework integration starts at upstream Desktop `v0.1.293`, commit
`c0215ef5ee74192c56ae8f66f5e44bacbf2e55f7`, rather than advancing the older fork
in place. The fork-only change reviewed was
`e3a2bf8bf86f7b32489296ea6008df9715eb91d1` (workspace build concurrency).
Existing branches and the customized web workspace remain separate.

## Concurrency reconciliation

The pinned upstream already implements concurrent app builds in
`packages/core/src/deploy/workspace-deploy.ts`. It has a bounded worker pool,
stops scheduling after a failure, awaits in-flight builds, reports their
failures, and assembles artifacts in deterministic app order. These implementations
are retained; the older deployment file was not cherry-picked over them.

The public configuration contract from the fork was missing:

| Behavior                                           | Pinned upstream                         | Integrated behavior                                                                    |
| -------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------- |
| `deployment.workspace.buildConcurrency`            | Not recognized                          | Positive integer or `"auto"`                                                           |
| `--concurrency 2` / `--concurrency=2`              | Not consumed                            | Overrides resolved configuration                                                       |
| `AGENT_NATIVE_DEPLOY_CONCURRENCY`                  | Direct numeric environment read         | Existing alias in the public config environment layer; also accepts `auto`             |
| Canonical config environment name                  | Not recognized                          | `AGENT_NATIVE_CONFIG_DEPLOYMENT_WORKSPACE_BUILD_CONCURRENCY`                           |
| Programmatic `runWorkspaceDeploy({ concurrency })` | Not exposed                             | Highest-priority explicit override                                                     |
| Unconfigured default                               | Up to three builds, CPU-limited         | One build, preserving the fork's sequential default                                    |
| Automatic sizing                                   | CPU-limited default only                | CPU and memory limits; approximately 4 GiB per app build, with cgroup memory respected |
| Scheduling and output assembly                     | Bounded pool and deterministic assembly | Retained                                                                               |

For CLI users, precedence is:

1. `--concurrency`.
2. Canonical config environment value, or the legacy alias when the canonical
   value is absent.
3. `deployment.workspace.buildConcurrency` from the resolved config file.
4. `1`.

The `concurrency` API option is only a programmatic override and takes precedence
over the CLI flag when a caller supplies both. Environment values flow through
the existing public config resolver; deployment code has no separate environment
read for this setting. Invalid configuration and flags fail explicitly. Flags
are validated before existing deployment output is removed.

Example configuration:

```ts
export default defineAgentNativeConfig({
  deployment: { workspace: { buildConcurrency: "auto" } },
});
```

`auto` reserves one CPU when possible, budgets 4 GiB per app build, uses the
smaller of host memory and a positive process memory constraint, and always
allows at least one build. Explicit integers are operator-selected limits and
are not reduced automatically.

The upstream process-spawning, buffered output, and per-app timing implementation
is retained rather than restoring the fork's older logging implementation. The
fork's final scaffold change was a commented configuration example, not an
enabled automatic-concurrency setting; starter defaults remain unchanged.
The historical translated documentation was not copied over newer upstream docs;
this document records the integration's compatibility contract.

## Verification

- Existing config and workspace deployment suites: **136 tests passed** across
  two files.
- Tests exercise actual bounded scheduling for configuration, both CLI forms,
  environment aliases, their precedence, API override, and sequential default.
- Automatic sizing is exercised with a container memory limit below host memory.
- Invalid flags preserve existing output; the existing in-flight failure and
  deterministic artifact checks remain covered.
- Core `tsc --noEmit` passed. Core build passed, including CLI compilation and
  generated distribution import checks.

Validation used the checkout's pinned pnpm `10.29.1`. No deployment was published.
