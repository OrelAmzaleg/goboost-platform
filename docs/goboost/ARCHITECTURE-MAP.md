# Paperclip Architecture Map (as of fork point, Paperclip v0.3.1)

Goal of this document: enable any GoBoost contributor to understand the Paperclip core well enough to (a) extend it via the GoBoost layer without duplicating, (b) decide for each prototype concept whether to **Port / Replace / Add / Drop**, and (c) recognize where our methodology learnings hook in.

> **Convention.** When Paperclip uses one word and our prototype uses another for the same thing, the table notes both. **Paperclip's term wins** in the new codebase.

---

## 0. Top-Level Layout

```
goboost-platform/
├── cli/                    # `paperclipai` CLI — onboard, worktree, configure, doctor, run
├── server/                 # Express REST API + orchestration
│   └── src/
│       ├── adapters/       # Server-side adapter integration (registry, plugin loader, http/process bridges)
│       ├── routes/         # ~30 route files (one per domain)
│       ├── services/       # ~50 service files (business logic)
│       ├── auth/, middleware/, realtime/, secrets/, storage/, types/
│       └── app.ts, index.ts
├── ui/                     # React + Vite SPA
│   └── src/
│       ├── pages/          # Domain pages: Agents, Issues, Goals, Costs, Approvals, Dashboard, ...
│       ├── components/, hooks/, api/, context/, lib/
│       ├── adapters/       # UI-side adapter registry (mirrors server)
│       ├── plugins/        # UI-side plugin contributions
│       └── i18n/           # Translation infrastructure (already exists — easy to add Hebrew)
├── packages/
│   ├── adapters/           # Adapter implementations:
│   │   ├── claude-local, codex-local, cursor-local, cursor-cloud,
│   │   ├── gemini-local, grok-local, opencode-local, openclaw-gateway,
│   │   └── acpx-local, pi-local
│   ├── adapter-utils/      # Shared types + utilities (`ServerAdapterModule`, etc.)
│   ├── db/                 # Drizzle schema (~80 tables), migrations, client, backups
│   ├── mcp-server/         # Paperclip exposed as MCP server (gold for GoBoost layer)
│   ├── plugins/            # Plugin SDK + examples + sandbox providers
│   └── shared/             # Cross-package types, constants, validators, telemetry, api paths
├── skills/                 # Skills directory (markdown-based, ships with the install)
├── evals/, doc/, docker/, patches/, releases/, report/, scripts/, tests/
├── AGENTS.md, ROADMAP.md, README.md, adapter-plugin.md
└── CLAUDE.md (ours), docs/goboost/ (ours)
```

**3 key insights:**
1. **Workspace monorepo** (pnpm) — server + ui + packages live together. Changes to shared/db types ripple through compile-time checks.
2. **Adapter implementations are first-class packages** under `packages/adapters/` — each adapter is its own npm package. External adapters (like Hermes) follow the same shape and load via the plugin system.
3. **`packages/mcp-server/`** — Paperclip already publishes itself as an MCP server. The GoBoost layer can talk to Paperclip over MCP if we ever want layer-to-layer isolation.

---

## 1. Task Model (Paperclip calls them **Issues**)

**Source of truth:** `packages/db/src/schema/issues.ts` + `server/src/services/issues.ts`.

### Core Schema

```ts
issues {
  id, companyId, projectId, projectWorkspaceId, goalId, parentId
  title, description
  status                       // 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled'
  workMode                     // default 'standard' (likely also 'review')
  priority                     // 'low' | 'medium' | 'high'
  assigneeAgentId              // single-assignee
  assigneeUserId               // OR a human, not both
  checkoutRunId, executionRunId, executionAgentNameKey, executionLockedAt
  createdByAgentId / createdByUserId
  issueNumber, identifier      // human-readable code like GOB-42
  originKind                   // 'manual' | 'routine_execution' | 'harness_liveness_escalation' | ...
  originId, originRunId, originFingerprint
  requestDepth                 // recursion depth — hierarchy of nested requests
  billingCode
  assigneeAdapterOverrides     // jsonb — per-issue adapter config
  executionPolicy              // jsonb — execution policy
  executionState               // jsonb — escape hatch for adapter-specific state
  monitorNextCheckAt, monitorWakeRequestedAt, monitorLastTriggeredAt, monitorAttemptCount
  executionWorkspaceId, executionWorkspacePreference, executionWorkspaceSettings
  startedAt, completedAt, cancelledAt, hiddenAt
  createdAt, updatedAt
}
```

