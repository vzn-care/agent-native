# VZN Corporate Platform — Next Steps Handoff

> Session handoff written 2026-06-15. Goal of this doc: let a fresh session pick
> up the deployment work with full context. Read this top to bottom before acting.

## TL;DR

We are standing up the Agent-Native framework as **one unified internal
corporate platform** for VZN's four business units. Nothing has been built on top
of the fork yet — the next concrete action is **provisioning and deploying a
clean baseline to Vercel + Neon**, then connecting the four Google Workspace
mailboxes. No app code changes are required to get the baseline live.

---

## Where the project sits

- This repo is `vzn-care/agent-native` (remote `origin`), a fork of
  `BuilderIO/agent-native` (remote `upstream`).
- `main` is **0 ahead / 0 behind** both `origin/main` and `upstream/main` — a
  byte-for-byte mirror of upstream. **Nothing has been scoped or built on top of
  the fork yet.** Everything in the repo (framework + 15 templates) is inherited
  from BuilderIO. This is our clean starting point.
- The framework is mature and npm-published (`@agent-native/core` @ 0.49.20).
  We are building on a finished platform, not scaffolding.

### Working-tree state to resolve before deploying

`git status` currently shows uncommitted local changes that should be handled
first so we deploy a true baseline:

- `M AGENTS.md` — `/init` additions from the prior session (Commands +
  Monorepo Layout sections). `CLAUDE.md` is a symlink → `AGENTS.md`. **Keep —
  commit this.**
- `?? .mcp.json` — Plan MCP connector config dropped in by the visual-plan
  skills installer (tooling, not product). Decide: commit or gitignore.
- `D .agents/skills/visual-plan`, `D .agents/skills/visual-recap` — two skill
  dirs showing deleted in the working tree. Confirm whether intended; likely
  restore or leave as-is depending on whether we want those skills tracked.

Recommended: commit the `AGENTS.md` doc change on `main` (Steve's rules say stay
on the current branch), decide on `.mcp.json`/skills, then deploy from clean.

---

## Decisions locked in this session

### 1. Topology: ONE unified deployment (workspace-unified), not separate ones

The framework term **"workspace" = the deployment-level multi-app container**
(one origin, all the bundled template apps). **One deployment = one workspace**;
you cannot nest multiple workspaces under one app. The in-deployment isolation
unit is the **organization** (a fully-isolated tenant).

We chose a **single unified deployment** because every separation factor
collapsed under the requirements:

| Factor | Answer | Implication |
| --- | --- | --- |
| Units share users + data day-to-day? | **Yes** | One system |
| Separate public brands/domains? | **No** (internal tool) | No origin split |
| PHI / clinic data involved? | **No** (corporate level, not clinic level) | No HIPAA isolation needed |
| Data shape | Mostly shared, some unit-specific | One tenant + a unit dimension |

Deploy command (workspace-unified, Vercel):
```bash
npx @agent-native/core@latest deploy --preset vercel
# serves every app under one origin at path prefixes:
#   https://<origin>/mail/*      → templates/mail
#   https://<origin>/calendar/*  → templates/calendar   ...etc
```
Each app gets `APP_BASE_PATH=/<name>`; all apps share `DATABASE_URL`, one login
session, and zero-config same-origin cross-app A2A.

### 2. Business units modeled as a DATA DIMENSION, not organizations

The four units —
- **Mission Optics** (fulfillment lab)
- **Prizma** (software/systems for frames, lens offering, sales, fulfillment)
- **NXTLVL** (coaching/advisory + content/marketing engine)
- **VZN** (digital-native brick-and-mortar vision clinic)

— are **NOT** modeled as separate orgs. Org = *full isolation* (switching orgs
hides all other data), which is the opposite of the "mostly shared, some
unit-specific" requirement. Instead:

- Add a `businessUnit` field (e.g. `mission_optics | prizma | nxtlvl | vzn`) to
  the records that are unit-specific.
- Leave genuinely shared/corporate data **un-scoped** by unit (shared by default).
- Filter by `businessUnit` only in the specific actions/views that need a
  per-unit lens; offer consolidated corporate roll-ups everywhere else.
- This is a per-feature app-data decision made as we build — it does **not**
  block the deployment.
- (If a unit ever needs hard isolation later, *that's* when to reach for orgs.)

### 3. Database: Neon Postgres (one project)

One Neon Postgres project provides `DATABASE_URL` shared across all apps. Local
dev uses throwaway SQLite at `data/app.db` (not durable on Vercel serverless), so
a real `DATABASE_URL` is mandatory for the deploy. **Not yet provisioned** — see
the gate below.

### 4. Mail: works out of the box for all four senders — no code change

Each unit uses a **separate Google Workspace mailbox**. The Mail template already
supports multiple connected Google accounts and a per-send "From" selector:
- Connect each unit's mailbox via the "add account" OAuth flow (the
  `isAddAccount` path adds accounts without replacing the session).
