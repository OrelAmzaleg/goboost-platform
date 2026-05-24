# GoBoost — Technical Debt

A living list of deferred work and known gaps in the GoBoost UI layer
(`ui-goboost/`). Each item: what's missing, why it was deferred, and what
"done" looks like.

---

## Projects layer

### 1. Repo / local-folder configuration — NOT IMPLEMENTED

**Status:** deferred (2026-05).

The project create + edit modals do **not** expose Paperclip's
"Repo URL" and "Local folder" controls. Paperclip's own `NewProjectDialog`
and the project Configuration tab let the user point a project at a git
repo and/or a local working directory; GoBoost currently omits both.

- **Why deferred:** these write into `executionWorkspacePolicy` (a deep
  jsonb) and/or the separate `POST /projects/:id/workspaces` endpoints —
  the wiring is involved enough that it was cut from the first projects
  pass to keep it shippable.
- **Done =** the project edit modal's Configuration tab has a Codebase
  section: set/change/clear a repo URL, set/change/clear a local folder,
  persisting through the correct endpoint.

### 2. Full `executionWorkspacePolicy` (worktree strategies) — NOT IMPLEMENTED

**Status:** out of scope (2026-05).

`executionWorkspacePolicy` is Paperclip's per-project jsonb that governs
*how an agent gets a working copy of the code when it runs an issue*.
Paperclip's Configuration tab exposes (behind an "isolated checkouts"
toggle): a workspace strategy (`project_primary` / `git_worktree` /
`adapter_managed` / `cloud_sandbox`), a base ref, a branch-name template,
a worktree parent directory, and provision / teardown commands.

GoBoost exposes none of this. It is genuinely advanced (most operators
never touch it) so it was left out entirely.

- **Done =** an "advanced checkout settings" panel in the Configuration
  tab mirroring Paperclip's controls, writing `executionWorkspacePolicy`.

### 3. Project budget — write-only, `windowKind` assumed

**Status:** partial (2026-05).

The edit modal's Budget tab can SET a lifetime budget cap
(`POST /companies/:id/budgets/policies` with `scopeType: "project"`), but:
- It does **not** read the current cap or live spend — that lives in
  Paperclip's cost dashboard.
- `windowKind: "lifetime"` is an **assumption**; not verified against the
  `upsertBudgetPolicySchema` enum. If the POST 400s, the assumption is
  wrong.

- **Done =** confirm the budget-policy schema, read the existing
  project policy from `GET /companies/:id/budgets/overview`, show current
  cap + spend, and edit in place.

---

## Office canvas

### LIVE indicator only renders for the focused agent — NOT IMPLEMENTED globally

**Status:** partial (2026-05-24).

`AgentActionToolbar` shows a green pulsing pip + spinning ⚡ icon
while a heartbeat run is open for the **currently-selected** agent.
The state lives in the toolbar's own React hook (`activeRuns: Map`).

The moment the operator clicks another agent, the toolbar unmounts and
the pip vanishes — even though the original agent is still running. So
the office canvas has no persistent way to tell, at a glance, which
agents are currently working.

- **Why deferred:** a persistent global indicator needs a new shared
  store (`agentLiveRunStore`) subscribed by *every* character overlay,
  not by a transient component. It also needs to coexist with
  `ToolOverlay` and the existing speech-bubble layer without visual
  collision.
- **Done =** every agent with ≥1 active run shows a small LIVE pip
  next to their head on the office canvas regardless of selection /
  hover state; clicking the pip selects the agent and opens the ℹ
  popover on its toolbar.

---

## AgentManagementModal · Configuration tab

These items live inside the per-agent Configuration tab built in
Session 5 (`src/components/AgentManagementModal.tsx`). The tab now
covers ~80% of what Paperclip's own dashboard exposes — the items
below are the deliberate gaps. Each is one row of Paperclip's
Configuration form that we chose NOT to surface in our v1 because the
backing endpoint or UX pattern needed more work than the session
budgeted for. The first three are particularly relevant because the
product owner has flagged that some controls should eventually move
behind an "admin-only" gate (not yet built).

### 1. `defaultEnvironmentId` — NOT IMPLEMENTED

**Status:** deferred (2026-05, Session 5).
**Scope:** Configuration tab → Adapter section.

Paperclip's Configuration form has an "Execution → Default environment"
dropdown that selects which company-defined environment the agent's
runs execute in (the value lands on `agents.defaultEnvironmentId`). It
gates which credentials, working directory, and network policy each
run gets.

- **Why deferred:** we don't yet have a `fetchCompanyEnvironments()`
  endpoint binding, and the environment list shape on the backend
  wasn't investigated. Surfacing a dropdown without options would be
  worse than not surfacing it at all.
- **Done =** new `fetchCompanyEnvironments()` in `paperclipApi.ts`,
  dropdown rendered in the Adapter section above the adapter type,
  patches written via the existing `updateAgent` (the `defaultEnvironmentId`
  field is already in `PaperclipAgentDetail`).

### 2. `dangerouslyBypassSandbox` flag — NOT IMPLEMENTED

**Status:** deferred (2026-05, Session 5).
**Scope:** Configuration tab → adapter-specific flags section.