### Status Machine

`backlog → todo → in_progress → in_review → done`. Also `blocked` (waiting on dependency) and `cancelled`. Default is `backlog`.

### Hierarchy

**Sub-tasks live in the same table.** `parentId` self-references `issues.id`. There is **no embedded `plan[]` array** like our prototype had. Every "step" in our prototype's decomposition becomes a **child issue** here. This is actually a cleaner model — each step gets first-class status, assignee, cost tracking, audit log.

### Atomic Checkout

`checkoutRunId` + `executionRunId` + `executionLockedAt` give Paperclip atomic "this issue is being worked on by this run, no double-checkout". Critical for multi-agent safety.

### Related Tables (the rich extension surface)

| Table | What it stores |
|---|---|
| `issue_comments` | Conversation threads on an issue |
| `issue_documents` / `documents` + `document_revisions` | Documents attached to an issue, with revision history |
| `issue_attachments` / `assets` | File attachments |
| `issue_relations` | Blocker dependencies (`depends_on`, `blocks`) |
| `issue_work_products` | Outputs the agent produced |
| `issue_labels` / `labels` | Tagging |
| `issue_inbox_archives`, `issue_read_states` | Per-user inbox/read tracking |
| `issue_recovery_actions` | When things go wrong, what to do |
| `issue_reference_mentions` | @-mention tracking |
| `issue_tree_holds`, `issue_tree_hold_members` | Pause/hold sub-trees |
| `issue_thread_interactions` | Comment/interaction events |
| `issue_approvals` | Approval gates per issue |
| `issue_execution_decisions` | Decisions made during execution |

### Mapping from our Prototype

| Prototype concept | Paperclip equivalent | Decision |
|---|---|---|
| `Task` | `issues` | **Port** — same shape, more fields |
| `Task.plan[]` (steps array) | child issues with `parentId` | **Replace** — Paperclip's model is cleaner |
| `Task.success_criteria` | **Doesn't exist natively** | **Add** (via `executionState` jsonb OR new table) |
| `Task.stage` (planning/executing/reviewing) | implicit in `status` + `workMode` | **Port** with mapping |
| `Task.enriched_context` | `documents` + `issue_documents` | **Port** |
| `PlannedStep.expected_output` | doesn't exist | **Add** — critical for our 4-step ritual |

---

## 2. Agent Model

**Source of truth:** `packages/db/src/schema/agents.ts` + `server/src/services/agents.ts`.

### Schema

```ts
agents {
  id, companyId, name
  role                          // default 'general' — free text
  title, icon
  status                        // default 'idle' — 'idle' | 'running' | 'paused' | 'error'
  reportsTo                     // self-reference — strict tree, single boss
  capabilities                  // free text
  adapterType                   // 'process' | 'http' | 'claude-local' | 'codex-local' | 'hermes' | ...
  adapterConfig                 // jsonb — adapter-specific config (model, system prompt, etc.)
  runtimeConfig                 // jsonb — runtime params (heartbeat interval, max turns, etc.)
  defaultEnvironmentId
  budgetMonthlyCents, spentMonthlyCents
  pauseReason, pausedAt         // governance pause mechanism
  permissions                   // jsonb — flexible permission model
  lastHeartbeatAt               // for monitoring
  metadata                      // jsonb escape hatch
  createdAt, updatedAt
}
```

### Lifecycle

`idle ↔ running` for normal work. `paused` (board pauses, budget hard-stop, or self-pause). `error` for transient failure. Pause/resume is first-class; the field is `pauseReason` (text) and `pausedAt` (timestamp).

### Org Chart

Built on `reportsTo` (single parent, no graph). The whole org chart is a recursive query on that one column. SVG rendering at `server/src/routes/org-chart-svg.ts`.

### Hire/Approval

`onHireApproved` lifecycle hook on the adapter (see Adapter Contract) — fires when board approves a new agent. Tables `join_requests` + `invites` + `agent_config_revisions` track the lifecycle.

### Related Tables