- With >1 account connected, compose shows `FromAccountSelector` — pick the
  unit's address per message.
- Account filtering lets you view one unit's mail or all together.
- The connected mailbox naturally maps to the `businessUnit` dimension.

Only setup needed = **standard Google OAuth credentials/consent** (surfaced in
settings/onboarding). Depending on Workspace admin lockdown, the admin may need
to trust the OAuth app, or each user consents individually — one-time per domain.

Not needed now (deferred): Gmail "send-as" aliases (one account, many sender
addresses) — would be a ~1–2 day add; non-Google/SMTP sending — larger lift.

---

## Next steps (do these tomorrow, in order)

### Gate: do not provision cloud resources until accounts are confirmed
Before creating anything, confirm:
- [ ] **Neon account/org** to deploy into (or create fresh). Neon MCP tools are
      available to list orgs/projects and create a project.
- [ ] **Vercel account/team** to deploy into. Vercel CLI + deploy skills are
      available.
- [ ] **Google OAuth client credentials** available (or create in Google Cloud
      console) for Gmail connect.

### Step 0 — Clean the working tree
- [ ] Commit `AGENTS.md` change on `main`.
- [ ] Decide on `.mcp.json` (commit vs gitignore) and the two deleted skill dirs.
- [ ] Confirm `git status` is clean / intentional before deploy.

### Step 1 — Provision Neon
- [ ] Create one Neon Postgres project (e.g. `vzn-corporate`).
- [ ] Capture the pooled connection string as `DATABASE_URL`.

### Step 2 — Configure the Vercel preset
- [ ] Set `nitro: { preset: "vercel" }` in the workspace `vite.config.ts`
      (verify exact location — workspace-unified build; check
      `agent-native deploy --preset vercel` behavior / docs).
- [ ] Generate `BETTER_AUTH_SECRET`: `openssl rand -hex 32`.

### Step 3 — Wire env + deploy a baseline
- [ ] Set Vercel project env: `DATABASE_URL`, `BETTER_AUTH_SECRET`, plus any
      template-required vars.
- [ ] Deploy from clean `main`:
      `npx @agent-native/core@latest deploy --preset vercel`
      (for Vercel Git builds, the build command uses the `--build-only` variant,
      which writes `.vercel/output` and needs no `vercel.json`).

### Step 4 — Verify the baseline
- [ ] Each `/<app>` route loads (mail, calendar, analytics, etc.).
- [ ] Login works; DB connectivity confirmed (data persists across requests).
- [ ] Create the first account / corporate org.

### Step 5 — Connect Mail
- [ ] Configure Google OAuth credentials in settings/onboarding.
- [ ] Connect all four Workspace mailboxes via "add account".
- [ ] Confirm the "From" selector shows all four; send a test from each.

### Step 6 — Then start building
- [ ] Introduce the `businessUnit` dimension where the first real features need
      it (per-feature, per `adding-a-feature` four-area checklist).

---

## Open questions to confirm next session

- [ ] Which **app set** for the unified deploy — literally all 15 templates
      (incl. `starter` scaffold and `dispatch` infra), or the curated product
      set (mail, calendar, analytics, slides, plan, content, design, assets,
      forms, brain, macros, videos, clips)? (User said "whatever workspace
      unified comes with" — clarify if that means all 15.)
- [ ] Production domain for the unified origin (custom domain vs Vercel default).
- [ ] Which Neon/Vercel/Google accounts/teams to use.
- [ ] First feature to build after the baseline is green.

---

## Reference

- Deployment docs: https://www.agent-native.com/docs/deployment (Vercel section)
- Multi-tenancy: https://www.agent-native.com/docs/multi-tenancy
- Auth/organizations: https://www.agent-native.com/docs/authentication
- Workspace governance: https://www.agent-native.com/docs/workspace-management
- Key Mail files (no change needed for multi-sender, for reference):
  - `templates/mail/actions/send-email.ts` (`account` param selects sender)
  - `templates/mail/server/lib/sender-identity.ts` (already fetches Gmail
    `sendAs`; used only for display name today)
  - `templates/mail/app/components/email/ComposeModal.tsx` (`FromAccountSelector`)
  - `templates/mail/server/handlers/google-auth.ts` (`isAddAccount` flow)
  - `templates/mail/app/hooks/use-account-filter.ts`
- Relevant skills: `adding-a-feature`, `authentication`, `onboarding`,
  `secrets`, `storing-data`, `portability`, `security`.
