# Agent-Native / VZN Integration — Local Status Handoff

**Generated:** 2026-06-14
**Repo:** `/Users/chris/dev/agent-native`
**Branch:** `main` @ `cd8603af8` (tip)

---

## Git State

- **Branch:** `main`
- **HEAD:** `cd8603af8` chore: version packages (#1197)
- **Key commit:** `b4e6e9198` Support local file resources in agent context (#1196) — Steve Sewell, Jun 14 09:54 PDT

### Working tree modifications (unstaged)

| Status | Path | Notes |
|--------|------|-------|
| `D` | `.agents/skills/visual-plan` | Git tracks as file; disk has directory with SKILL.md + references. Typechange — skills EXIST on disk. |
| `D` | `.agents/skills/visual-recap` | Same typechange issue. Skills EXIST on disk. |
| `M` | `AGENTS.md` | +48 lines: added Commands section (pnpm install, dev, lint, test, guards, prep) |
| `??` | `.mcp.json` | New untracked: MCP server pointing to `https://plan.agent-native.com/_agent-native/mcp` |
| `??` | `.claude/settings.local.json` | New untracked: enables `plan` MCP server |

---

## Local File Resources Feature (#1196)

### What it does

Enables agents to read/write files from the local workspace as "resources" that appear in the agent context alongside SQL-backed workspace resources. Files are loaded with metadata (hash, size, mime type, timestamps) and served through the existing resource store.

### Key files created/changed (34 files, +2501 / -122 lines)

**Core framework (`packages/core`):**
- `src/local-artifacts/index.ts` — NEW `LocalWorkspaceResourceMeta`, `LocalWorkspaceResourceFile` types; `loadLocalWorkspaceResource()`, `writeLocalWorkspaceResource()`; 2MB file size cap
- `src/local-artifacts/index.spec.ts` — 214 lines of tests
- `src/resources/store.ts` — +218 lines: effective context merges local + SQL resources
- `src/resources/store.effective-context.spec.ts` — 109 lines of tests
- `src/resources/handlers.ts` — local resource handler registration
- `src/resources/handlers.spec.ts` — 99 lines of tests
- `src/cli/recap.ts` / `recap.spec.ts` — recap CLI support for local resources

**Desktop app (`packages/desktop-app`):**
- `src/main/index.ts` — +206 lines: IPC handlers for local file access (read/write/list), path normalization, security guards
- `shared/ipc-channels.ts` — new IPC channel definitions

**Plan template (`templates/plan`):**
- `app/lib/local-control-resources.ts` — 131 lines: reads AGENTS.md, agent-native.json, .mcp.json, .agents/skills/ from local disk into agent context
- `app/lib/local-control-resources.test.ts` — 33 lines
- `app/pages/PlansPage.tsx` — +147 lines: UI for local file sync
- `server/lib/visual-recap-validation.ts` — 232 lines: validates visual recap wireframes
- `server/lib/visual-recap-validation.spec.ts` — 93 lines
- `actions/create-visual-recap.ts` — minor changes for source URL support

**Content template (`templates/content`):**
- `app/lib/local-control-resources.ts` — 211 lines (fuller version with content-specific logic)
- `app/lib/local-control-resources.test.ts` — 60 lines
- `app/routes/_app.local-files.tsx` — 113 lines: local files UI route

### Test coverage

Tests exist for:
- `local-artifacts/index.spec.ts` (214 lines) — core load/write/hash/validate
- `resources/handlers.spec.ts` (99 lines) — handler registration & routing
- `resources/store.effective-context.spec.ts` (109 lines) — context merging
- `plan/app/lib/local-control-resources.test.ts` (33 lines) — path normalization
- `content/app/lib/local-control-resources.test.ts` (60 lines) — control file reads
- `plan/server/lib/visual-recap-validation.spec.ts` (93 lines) — wireframe validation

**NOTE:** Tests could NOT be executed — `node_modules` not installed (`pnpm install` not run). Tests are present and appear comprehensive.

### Docs

- `packages/core/docs/content/workspace.md` — documents SQL workspace resources; local file mode mentioned as alternative
- `packages/core/docs/content/embedding-sdk.md` — references local resources for MCP clients
- Root `AGENTS.md` (modified) — now documents Local File Mode: "Explicit Local File Mode artifacts declared through `agent-native.json` may use repo files as the source of truth"

---

## Plan App (`plan.agent-native.com`) — OAuth / Connection State

### What we know

- **MCP connection configured:** `.mcp.json` at repo root points to `https://plan.agent-native.com/_agent-native/mcp`
- **Claude Code enabled:** `.claude/settings.local.json` enables the `plan` MCP server
- **Plugin MCP:** `.agents/plugins/agent-native-visual-plans/.mcp.json` also points to `plan.agent-native.com`
- **Browser evidence:** OAuth flow to `plan.agent-native.com` reached "Connected" page title (from daily report)

### What needs human confirmation

- [ ] **Google OAuth configured on hosted plan app?** The `.env.example` shows `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` as optional. No `.env` file found locally — credentials would be on the hosted server. **Human should verify:** does `plan.agent-native.com` show "Continue with Google" on the login screen?
- [ ] **MCP endpoint reachable?** Test by calling `https://plan.agent-native.com/_agent-native/mcp` from an agent (Claude Code / Codex) to confirm the connection works.
- [ ] **Visual plan skills functional?** The `.agents/skills/visual-plan/` and `.agents/skills/visual-recap/` directories exist on disk with SKILL.md files. Git shows a typechange (tracked as files, now directories) which may cause sync issues. **Human should verify:** do `/visual-plan` and `/visual-recap` slash commands work in the hosted app?

### No secrets exposed

No `.env` files found (only `.env.example`). No tokens, keys, or credentials were read or modified.

---

## Action Items

1. **Run `pnpm install`** to install dependencies, then `pnpm test` to verify the local-resource test suite passes.
2. **Verify hosted plan app:** log into `plan.agent-native.com`, confirm Google OAuth works, test MCP connection from an agent.
3. **Resolve git typechange:** the `visual-plan` and `visual-recap` skill directories show as deleted because git tracked them as files. Either `git add` them (to track as directories) or investigate why they changed type.
4. **Stage/commit AGENTS.md changes** if the +48 line Commands section addition is intentional.
5. **Decide on `.mcp.json`** — commit it to repo or add to `.gitignore` depending on whether it should be shared.