| Table | What it stores |
|---|---|
| `agent_api_keys` | Bearer tokens for agent → API auth |
| `agent_config_revisions` | Versioned config history (for rollback) |
| `agent_runtime_state` | Runtime state snapshot |
| `agent_task_sessions` | Session persistence per (agent, adapter, taskKey) |
| `agent_wakeup_requests` | Wake queue |

### Mapping from our Prototype

| Prototype `AgentProfile` field | Paperclip equivalent | Decision |
|---|---|---|
| `id`, `name`, `nameEn`, `role`, `roleEn` | `id`, `name`, `role`, `title` | **Port** (collapse to single `name` + `title`) |
| `color` | `metadata.color` | **Port** to metadata |
| `defaultRoom` | UI-only (visualization) | **Port** to metadata |
| `persona`, `soul`, `agentDocument`, `skills`, `skillsDetailed` | `adapterConfig.systemPrompt` + `metadata.persona` etc. + skills via `company_skills` | **Port** — multiple destinations |
| `tools` | `company_skills` (filtered per agent) | **Replace** — go through Paperclip's skills system |
| `goals` | Paperclip's `goals` table — separate top-level entity, agent can be `ownerAgentId` | **Replace** — better model |
| `brainContextNeeded`, `brainWrites` | Need to add — Paperclip has no Brain concept | **Add** (Brain is GoBoost IP) |
| `connectsTo`, `escalatesTo` | `reportsTo` + permissions | **Port** with mapping |
| `triggers` | `routines` + `agent_wakeup_requests` | **Replace** — Paperclip's mechanism is richer |

---

## 3. Adapter Contract — The Heart

**Source of truth:** `packages/adapter-utils/src/types.ts` (the `ServerAdapterModule` interface).

### Required Methods

```ts
interface ServerAdapterModule {
  type: string;
  execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>;
  testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult>;
}
```

### Optional but Important

```ts
  listSkills?(ctx): Promise<AdapterSkillSnapshot>;
  syncSkills?(ctx, desiredSkills: string[]): Promise<AdapterSkillSnapshot>;
  sessionCodec?: AdapterSessionCodec;
  sessionManagement?: AdapterSessionManagement;
  models? / listModels? / refreshModels?
  modelProfiles? / listModelProfiles?
  detectModel?(): { model, provider, source, candidates }
  getConfigSchema?(): AdapterConfigSchema    // declarative form schema — JSON, not React!
  onHireApproved?(payload, config): HireApprovedHookResult
  getQuotaWindows?(): ProviderQuotaResult
  getRuntimeCommandSpec?(config): { command, detectCommand, installCommand }
```

### Capability Flags

```ts
supportsLocalAgentJwt?: boolean
supportsInstructionsBundle?: boolean        // AGENTS.md bundle support
instructionsPathKey?: string                // default 'instructionsFilePath'
requiresMaterializedRuntimeSkills?: boolean // write skills to disk before invocation
```

### `AdapterExecutionContext` (input to `execute`)

```ts
{
  runId, agent, runtime,
  config, context,
  runtimeCommandSpec, executionTarget,
  onLog(stream, chunk),         // adapter feeds stdout/stderr → server, line by line
  onMeta(meta),                 // invocation metadata (command, env, args)
  onSpawn({pid, processGroupId, startedAt}),
  authToken
}
```

### `AdapterExecutionResult` (output)

```ts
{
  exitCode, signal, timedOut,
  errorMessage?, errorCode?, errorFamily?,    // 'transient_upstream' triggers retry
  retryNotBefore?, errorMeta?,
  usage?: { inputTokens, outputTokens, cachedInputTokens },
  sessionId?, sessionParams?, sessionDisplayId?,  // session continuity
  provider?, biller?, model?, billingType?,
  costUsd?,                                    // adapter reports its own cost
  resultJson?,                                 // free-form result
  runtimeServices?,                            // dev servers, preview URLs
  summary?,                                    // human-readable
  clearSession?,                               // reset session on next run
  question?                                    // back-ask the user
}
```

### `TranscriptEntry` — Critical for GoBoost UI

This is the **parsed adapter output stream**. The adapter emits raw text via `onLog`, and adapter-specific parsers convert each line into typed entries:

