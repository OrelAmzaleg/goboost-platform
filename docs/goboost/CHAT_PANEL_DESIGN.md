# Chat Panel + Tasks Management — Comprehensive Design

> **Why this document exists.** The first three sub-iterations of the chat panel (2.B.1, 2.B.2.A–E) treated Paperclip's chat as if it were a flat stream of `issue_comments` with three author types. That mental model is **wrong**, and it's why fixing one symptom at a time kept failing: agent messages classified as user, system notices as agent bubbles, questionnaires invisible, confirmations invisible, plans invisible.
>
> Paperclip's chat is **four orthogonal streams** that combine into one timeline. To faithfully surface Paperclip in a visual UI we must adopt the same model. This document maps the full landscape, then specifies the UI that reproduces it.
>
> **No code change is part of this document.** Implementation begins only after you approve the design.

---

## 1. Paperclip's Chat — what it actually is

A single issue's chat thread is built from **five streams** (originally documented as four; updated after operator pointed out that agent-produced files are a distinct fifth surface). All five sort by `createdAt` into one timeline. Each stream has its own data table, its own renderer, its own semantics.

```
┌────────────────────────────────────────────────────────────┐
│                  ISSUE CHAT TIMELINE                       │
│                  (sorted by createdAt)                     │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  Stream 1: issue_comments                                  │
│            ├─ authorType "user"   → user bubble            │
│            ├─ authorType "agent"  → assistant card         │
│            └─ authorType "system" + presentation           │
│                  .kind="system_notice" → notice            │
│                                                            │
│  Stream 2: issue_thread_interactions                       │
│            ├─ suggest_tasks       → plan card              │
│            ├─ ask_user_questions  → form card              │
│            └─ request_confirmation→ approve card           │
│                                                            │
│  Stream 3: timeline events (filtered activity_log)         │
│            ├─ status change       → compact row            │
│            ├─ assignee change     → compact row            │
│            └─ workspace change    → compact row            │
│                                                            │
│  Stream 4: runs                                            │
│            ├─ live run            → expanded card          │
│            └─ historical run      → folded card            │
│                                                            │
│  Stream 5: issue_attachments  ⬅ NEW — agent file output    │
│            ├─ tied to comment (issueCommentId)→ inline     │
│            │     chip beneath the parent bubble            │
│            └─ untied (orphan)     → standalone chip in     │
│                                     timeline at createdAt  │
│                                                            │
│  Plus, in the Tasks Panel side (NOT in chat timeline):    │
│   • issue_work_products  — external deliverables           │
│     (PR links, deployed service URLs, artifact refs)       │
│   • documents + revisions — editable markdown artifacts    │
│     (plan, analysis, summary docs the agent produces)      │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### 1.1 Stream 1 — `issue_comments`

**Schema:** [`packages/db/src/schema/issue_comments.ts`](../../packages/db/src/schema/issue_comments.ts)

Critical fields beyond what we've been using:

| Field | Type | Purpose |
|---|---|---|
| `authorType` | `"user" \| "agent" \| "system"` | 3 values, **not 2**. `system` is the value we missed. |
| `createdByRunId` | uuid \| null | If set, content was generated during an agent run — regardless of who's recorded as the actor. |
| `presentation` | jsonb \| null | **The field that unblocks system-message rendering** — described below. |
| `metadata` | jsonb \| null | Structured content (issue links, code, key-value rows, etc.). |

**`IssueCommentPresentation`** ([`packages/shared/src/types/issue.ts:582`](../../packages/shared/src/types/issue.ts)):

```ts
interface IssueCommentPresentation {
  kind: "message" | "system_notice";
  tone: "neutral" | "info" | "success" | "warning" | "danger";
  title?: string | null;
  detailsDefaultOpen: boolean;
}
```

- `kind: "message"` → render as a dialog bubble (per `authorType`).
- `kind: "system_notice"` → render as an **alert-styled card** with title, tone color, and the metadata rows (not as a dialog bubble at all).

**`IssueCommentMetadata`** — structured rows that the comment can carry:

```ts
type IssueCommentMetadataRow =
  | { type: "text"; text: string }
  | { type: "code"; code: string; language?: string }
  | { type: "key_value"; label: string; value: string }
  | { type: "issue_link"; issueId?: string; identifier?: string; title?: string }
  | { type: "agent_link"; agentId: string; name?: string }
  | { type: "run_link"; runId: string; title?: string }