Paperclip exposes this dangerous flag on certain adapters (claude_local,
acpx_local) that disables the runtime sandbox entirely. We exposed
`dangerouslySkipPermissions` for claude_local but NOT
`dangerouslyBypassSandbox` — it's the one the operator was most likely
to misclick into a destructive setting.

- **Why deferred:** the explicit product direction was "we'll restrict
  some controls to admin-only later". `dangerouslyBypassSandbox` is the
  poster child for that gate. Better to add it once the admin gate
  exists than to ship it as a plain checkbox.
- **Done =** the flag is surfaced behind a future `isAdmin` UI check;
  toggling it requires a confirmation modal with an explicit warning
  that the sandbox will be bypassed.

### 3. `envVars` / `envBindings` — NOT IMPLEMENTED

**Status:** deferred (2026-05, Session 5).
**Scope:** Configuration tab → adapter-specific section.

Paperclip's NewAgent form (third screenshot from the operator) has an
"Environment variables" row with the pattern
`[KEY] [type: Plain/Secret] [value] [Seal]` — a multi-row repeating
editor that supports plaintext + sealed (server-side-resolved-at-runtime)
values. The seal flow stores the value in a credential store and
references it by id rather than raw value.

- **Why deferred:** the UI pattern (dynamic rows + per-row type toggle
  + seal action with a secondary API call) is non-trivial. v1 of the
  tab covers the static config fields only.
- **Done =** dynamic env-var rows with add/remove, Plain/Secret toggle
  per row, and a "Seal" button that calls the credential-vault endpoint
  (whose path we haven't mapped yet — needs investigation against the
  `agent-config-defaults.ts` `envBindings` shape).

### 4. `desiredSkills` — NOT IMPLEMENTED

**Status:** deferred (2026-05, Session 5).
**Scope:** Configuration tab → Skills section (currently a placeholder).

Paperclip's NewAgent form has a "Company skills" checklist of optional
skills from the company library. The schema field is `desiredSkills:
string[]`. Our Skills tab today reads `fetchAgentSkills` (already-
installed skills) but has no picker for adding from the company-wide
library.

- **Why deferred:** we don't yet have a `fetchCompanySkills()` endpoint
  binding; the "company skills library" shape wasn't investigated.
- **Done =** new `fetchCompanySkills()` in `paperclipApi.ts`, a
  multi-select checkbox group in the Skills tab (or in Configuration),
  and `desiredSkills` included in the `updateAgent` patch (already
  declared on `PaperclipAgentDetail`).

### 5. `workspaceStrategyType` + `workspaceBaseRef` + `workspaceBranchTemplate` + `worktreeParentDir` — NOT IMPLEMENTED

**Status:** out of scope (2026-05, Session 5).
**Scope:** Configuration tab → would be a "Workspace policy" subsection.

These keys live on `adapterConfig` and control per-run worktree
behavior (which strategy to use, which git ref to branch from, how
to template branch names, where worktrees go on disk). Paperclip's own
dashboard exposes them only behind an "isolated checkouts" toggle —
they are advanced.

This overlaps with project-level `executionWorkspacePolicy` (already
captured under "Projects layer #2") — the agent-level keys override
the project-level ones. Both need a coordinated UI.

- **Why deferred:** advanced enough that most operators never touch
  them, AND coordinated with the project-level gap above.
- **Done =** a collapsible "Workspace policy" section in the
  Configuration tab with these four controls, plus a project-level
  equivalent (cross-reference Projects #2).

### 6. `metadata` (open-ended JSON) — NOT IMPLEMENTED

**Status:** deferred (2026-05, Session 5).
**Scope:** Configuration tab → no section yet.

`agents.metadata` is a free-form `Record<string, unknown>` that
external tooling sometimes writes to (e.g. tagging agents by team
code or marking them as test fixtures). Paperclip's dashboard doesn't
expose a UI for it either — it's a read-by-API field.

- **Why deferred:** matches Paperclip's own UI (no exposure). Adding a
  JSON editor for a field nobody usually edits would clutter the form.
- **Done =** a read-only JSON viewer at the bottom of Configuration
  (or under an "Advanced" accordion) that displays `metadata` if
  non-empty, so the operator can at least *see* what's there. Editing
  stays API-only until a real need surfaces.

---

## Earlier known gaps (still open)

- **RunsAccordion has no history.** Paperclip exposes no
  `GET /issues/:id/runs`; the chat only shows runs observed live over the
  WebSocket. After a page refresh the accordion is empty until a new run
  starts. Fix needs a backend route or an `activity_log` fallback.

- **JWT attribution in local_trusted mode.** Agent API calls (attachment
  uploads, etc.) are attributed to the `local-board` user because no
  agent JWT is injected. The Tasks Panel works around it with a
  time-correlation heuristic for the agent/user attachment split. Proper
  fix is upstream (Paperclip injecting agent JWTs).

- **`TIMELINE_TICK_ACTIONS` vocabulary unverified.** The chat's timeline
  ticks rely on a hard-coded set of `activity_log` action strings; not
  every one was confirmed against a live backend.