```ts
type TranscriptEntry =
  | { kind: "assistant", ts, text, delta? }
  | { kind: "thinking", ts, text, delta? }
  | { kind: "user", ts, text }
  | { kind: "tool_call", ts, name, input, toolUseId? }
  | { kind: "tool_result", ts, toolUseId, toolName?, content, isError }
  | { kind: "init", ts, model, sessionId }
  | { kind: "result", ts, text, inputTokens, outputTokens, cachedTokens, costUsd, subtype, isError, errors }
  | { kind: "stderr", ts, text }
  | { kind: "system", ts, text }
  | { kind: "stdout", ts, text }
  | { kind: "diff", ts, changeType, text }
```

**This is the hook for our 5-Layer Tool Visualization Bridge.** Every `tool_call` and `tool_result` entry from any adapter feeds our viz layer for free. **No adapter changes needed — we just subscribe to the stream.**

### Registry (`server/src/adapters/registry.ts`)

Mutable map. `registerServerAdapter(adapter)` / `unregisterServerAdapter(type)` / `requireServerAdapter(type)`. Built-ins register on startup; external plugins register via `plugin-loader.ts` reading `~/.paperclip/adapter-plugins.json`.

### Built-in Adapters (under `packages/adapters/`)

`claude-local`, `codex-local`, `cursor-local`, `cursor-cloud`, `gemini-local`, `grok-local`, `opencode-local`, `openclaw-gateway`, `acpx-local`, `pi-local`. Hermes is intentionally **external** — installed as `@henkey/hermes-paperclip-adapter` via plugin manager.

### Two Adapter Styles

- **`server/src/adapters/process/`** — subprocess style (Codex, Claude Code CLI, Hermes via CLI)
- **`server/src/adapters/http/`** — HTTP webhook style (OpenClaw gateway)

---

## 4. Skills Format

**Source of truth:** `packages/db/src/schema/company_skills.ts` + `server/src/services/company-skills.ts` + the `/skills/` directory.

### Schema

```ts
company_skills {
  id, companyId
  key                             // unique per company
  slug, name, description
  markdown                        // the skill body — Anthropic Skills format
  sourceType                      // default 'local_path' — also 'http', 'inline'
  sourceLocator                   // path/URL where it lives
  sourceRef                       // version/commit ref
  trustLevel                      // default 'markdown_only' — also 'code' for trusted
  compatibility                   // default 'compatible'
  fileInventory                   // jsonb — list of files in the skill bundle
  metadata
}
```

### Skill = Markdown + Optional Files

Skills follow the **Anthropic Skills convention**: a markdown file with frontmatter (name, description, etc.) and optional supporting files in the same bundle. `fileInventory` tracks the bundle's files.

### Sync to Adapter

`AdapterSkillSnapshot` (from adapter contract) lists what skills the adapter currently has. `syncSkills(ctx, desiredSkills)` lets Paperclip push the desired set to the adapter (e.g. write to `~/.hermes/skills/`).

### Dual-Source Pattern (`AdapterSkillEntry`)

```ts
origin: "company_managed"      // managed by Paperclip, toggle from UI
       | "paperclip_required"  // required for Paperclip integration (heartbeat skill)
       | "user_installed"      // user dropped a file there
       | "external_unknown"
```

This is **exactly the dual-source pattern** the Hermes-Paperclip adapter README described. We get it for free.

### Mapping from our Prototype

| Prototype concept | Paperclip equivalent | Decision |
|---|---|---|
| `ToolDefinition` (our Tool Contract) | `company_skills` row + adapter-side execution | **Replace** — adopt their format |
| `mockBehavior` | None — adapter runs the real thing | **Drop** (mocks are prototype-only) |
| `brainBinding` | Need to add — Brain is GoBoost concept | **Add** (in metadata jsonb) |
| `input_schema` / `output_schema` | Lives in the skill markdown frontmatter | **Port** to Anthropic format |
| Tool icons | metadata or skills convention | **Port** to metadata |

---

## 5. Org Chart + Delegation

### Org Chart

**Mechanism:** `agents.reportsTo` — single self-reference. Strict tree (one boss per agent). The whole org chart is a recursive query.

**UI surface:** SVG rendering at `server/src/routes/org-chart-svg.ts`. Pages: `ui/src/pages/Agents.tsx`, `OrgChart.tsx`.

### Delegation

**Paperclip has no `delegate_to_agent` tool.** Instead, delegation = **create a child issue and assign it to a different agent**.