```

Paperclip's UI renders these inside the system notice as small chips/cards — clickable links to the referenced entity.

### 1.2 Stream 2 — `issue_thread_interactions`

**Schema:** [`packages/db/src/schema/issue_thread_interactions.ts`](../../packages/db/src/schema/issue_thread_interactions.ts)

This is **a separate table from comments**. It's where Paperclip stores **structured two-way prompts** that await human (or system) resolution:

| `kind` | What it is |
|---|---|
| `suggest_tasks` | Agent proposes a list of sub-tasks (the PLAN flow). User accepts → tasks created. Reject → discarded. |
| `ask_user_questions` | Agent asks N typed questions (multiple choice, free text, etc.) — user answers in a form. |
| `request_confirmation` | Agent asks for explicit go/no-go on a destructive or high-stakes step. |

| Field | Type | Purpose |
|---|---|---|
| `kind` | enum above | Determines payload + result shape. |
| `status` | `pending \| accepted \| rejected \| answered \| cancelled \| expired \| failed` | Lifecycle. |
| `payload` | jsonb (typed per kind) | What the agent is asking for. |
| `result` | jsonb (typed per kind) \| null | The human's answer. |
| `sourceRunId` | uuid \| null | Which run produced this prompt. |
| `sourceCommentId` | uuid \| null | If a reply to a specific comment. |
| `continuationPolicy` | `none \| wake_assignee \| wake_assignee_on_accept` | What happens on resolution. |

**These are exactly the "missing flows" the operator reported:** questionnaires, confirmation gates, plan proposals. They've been invisible in our UI because we only listen to comments.

### 1.3 Stream 3 — Timeline events

**Source:** `activity_log` entries filtered to issue-relevant actions.

The TypeScript surface is `IssueTimelineEvent` in [`ui/src/lib/issue-timeline-events.ts`](../../ui/src/lib/issue-timeline-events.ts):

```ts
interface IssueTimelineEvent {
  id: string;
  createdAt: Date | string;
  actorType: "agent" | "user" | "system";
  actorId: string;
  runId?: string | null;
  statusChange?: { from: string | null; to: string | null };
  assigneeChange?: { from: Assignee; to: Assignee };
  workspaceChange?: { from: Workspace; to: Workspace };
  commentId?: string | null;
  followUpRequested?: boolean;
}
```

These are **state-change ticks** — "status: backlog → in_progress", "assignee: dana → yossi". They render as compact one-liners, not bubbles.

We've been showing the agent's `agent.status` events ("running"/"paused") this way visually — but the right things to surface in chat are **issue state changes** (status/assignee/workspace), which come from `activity_log`.

### 1.4 Stream 4 — Runs

A heartbeat run is an execution session for one agent against one or more issues. There are two display modes:

- **Live run** — currently executing. Show a folded card with reasoning, current tool call, output preview. Expandable.
- **Historical run** — completed. Collapsed card with run id, agent, status, "N events", clickable to expand.

Inside a run there's a **transcript** (parsed from stdout by the adapter). Transcript entry kinds (from `IssueChatTranscriptEntry`):

```
"assistant" | "thinking" | "user" | "tool_call" | "tool_result"
| "init" | "result" | "stderr" | "system" | "stdout" | "diff"
```

These are NOT loose bubbles in the chat. They live **inside** the run's folded card. This was the fundamental flaw of our previous "All Activity" tab — we tried to splice transcript-level events into the dialog timeline, which mixes two levels of granularity that should never mix.

### 1.5 Stream 5 — `issue_attachments` (agent file outputs)

**Schema:** [`packages/db/src/schema/issue_attachments.ts`](../../packages/db/src/schema/issue_attachments.ts) + [`packages/db/src/schema/assets.ts`](../../packages/db/src/schema/assets.ts)

An attachment is a binary file the agent (or user) uploaded — a screenshot, a PDF, a CSV report, an Excel deliverable. The data is split across two tables:

- `assets` — the actual file blob. Fields: `provider` ("s3"/"gcs"/"local"), `objectKey`, `contentType`, `byteSize`, `sha256`, `originalFilename`, `createdByAgentId` or `createdByUserId`.
- `issue_attachments` — the issue→asset link. Fields: `issueId`, `assetId`, **`issueCommentId`** (nullable — links the file to a specific comment), `createdAt`.

**The critical relationship:** an attachment can be **tied to a specific comment** via `issueCommentId`. When an agent posts a comment AND uploads a file, the upload's `issueCommentId` points at that comment. This is what produces the inline-file-under-message UX in Paperclip's classic dashboard — the file isn't a separate timeline item; it's an extension of its parent bubble.

If `issueCommentId` is null (orphan attachment, e.g., uploaded outside any comment), the attachment becomes a standalone timeline item at its `createdAt`.

**Endpoints:**
- `GET /api/issues/:id/attachments` — list all attachments for the issue.
- `GET /api/attachments/:attachmentId/content` — stream the file body (download).
- `POST /api/companies/:companyId/issues/:issueId/attachments` — agent or user upload.
- `DELETE /api/attachments/:attachmentId` — remove the link + underlying asset.

### 1.6 Tasks Panel side — Work Products + Documents

The remaining two output types live **on the issue, but not in the chat timeline** — they belong to the Tasks Panel:

**`issue_work_products`** ([schema](../../packages/db/src/schema/issue_work_products.ts)) — **external deliverables**:
- `type`: `"preview_url" | "runtime_service" | "pull_request" | "branch" | "commit" | "artifact" | "document"`.
- `provider`: which external system ("github", "aws", "custom"…).
- `url`: direct link to the artifact.
- `status`: `active | ready_for_review | approved | changes_requested | merged | closed | failed | archived | draft`.
- `isPrimary`, `healthStatus`, `reviewState`, `summary`, `metadata`.
- `createdByRunId` → traceable back to the agent run that produced it.

Endpoints: `GET /api/issues/:id/work-products`, `POST` to create, `PATCH /api/work-products/:id` to update status.

**`documents` + `document_revisions`** ([schema 1](../../packages/db/src/schema/documents.ts), [schema 2](../../packages/db/src/schema/document_revisions.ts)) — **editable markdown artifacts** with full revision history:
- Conventional keys: `"plan"`, `"analysis"`, `"summary"`, `"continuation-summary"` (system-managed), plus custom keys.
- Each revision: `revisionNumber`, `body`, `changeSummary`, `createdByAgentId`/`createdByUserId`, `createdByRunId`.
- Versioned, lockable, restorable.

Endpoints: `GET /api/issues/:id/documents`, `GET /api/issues/:id/documents/:key`, `PATCH` for updates, `GET /:key/revisions` for history.

**Why these two go in the Tasks Panel, not the chat:**
1. **Work products** are persistent state about the issue (a PR exists, a service is deployed). Their value is in their *current state*, not in their timeline appearance. They're better surfaced as a status-board next to the issue tree.
2. **Documents** are long-form artifacts the agent edits over time. The latest revision is the source of truth — showing 17 timeline bubbles "doc updated · doc updated · doc updated" is noise.

That said, **the chat does reference them**: a comment can include a `run_link` metadata row pointing at the run that produced a work product or document revision, and the system notice that announces creation usually has tone="info" + title="Created plan document" so the operator gets the chat-side cue.

### 1.7 What about `heartbeat_run_events` (WS `heartbeat.run.event`)?

Those are the **per-line stream** of an in-progress run. Paperclip's own UI does **not** render them as dialog timeline items. They're consumed inside the live run card to update transcript state — not as chat bubbles.

So our previous instinct (route `heartbeat.run.event` → ephemeral "thinking" strip) was correct *visually* but conceptually misplaced. The "thinking" indicator we built is fine **as a status indicator for the active live run**, but it shouldn't pretend to be part of the chat conversation.

---

## 2. UI Mapping — how each stream renders in our panel

The operator should see ONE scrollable conversation timeline. Each stream gets a visually distinct treatment so the operator knows what kind of thing each item is — without having to read the technical metadata.

### 2.1 The 9 visual primitives

| # | Primitive | Source | Visual style | Side |
|---|---|---|---|---|
| 1 | **User bubble** | `issue_comments` `authorType=user`, presentation `kind=message`, NO `createdByRunId` | Green WhatsApp bubble (current) | start (RTL = right) |
| 2 | **Agent bubble** | `issue_comments` `authorType=agent` OR `createdByRunId` set | Light-gray "incoming" bubble | end (RTL = left) |
| 3 | **System notice card** | `issue_comments` `presentation.kind=system_notice` | Alert card: icon + tone color (info/success/warning/danger) + title + body + metadata rows | full width, centered |
| 4 | **Plan card** | `issue_thread_interactions` `kind=suggest_tasks` | Card with list of proposed tasks + ✓ Accept / ✗ Reject actions | full width |
| 5 | **Question card** | `issue_thread_interactions` `kind=ask_user_questions` | Card with form (multiple choice / text inputs per question) + Submit | full width |
| 6 | **Confirmation card** | `issue_thread_interactions` `kind=request_confirmation` | Compact card with prompt + Confirm / Reject buttons | full width |
| 7 | **Timeline tick** | activity_log → `IssueTimelineEvent` | Single line: "Status: backlog → in_progress · דנה · 14:32" | center, small, muted |
| 8 | **Attachment chip** (tied) | `issue_attachments` WHERE `issueCommentId` matches a comment in view | Inline chip under the parent comment bubble — file icon by `contentType`, filename, byteSize, click → download | inherits side from parent bubble |
| 9 | **Attachment chip** (orphan) | `issue_attachments` WHERE `issueCommentId IS NULL` | Standalone chip at `createdAt` — file icon + filename + size + creator + download | centered, mid-width |

Plus two card types **outside** the main timeline:

- **Live run card** — pinned to the bottom (above input), shows current run in progress.
- **Historical run card** — appears inline at the run's `startedAt` time; collapsed by default; expand to see transcript.

### 2.2 Mapping concrete operator concerns to the visual

| Operator concern from feedback | Fixed by |
|---|---|
| "Agent's important content shown in green like my message" | Primitive #2 — proper agent bubble determined by `authorType=agent` OR `createdByRunId`. |
| "System messages shown as gray agent bubble" | Primitive #3 — `presentation.kind=system_notice` becomes a proper alert card. |
| "Issue description doesn't appear in chat" | The origin bubble we already added stays — it's a synthetic stream-0 item. |
| "Questionnaires (GOB-7) shown only in classic UI" | Primitive #5 — `ask_user_questions` interactions render as form cards. |
| "Confirmation/Pending not shown" | Primitive #6 — `request_confirmation` interactions render as approve cards. |
| "PLAN that agent creates not shown" | Primitive #4 — `suggest_tasks` interactions render as plan cards with accept/reject. |
| "All Activity tab feels irrelevant" | Tab removed (Sub E). Heartbeat run events become **status indicator only** for the live run card; not bubbles. |
| "Files / downloadable links from the agent" | Primitive #8 (tied) + #9 (orphan) — attachments render as chips inline with the comment they belong to, or standalone in the timeline. Long-form docs go to the Tasks Panel; external deliverables (PRs, deployments) also there. |

### 2.3 Tasks Panel (the right-side drawer) — what changes

The Tasks Panel keeps its current purpose (showing the issue's structural view) but gains **three new sections**, one per persistent-state stream that doesn't belong in the chat timeline:

- **Documents section** — pull `GET /api/issues/:id/documents`. List by `key` (e.g. `"plan"`, `"analysis"`, `"summary"`). For each: title, last-updated, "by <agent name>". Click → expand inline to show the latest revision's markdown body (with a "📜 history" affordance for the revision list). The operator can download each doc as `.md`.
- **Work Products section** — pull `GET /api/issues/:id/work-products`. Each row shows: type icon (PR / service / artifact / preview), title, status pill, provider, direct-link button if `url` present. Status changes update live via WS.
- **Approvals section** — pull approvals via `issue_approvals` junction. List of approval rows with type, status, decision note, decided-by, decided-at. This is the audit list (pending approvals also surface in the chat as Confirmation Cards / Question Cards, but the audit history lives here permanently).
- The current "success criteria" stays placeholder until Phase 3 (Methodology Port).

---

## 3. Data — what we need to fetch and subscribe to

### 3.1 REST endpoints (initial load when an issue becomes active)

Already used:
- `GET /api/issues/:id/comments?order=asc` — Stream 1.

To add:
- `GET /api/issues/:id/interactions` — Stream 2. **Already exists** (confirmed during discovery).
- `GET /api/issues/:id/heartbeat-context` OR a derived endpoint for **runs of this issue**. (Discovery needed — the exact endpoint Paperclip's UI uses for `linkedRuns` and `liveRuns`.)
- `GET /api/issues/:id/documents` + per-key revision fetch — for the Tasks Panel additions.
- `GET /api/companies/:id/activity?entityType=issue&entityId=...` (or similar) — Stream 3 timeline events. (Discovery needed — Paperclip's UI builds `IssueTimelineEvent[]` from activity log filtered to the issue; we need to find the endpoint.)

### 3.2 WS event handling (live updates)

Already wired:
- `activity.logged` — refresh comments.

To add:
- `activity.logged` with `entityType=interaction` → refetch interactions list.
- `activity.logged` with `entityType=issue` and `action ∈ {status_changed, assignee_changed, workspace_changed}` → refetch timeline events (or build event row inline from payload).
- `heartbeat.run.queued` + `heartbeat.run.status` for the **active issue** → drive the live-run card state.
- `heartbeat.run.event` → stays as the per-line stream that updates the live-run card's transcript preview. NOT inserted into the main timeline.

### 3.3 Mutation endpoints (interactions need resolution)

Already used:
- `POST /api/issues/:id/comments`.

To add:
- Resolving `suggest_tasks` → POST to accept/reject endpoint (discovery needed).
- Answering `ask_user_questions` → POST result.
- Resolving `request_confirmation` → POST confirm/reject.

### 3.4 New types in `paperclipApi.ts`

- `PaperclipInteraction` (discriminated union by `kind`).
- `PaperclipDocument`, `PaperclipDocumentRevision`.
- `PaperclipTimelineEvent` (status/assignee/workspace change).
- `PaperclipRun` (live + historical, with transcript preview).
- `subscribeInteractionChanges`, `subscribeTimelineEvents`, `subscribeRunChanges` (or merge under one event router).

---

## 4. Component decomposition

```
WhatsAppPanel.tsx           ← orchestrator (existing)
├── ChatHeader               ← agent name + buttons + session picker (existing)
├── ChatTimeline             ← NEW — handles 4-stream merge + render
│   ├── OriginBubble         ← existing (issue description as first item)
│   ├── UserBubble           ← existing (refined)
│   ├── AgentBubble          ← NEW (split from current "agent" path)
│   ├── SystemNoticeCard     ← NEW (replaces current system pill)
│   ├── PlanCard             ← NEW (suggest_tasks)
│   ├── QuestionCard         ← NEW (ask_user_questions)
│   ├── ConfirmationCard     ← NEW (request_confirmation)
│   ├── TimelineTickRow      ← NEW (status/assignee/workspace changes)
│   ├── LiveRunCard          ← NEW (active run preview)
│   └── HistoricalRunCard    ← NEW (folded completed run)
├── ThinkingStrip            ← existing — REPURPOSED as live-run status indicator
├── ChatInput                ← existing (refined: disabled when active interaction blocks input?)
└── TasksPanel.tsx
    ├── IssueHeader          ← existing
    ├── DescriptionBlock     ← existing
    ├── StepsList            ← existing
    ├── DocumentsSection     ← NEW (plan/work-product/etc.)
    └── ApprovalsSection     ← NEW (linked approvals)