```
Parent agent (CEO) creates issue with assigneeAgentId=worker_id, parentId=current_issue.
Worker's heartbeat picks up the new issue.
Worker does the work, sets status='done'.
Parent's heartbeat sees the child completed (or polls), continues.
```

The control flow is **issue-tree-shaped**, not "manager calls worker function". This decouples agents — they only see issues assigned to them. Far cleaner for multi-agent isolation.

### Mapping from our Prototype

| Prototype concept | Paperclip equivalent | Decision |
|---|---|---|
| 3-level hierarchy (CEO → MM → Workers) | `reportsTo` tree of any depth | **Port** — Paperclip's is more flexible |
| `delegate_to_agent` tool | "create child issue + assign" pattern | **Replace** — semantically equivalent, model-driven |
| `evaluate_subtask_result` tool | check child issue status + comments | **Replace** |
| `request_revision` tool | reopen child issue with new comment | **Replace** |
| `bubbleUp` pattern (sub-agent messages → CEO) | issue comments cascade up parent tree | **Port** — different mechanism, same outcome |
| `linkChildTask` runtime helper | implicit in `parentId` on issue creation | **Replace** |

---

## 6. Heartbeats + Execution

**Source of truth:** `agent_wakeup_requests` + `heartbeat_runs` + `agent_task_sessions` tables.

### The 3-Layer Execution Model

```
agent_wakeup_requests           → queue of "wake agent X for reason Y"
       ↓
heartbeat_runs                  → one row per actual execution
       ↓
agent_task_sessions             → persistent session per (agent, adapter, taskKey)
                                  for `--resume` style continuity
```

### `agent_wakeup_requests`

- `source` — 'cron' | 'webhook' | 'mention' | 'manual' | etc.
- `coalescedCount` — multiple wakeups for the same agent collapse into one
- `idempotencyKey` — duplicate suppression
- `claimedAt`, `finishedAt` — claim semantics (atomic checkout from queue)

### `heartbeat_runs`

- Tracks: `status`, `startedAt`, `finishedAt`, `exitCode`, `signal`
- Stream excerpts: `stdoutExcerpt`, `stderrExcerpt`, plus full log via `logStore` + `logRef`
- Usage: `usageJson` (tokens), `resultJson` (adapter return value)
- **Session continuity:** `sessionIdBefore` / `sessionIdAfter` — what session did we resume from, what did we leave behind
- Process: `processPid`, `processGroupId`, `processStartedAt`
- Liveness monitoring: `livenessState`, `livenessReason`, `lastUsefulActionAt`
- Retry chain: `retryOfRunId`, `processLossRetryCount`, `scheduledRetryAt`, `scheduledRetryAttempt`, `scheduledRetryReason`
- Recovery: `nextAction`, `contextSnapshot` (jsonb!) — context preserved across runs
- Continuation: `continuationAttempt`

### `agent_task_sessions`

- Unique per `(companyId, agentId, adapterType, taskKey)` — one session per task per adapter
- `sessionParamsJson` — adapter-specific session data (Hermes session ID, Claude conversation ID, etc.)
- `sessionDisplayId` — human-readable session reference
- `lastRunId` — most recent run that used this session
- `lastError` — last failure on this session

### Implications

**Paperclip already implements what we deferred as Phase 13a (Conversation Memory).** Session continuity, context snapshots, `--resume`-style adapter integration — all there. We don't need to build conversation memory; we need to **wire our GoBoost agents to it**.

---

## 7. Cost Tracking + Budgets

**Source of truth:** `cost_events` + `budget_policies` + `budget_incidents`.

### `cost_events` — Per-call usage ledger

```ts
{
  companyId, agentId, issueId?, projectId?, goalId?, heartbeatRunId?,
  billingCode?, provider, biller, billingType, model,
  inputTokens, cachedInputTokens, outputTokens,
  costCents,
  occurredAt
}
```

Every adapter execution that returns a `usage` block emits a `cost_events` row. Indexed by company+agent+time, company+provider+time, company+biller+time. Aggregation is fast for any dimension.

### `budget_policies` — Limits

```ts
{
  companyId, scopeType, scopeId,        // 'company' | 'project' | 'agent' | 'issue' + id
  metric,                                // 'billed_cents' | 'input_tokens' | 'output_tokens'
  windowKind,                            // 'daily' | 'weekly' | 'monthly' | 'rolling_30d'
  amount,
  warnPercent,                           // default 80
  hardStopEnabled,                       // pause agent when hit
  notifyEnabled,
  isActive
}
```

Multi-scope: policy can target a single agent, a project, an issue, or the whole company.

### `budget_incidents` — When breached

```ts
{
  companyId, policyId, scopeType, scopeId,
  metric, windowKind, windowStart, windowEnd,
  thresholdType,                         // 'warn' | 'hard_stop'
  amountLimit, amountObserved,
  status,                                // 'open' | 'resolved' | 'dismissed'
  approvalId?                            // links to an approval to lift the stop
}
```

**Implication:** Cost tracking is built-in and structured. Our prototype had no cost tracking — this is a major capability we gain for free.

---

## 8. Governance — Approvals + Activity Log

### `approvals` Table

```ts
{
  id, companyId, type,                   // 'agent_hire' | 'budget_override' | 'destructive_action' | ...
  requestedByAgentId / requestedByUserId,
  status,                                // 'pending' | 'approved' | 'rejected' | 'cancelled'
  payload,                               // jsonb — type-specific
  decisionNote, decidedByUserId, decidedAt
}
```

### `activity_log` Table

Immutable audit log for **every mutating action**:

```ts
{
  companyId,
  actorType,                             // 'system' | 'agent' | 'user'
  actorId, action,
  entityType, entityId,
  agentId?, runId?,
  details                                // jsonb
}
```

Every mutating API write is supposed to emit an activity log row (per AGENTS.md rules).

### Rollback Mechanism

`agent_config_revisions` table holds versioned agent configs. `governance with rollback` from the README isn't a magic time-machine — it's "versioned configs + apply old revision".

### Mapping from our Prototype

| Prototype concept | Paperclip equivalent | Decision |
|---|---|---|
| `request_approval` tool | `approvals` table + governance flow | **Replace** |
| Approval levels (MANAGER / CRITICAL / HUMAN) | `approvals.type` field — can encode levels | **Port** with mapping |
| Audit | `activity_log` | **Replace** — already done |

---

## 9. React UI Structure

**Source of truth:** `ui/src/` (Vite + React + TypeScript).

### Top-Level

```
ui/src/
├── App.tsx, main.tsx, index.css       # entry
├── pages/                              # one file per page (~30 pages)
├── components/                         # shared components
├── hooks/                              # custom React hooks
├── api/                                # API client (server endpoints)
├── context/                            # React context providers
├── lib/                                # utilities
├── adapters/                           # UI-side adapter registry (mirrors server, dynamic)
├── plugins/                            # UI-side plugin contributions
├── i18n/                               # 🟢 translation infrastructure ALREADY EXISTS
├── fixtures/                           # test fixtures
└── Storybook config under ui/storybook/
```

### Key Pages (alphabetical)

`Activity`, `AdapterManager`, `AgentDetail`, `Agents`, `Approvals`, `ApprovalDetail`, `BoardClaim`, `CliAuth`, `Companies`, `CompanyAccess`, `CompanyEnvironments`, `CompanyExport`, `CompanyImport`, `CompanyInvites`, `CompanySettings`, `CompanySkills`, `Costs`, `Dashboard`, `DashboardLive`, `DesignGuide`, `ExecutionWorkspaceDetail`, `GoalDetail`, `Goals`, `Inbox`, ... (and more for issues, plugins, projects, routines).

### Key UX Surfaces We'll Touch (in priority order for Phase 2)

| Surface | What we change |
|---|---|
| Global `index.css` + Tailwind config | RTL plugin, Heebo font, Hebrew defaults |
| `i18n/` | Switch to Hebrew-primary, English-fallback |
| `App.tsx` shell | RTL wrapper, GoBoost branding |
| `Dashboard.tsx` + `DashboardLive.tsx` | The page customers see first |
| `pages/Agents.tsx` + `pages/AgentDetail.tsx` | Where org chart + agent inspection happens |
| `pages/Goals.tsx` + `pages/Issues.tsx` | The core work surfaces |
| New page: `OfficeView` | Phaser scene + 5-layer viz (GoBoost-only) |
| New page: `CompanyWizard` | Wraps the existing onboarding |