```

Each card type is a small focused component (50–120 lines each). The orchestrator's job is simplified: pull from 4 streams, sort, dispatch to the right component per item.

---

## 5. Sub-iteration sequence

The current "iteration 2.B.2.E" is the final coat of paint on the wrong shape. We replace it with a clean re-architecture. The remaining work in Phase 2.B becomes:

### Iteration 2.B.3 — Comment presentation + system notice card (no API changes)
- Add `presentation` and `metadata` to `PaperclipComment` type.
- Rewrite the system-message renderer to read `presentation.kind=system_notice` and render an alert card with tone + title + metadata rows.
- Fix the agent vs user classifier to **also check `authorType=system`** before any other test (system messages currently fall through to the "agent" branch via `createdByRunId`).
- Re-test the GOB-7 thread (and similar) — system notices should now look right.

### Iteration 2.B.4 — Interactions (the big missing piece)
- Discovery: locate Paperclip's UI fetch + WS handling for interactions; clone the patterns.
- Add `fetchIssueInteractions`, `resolveInteraction*` helpers to `paperclipApi.ts`.
- Subscribe to interaction lifecycle WS events.
- Build PlanCard, QuestionCard, ConfirmationCard.
- Merge interactions into the chat timeline by `createdAt`.
- Operator can resolve each from inside our UI.

### Iteration 2.B.5 — Timeline ticks
- Discovery: which activity-log entries does Paperclip's UI surface in the chat.
- Add fetch + WS handler for timeline events.
- Build TimelineTickRow.
- Splice into the chat timeline.

### Iteration 2.B.6 — Runs (live + historical)
- Discovery: confirm endpoints for `linkedRuns`/`liveRuns`.
- Build LiveRunCard (pinned, uses existing thinking strip data).
- Build HistoricalRunCard (collapsed inline).
- Existing `heartbeat.run.event` subscription stays — now feeds live run card, not loose bubbles.

### Iteration 2.B.7 — Attachments inline in chat
- Add `fetchIssueAttachments(issueId)` to paperclipApi.
- Add WS handler for `activity.logged` with `action="issue.attachment_added"` → refetch.
- Build AttachmentChip component (tied + orphan variants).
- Splice tied attachments **beneath their parent comment bubble** in `ChatTimeline`.
- Splice orphan attachments **as standalone timeline items** at their `createdAt`.
- Wire download via `GET /api/attachments/:id/content`.

### Iteration 2.B.8 — Tasks Panel: Work Products + Documents + Approvals
- Fetch and render the three new sections in the Tasks Panel (described in §2.3).
- Documents section: expandable markdown viewer + revision history link.
- Work Products: typed icons + status pills + url links.
- Approvals: audit list with decision details.

After 2.B.8 — **Phase 2.B is genuinely complete**. Then 2.C (Hierarchy-Derived Layout).

---

## 6. Acceptance criteria for the whole rework

A reasonable end-of-2.B.8 test scenario:

1. Operator clicks an agent in the office → chat loads.
2. **Origin bubble**: the issue's title + description (existing).
3. Agent posts a `suggest_tasks` plan → **plan card appears**, with the proposed sub-tasks listed. Accept → tasks created in Paperclip, plan card flips to "accepted".
4. Agent asks `ask_user_questions` → **form card** with the questions. Submit → form card flips to "answered" with the submitted values shown.
5. Agent requests `request_confirmation` for a destructive action → **confirm card** with the prompt + Confirm/Reject. Decision → card flips state.
6. Throughout, status changes (backlog → todo → in_progress) appear as **compact timeline rows** between bubbles.
7. While the agent runs → **live run card** at the bottom shows transcript preview (current thinking + last tool call).
8. After run finishes → live card collapses into a **historical run card** inline at the run's start time.
9. System notices (e.g. "Paperclip needs a disposition") appear as **alert cards**, distinct from dialog bubbles.
10. Agent uploads a file as part of a comment → **attachment chip appears beneath that comment's bubble**, clickable to download.
11. Orphan attachments (no parent comment) appear as **standalone chips at their createdAt** position in the timeline.
12. The Tasks Panel shows:
    - **Documents** section with the PLAN markdown body + revision history.
    - **Work Products** section listing PR/service/artifact links with status pills.
    - **Approvals** section with the audit list.

If the above passes naturally for any issue, we've faithfully surfaced Paperclip in our visual UI — without losing any flow.

---

## 7. What this design intentionally is NOT

- **Not a wholesale rewrite of pixel-agents.** We keep the office, the canvas, the agent character system, the panel structure (header / timeline / input / tasks panel).
- **Not a re-skin.** Each new card is functionally distinct — operators can ACT on interactions inside our UI, not just see them.
- **Not Phase 3 (Methodology Port).** Our 4-step ritual, success criteria, etc. land later. Right now we're just reproducing what Paperclip already provides.
- **Not opening multi-company switching.** Stays auto-pick.

---

## 8. Risk register

- **Discovery is needed in 2.B.4, 2.B.5, 2.B.6** — some endpoints and WS event shapes need verification against the codebase. We do this BEFORE writing UI code each iteration (one round trip with curl/grep, not a guessing game). This is the discipline the prior approach skipped.
- **Interaction `payload` and `result` are typed per-kind.** Each kind needs its own form schema. The work is bounded but real.
- **WS event for interaction lifecycle** — confirm Paperclip emits it before subscribing speculatively.

---

## What I need from you

1. **Sign off on the 5-stream model** as the correct mental model (comments / interactions / timeline ticks / runs / attachments — with work products and documents in the Tasks Panel side).
2. **Confirm the 9-primitive visual taxonomy** in the chat timeline + the 3-section Tasks Panel additions match the UX you want — or push back specifically.
3. **Confirm the sub-iteration sequence** (2.B.3 → 2.B.8 in that order).
4. **Decide:** start now with 2.B.3 (it's a pure-UI rewrite, no API discovery needed — safest first step), or do you want to also revert 2.B.2.E's half-done work first?

Once you sign off, I commit this document, then start 2.B.3 with the discipline this document calls for.