### Decision Pivot Point

The pages are well-modularized — we can `Wrap` (good for admin pages we don't need to brand) rather than `Replace` (for customer-facing pages). i18n already exists, which means **Hebrew RTL is additive, not a replacement**. This is the best-case scenario for Phase 2.

---

## 10. API Endpoints

**Source of truth:** `server/src/routes/index.ts` + each `routes/*.ts`.

### Mounted Route Modules

```
healthRoutes              /api/health
companyRoutes             /api/companies
companySkillRoutes        /api/companies/:id/skills
agentRoutes               /api/agents, /api/companies/:id/agents
projectRoutes             /api/projects
issueRoutes               /api/issues
issueTreeControlRoutes    /api/issues/:id/tree
routineRoutes             /api/routines
goalRoutes                /api/goals
approvalRoutes            /api/approvals
secretRoutes              /api/secrets
costRoutes                /api/costs
activityRoutes            /api/activity
dashboardRoutes           /api/dashboard
sidebarBadgeRoutes        /api/sidebar/badges
sidebarPreferenceRoutes   /api/sidebar/preferences
inboxDismissalRoutes      /api/inbox/dismissals
llmRoutes                 /api/llms
accessRoutes              /api/access
instanceSettingsRoutes    /api/instance/settings
instanceDatabaseBackupRoutes  /api/instance/database/backups
```

(There are more route files than the index — likely 30+ total. See `ls server/src/routes/` for the full list.)

### Auth Model (per AGENTS.md §8)

- Base path: `/api`
- **Board users** (humans) — full-control operator context
- **Agents** — bearer API keys via `agent_api_keys`, hashed at rest
- **Run JWTs** — short-lived tokens per execution
- **Two deployment modes** — `local_trusted` (no auth) and `authenticated` (with `private` / `public` exposure)

### HTTP Errors

Consistent set: `400/401/403/404/409/422/500`.

### Mutation Discipline (per AGENTS.md §5)

Every mutating endpoint must:
1. Apply company access checks
2. Enforce actor permissions (board vs agent)
3. Write activity log entries
4. Return consistent HTTP errors

---

## 11. Implications for the GoBoost Layer (the IP audit, post-fork)

This is the key section. Now that we know what Paperclip provides, we can **finally** see exactly what GoBoost adds on top.

### What Paperclip already provides (we don't build)

| Capability | Paperclip's mechanism |
|---|---|
| Multi-tenancy (Company isolation) | Every entity has `companyId` |
| Task model with hierarchy | `issues` + `parentId` |
| Single-assignee task | `assigneeAgentId`/`assigneeUserId` constraint |
| Atomic task checkout | `checkoutRunId` + `executionLockedAt` |
| Org chart hierarchy | `agents.reportsTo` |
| Delegation between agents | Create child issue with different assignee |
| Adapter contract (Claude/Hermes/Codex/...) | `ServerAdapterModule` interface |
| Skills management + sync | `company_skills` + adapter `syncSkills` |
| Cost tracking per agent/project/goal/issue/provider | `cost_events` table |
| Budgets + hard-stops + warn thresholds | `budget_policies` + `budget_incidents` |
| Approval workflow + audit log | `approvals` + `activity_log` |
| Heartbeat scheduling + wakeup queue | `agent_wakeup_requests` + `heartbeat_runs` |
| **Session continuity** (Conversation Memory) | `agent_task_sessions` + `sessionIdBefore/After` |
| Context snapshot persistence | `heartbeat_runs.contextSnapshot` jsonb |
| Process loss recovery + retries | Built into `heartbeat_runs` |
| Liveness monitoring | `livenessState`, `monitor*` fields |
| Versioned agent configs (rollback) | `agent_config_revisions` |
| Plugin system + external adapter loading | `~/.paperclip/adapter-plugins.json` |
| Company export/import (portability) | `company-portability.ts` service |
| Secrets management (per-company vaults) | `company_secrets` + `secret_access_events` |
| Multi-channel UI (chat threads on issues) | `issue_comments` + `issue_thread_interactions` |
| **MCP server (Paperclip exposes itself)** | `packages/mcp-server/` |

### What GoBoost adds on top (our actual IP)

| Capability | Where it lives |
|---|---|
| **Hebrew RTL UI** | i18n + Tailwind RTL plugin + CSS theme |
| **Office Visualization** (Phaser scene + characters + rooms) | New page `OfficeView` + Phaser canvas + state binding |
| **5-Layer Tool Visualization Bridge** | Subscribe to `TranscriptEntry` stream, fire 5 UI surfaces |
| **Wizards** (Company / Agent / Sector) | New pages, walk users through with Hebrew copy |
| **Sector presets** (Israeli market — law, accounting, etc.) | New entity (could be jsonb in `company.metadata` or new table) |
| **Israeli tools pack** (חשבונית ירוקה, Gmail RTL, Calendar) | Skills bundled with the install |
| **Integration playbook** | Documentation + onboarding workshop templates |
| **Brain concept** (organizational shared state) | Net new — could be `company_documents` + retrieval layer |
| **WhatsApp UI pattern** (chat-first interaction) | New page + maps to issue comments under the hood |

### What needs to be Added (no Paperclip equivalent)

| Methodology learning | How to add |
|---|---|
| **Success criteria** (`step.success_criteria_ids`) | Add via `executionState` jsonb OR new table `issue_success_criteria` |
| **`expected_output` per step** | Same as above — could be on metadata |
| **4-step ritual for worker** (announce → tool → verify → complete) | Adapter config OR system prompt template per agent role |
| **Slice-from-plan** (sub-agent sees `step.description` not free text) | Convention in how we create child issues + how prompt is built |
| **Cross-iteration tool fire gate** | Adapter-level patch OR wrapper |
| **Memory taxonomy** (Conversation vs Brain vs World) | Conversation is given. Brain we add. World stays in our UI layer |

### Migration Decisions Summary (from prototype → goboost-platform)

| Prototype concept | Decision |
|---|---|
| `Task` model | **Port** → `issues` |
| `Task.plan[]` | **Replace** → child issues with `parentId` |
| `Task.success_criteria` | **Add** → jsonb or new table |
| `AgentProfile` | **Port** → `agents` + jsonb metadata fields |
| `Tool Contract` | **Replace** → `company_skills` (Anthropic Skills format) |
| `delegate_to_agent` tool | **Replace** → create child issue pattern |
| `evaluate_subtask_result` | **Replace** → read child issue status |
| `request_revision` | **Replace** → reopen child issue |
| `request_approval` | **Replace** → `approvals` table |
| Brain (organizational state) | **Add** → new layer (probably a plugin) |
| Office-runner 4-step ritual | **Add** → adapter config + prompt |
| Slice-from-plan | **Add** → in our prompt builder |
| Cross-iteration tool gate | **Add** → adapter patch or wrapper |
| 5-Layer Viz Bridge | **Add** → subscribe to TranscriptEntry stream |
| Hebrew RTL UI | **Add** → i18n + Tailwind |
| Office Visualization | **Add** → new page with Phaser |
| Wizards | **Add** → new pages |
| Sector presets | **Add** → new layer |
| Israeli tools | **Add** → as skills |
| Conversation Memory (Phase 13a) | **Drop** (build) — Paperclip gives us this for free via sessions |
| Mock generator | **Drop** — Paperclip runs real adapters |
| Browser-direct `dangerouslyAllowBrowser` | **Drop** — Paperclip is server-mediated |

### The Strategic Picture

**~70% of what we had to build from scratch in the prototype is now provided by Paperclip.** Our actual differentiation is concentrated in:

1. **Hebrew RTL UI + Office Visualization + 5-Layer Viz** — UX layer
2. **Sector presets + Israeli tools + Brain** — content + retrieval layer
3. **Methodology adds** (success criteria, 4-step ritual, slice-from-plan) — small surgical additions
4. **Integration playbook + trusted-integrator positioning** — business model

**This is good news.** It means Phase 3 (Methodology Port) is smaller than we estimated, and Phase 2 (UI Wrapper) becomes the dominant phase. We may also retire the Phase 13a (Conversation Memory) we deferred from the prototype — Paperclip's session model covers it.

The new question for the next planning iteration: **should we deepen `mcp-server` so the GoBoost layer talks to Paperclip over MCP rather than direct DB?** That would give us a clean separation and future-proof us against Paperclip upstream changes. Worth raising at the end of Horizon 1.
