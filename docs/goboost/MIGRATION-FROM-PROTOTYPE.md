# Migration from Prototype (`goboost-ai-platform`) → `goboost-platform`

This document is the **authoritative migration ledger**. Every concept that existed in the prototype gets one of four decisions:

| Decision | Meaning |
|---|---|
| **Port** | Concept exists in Paperclip in a similar shape — adapt and bring it over (adjust types, names) |
| **Replace** | Paperclip has a better mechanism — abandon prototype implementation, use Paperclip's |
| **Add** | Concept is GoBoost-specific — Paperclip has no equivalent — net-new in our layer |
| **Drop** | Concept was prototype-only (mocks, browser-direct API calls, deferred ideas) — do NOT carry over |

Companion to [ARCHITECTURE-MAP.md](./ARCHITECTURE-MAP.md). Read that first for context on Paperclip's structure.

---

## How to use this ledger

When you start a port task, find the prototype concept in the tables below. The "Decision" + "Target location" + "Notes" tell you what to do. The "Phase" column points to which GoBoost phase the work belongs to (Phase 2 = UI Wrapper, Phase 3 = Methodology Port, Phase 4+ = later horizons).

---

## Table 1 — Domain Model

| Prototype concept | Source file | Decision | Target in goboost-platform | Phase | Notes |
|---|---|---|---|---|---|
| `Task` | `src/types/task.ts` | **Port** | `issues` table | 3 | Same shape, Paperclip has more fields (origin tracking, monitoring, atomic checkout) |
| `Task.plan[]` (steps as embedded array) | `src/types/task.ts` | **Replace** | child issues via `parentId` self-ref | 3 | Each step becomes a first-class issue with own status/assignee/cost. Cleaner model |
| `Task.stage` (`planning` / `executing` / `reviewing`) | `src/types/task.ts` | **Port** | `issues.status` + `workMode` jsonb | 3 | Status carries most of it; remainder in metadata |
| `Task.success_criteria` | `src/types/task.ts` + delegation logic | **Add** | new table `issue_success_criteria` OR `issues.executionState.successCriteria` jsonb | 3 | **Critical for our IP — Paperclip has no native success criteria** |
| `PlannedStep.expected_output` | `src/types/task.ts` | **Add** | per-step (child issue) `executionState.expectedOutput` jsonb | 3 | Required by our 4-step ritual's verify step |
| `Task.origin` | `src/types/task.ts` | **Port** | `issues.originKind` + `originId` + `originRunId` | 3 | Paperclip's model is richer |
| `Task.enriched_context` | `src/types/task.ts` | **Port** | `documents` + `issue_documents` | 3 | Paperclip has versioned documents (`document_revisions`) — bonus |
| `AgentTask` (runtime task envelope) | `src/services/agents/types.ts` | **Drop** | — | — | Was a prototype artifact for in-memory passing; not needed once Paperclip's issue model owns flow |

---

## Table 2 — Agent Model

| Prototype concept | Source file | Decision | Target | Phase | Notes |
|---|---|---|---|---|---|
| `AgentProfile.id, name, nameEn, role, roleEn` | `src/types/agent.ts` | **Port** | `agents.id`, `agents.name`, `agents.role`, `agents.title` | 3 | Collapse Hebrew/English duality; UI shows both via i18n |
| `AgentProfile.color` | `src/types/agent.ts` | **Port** | `agents.metadata.color` jsonb | 3 | UI-only data, fits metadata |
| `AgentProfile.icon` | `src/types/agent.ts` | **Port** | `agents.icon` (Paperclip has the column) | 3 | Direct field exists |
| `AgentProfile.defaultRoom` | `src/types/agent.ts` | **Port** | `agents.metadata.defaultRoom` | 3 | GoBoost Visualization-only |
| `AgentProfile.persona` | `src/types/agent.ts` | **Port** | `agents.adapterConfig.persona` + system prompt | 3 | Persona feeds the adapter's system prompt |
| `AgentProfile.soul` (essence/tone/values/worldview) | `src/types/agent.ts` | **Port** | `agents.metadata.soul` + folded into adapter system prompt | 3 | Structured fields stay, prompt is built from them |
| `AgentProfile.skills` (text labels) | `src/types/agent.ts` | **Port** | `agents.capabilities` (free text) | 3 | One-line summary |
| `AgentProfile.skillsDetailed` | `src/types/agent.ts` | **Port** | `agents.metadata.skillsDetailed` | 3 | UI rendering |
| `AgentProfile.agentDocument` (system-prompt-shaped MD) | `src/types/agent.ts` | **Port** | `agents.adapterConfig.systemPrompt` or `instructionsFilePath` | 3 | Adapter contract supports instruction bundles (AGENTS.md style) |
| `AgentProfile.tools` (id list) | `src/types/agent.ts` | **Replace** | per-agent allow-list referencing `company_skills.key` | 3 | Go through Paperclip's skills, don't reinvent |
| `AgentProfile.goals` (metric/target) | `src/types/agent.ts` | **Replace** | `goals` table + `ownerAgentId` | 3 | Paperclip's goals are richer, hierarchical |
| `AgentProfile.brainContextNeeded` / `brainWrites` | `src/types/agent.ts` | **Add** | new `agents.metadata.brain` jsonb (GoBoost concept) | 3-4 | Brain is our addition; bindings stay declarative |
| `AgentProfile.connectsTo` | `src/types/agent.ts` | **Port** | `agents.permissions` jsonb + UI-level routing | 3 | Permissions field gives us a place |
| `AgentProfile.escalatesTo` | `src/types/agent.ts` | **Port** | implied by `agents.reportsTo` | 3 | The tree direction is upward by default |
| `AgentProfile.triggers` | `src/types/agent.ts` | **Replace** | `routines` table + wakeup mechanism | 3 | Paperclip's routines are way more powerful (cron + webhook + idempotency) |
| `AgentState` (runtime position/status/facing) | `src/types/agent.ts` | **Drop** | live only in Phaser scene's runtime state | 2 | Was prototype world-state; doesn't persist |
| `Hierarchy` model (CEO + MMs + Workers) | `src/types/hierarchy.ts` | **Port** | derived from `reportsTo` recursion + optional level tag in `agents.metadata.level` | 3 | Same intent, simpler mechanism |
| Office-Runner template + 4-step ritual | `src/content/agents/office-runner-template.ts` | **Port + Add** | new agent template stored as `agents.adapterConfig.systemPrompt` template; ritual enforced via prompt + adapter-side patches | 3 | The template ports; the runtime guards (cross-iteration block) port to adapter level |

---

## Table 3 — Tool & Skill System

| Prototype concept | Source file | Decision | Target | Phase | Notes |
|---|---|---|---|---|---|
| `ToolDefinition` (input/output schemas + mockBehavior + brainBinding) | `src/types/tool-contract.ts` | **Replace** | `company_skills` table + adapter `syncSkills` flow | 3 | Adopt Anthropic Skills format (markdown + frontmatter). Each tool becomes a skill |
| Tool input/output JSON schemas | `src/types/tool-contract.ts` | **Port** | embedded in skill markdown frontmatter | 3 | Standard Anthropic Skills convention |
| `mockBehavior` (sync forced-tool-use generator) | `src/services/llm/MockGenerator.ts` + tool defs | **Drop** | — | — | Was a prototype workaround. Paperclip runs real adapters; no mocks at runtime |
| `brainBinding` (declared brain reads/writes per tool) | `src/types/tool-contract.ts` | **Add** | skill metadata extension (`metadata.brainBinding`) | 3-4 | Brain is GoBoost-only; binding is metadata Paperclip ignores |
| Tool icons (`tools-real/*.svg`) | `public/icons/tools-real/` | **Port** | move into the corresponding skill bundle's `fileInventory` | 3 | Lives alongside skill markdown |
| `create_excel`, `create_word`, `create_powerpoint`, `create_pdf` | `src/content/tools/create-*.ts` | **Port** | as skills, with the Anthropic xlsx/docx/pptx skills as backing | 3 | Adapter calls the Anthropic skill behind the scenes; user-visible tool is GoBoost-branded |
| Israeli tools (gmail-RTL, calendar-he, חשבונית ירוקה, monday-basic, phone-lookup) | (planned, not built) | **Add** | new skill bundles in our skills/ directory | 3 | Net-new content from the prototype roadmap |
| `ToolSchemaTranslator` (our → Anthropic tool_use translator) | `src/services/llm/ToolSchemaTranslator.ts` | **Drop** | adapter handles its own translation | — | Was a prototype shim against Anthropic SDK direct calls |

---

## Table 4 — Execution & Delegation

| Prototype concept | Source file | Decision | Target | Phase | Notes |
|---|---|---|---|---|---|
| `AgentExecutor` (tool-use loop) | `src/services/agents/AgentExecutor.ts` | **Replace** | Paperclip's heartbeat execution engine + adapter `execute()` | 3 | Don't carry our loop — Paperclip has a robust one with retries, liveness, atomic checkout |
| `Delegation.ts` (`runDelegation`, hierarchy guard, depth cap, bubbleUp) | `src/services/agents/Delegation.ts` | **Replace** | child-issue creation + `reportsTo` enforcement at API level | 3 | Different mechanism, same intent |
| `delegate_to_agent` tool | `src/services/agents/system-tool-handlers.ts` | **Replace** | API endpoint: `POST /api/issues` with `parentId` + `assigneeAgentId` | 3 | Model calls API directly via skills, or via wrapping skill |
| `evaluate_subtask_result` tool | `src/services/agents/system-tool-handlers.ts` | **Replace** | `GET /api/issues/:childId` from parent agent's run | 3 | Read status + comments; native to Paperclip |
| `request_revision` tool | `src/services/agents/system-tool-handlers.ts` | **Replace** | reopen child issue (`PATCH status='todo'`) + new comment with feedback | 3 | Paperclip pattern |
| `complete_task` tool | `src/services/agents/system-tool-handlers.ts` | **Replace** | `PATCH /api/issues/:id` with `status='done'` + `work_products` | 3 | Native Paperclip flow |
| `query_brain` tool | `src/services/agents/system-tool-handlers.ts` | **Add** | new GoBoost skill that hits our Brain layer | 3-4 | Brain is GoBoost-only |
| `write_to_brain` tool | `src/services/agents/system-tool-handlers.ts` | **Add** | same as above | 3-4 | |
| `send_whatsapp_message` tool | `src/services/agents/system-tool-handlers.ts` | **Port** | as `issue_comments.create` with a `channel='whatsapp'` tag | 3-4 | Paperclip's comment infrastructure can carry channel metadata |
| `request_approval` tool | `src/services/agents/system-tool-handlers.ts` | **Replace** | `POST /api/approvals` | 3 | Native Paperclip approvals |
| **Cross-iteration tool-fire gate** (one real tool per delegation) | `src/services/agents/AgentExecutor.ts` (recent fix) | **Add** | as adapter-level patch (for adapters we control) OR system-prompt enforcement (for external adapters) | 3 | We must port this — it prevents "and also make a 2nd file" failures |
| **Slice-from-plan** (sub-agent sees `step.description` not free text) | `src/services/agents/Delegation.ts` (recent fix) | **Add** | enforced when we create child issues — the child's `title` + `description` come from the plan, not from free LLM text | 3 | Carry as a convention in our task-decomposition skill |
| `bubbleUp` (attachments/whatsapp/approvals surface up the tree) | `src/services/agents/Delegation.ts` | **Port** | issue comments + attachments cascade up via `issue_thread_interactions` | 3 | Mechanism changes; outcome stays |
| `MAX_ITERATIONS=10` safety net | `src/services/agents/AgentExecutor.ts` | **Drop** | Paperclip uses `maxTurnsPerRun` in agent runtimeConfig | — | Their mechanism replaces ours |

---

## Table 5 — Memory & State

| Prototype concept | Source file | Decision | Target | Phase | Notes |
|---|---|---|---|---|---|
| **Conversation Memory** (Phase 13a, never built in prototype) | planned — `src/stores/conversationStore.ts` | **Drop (replaced by Paperclip)** | `agent_task_sessions` + `sessionIdBefore/After` + `contextSnapshot` jsonb in `heartbeat_runs` | — | **Huge win — Paperclip already does this.** Don't build Phase 13a from prototype roadmap |
| **Brain** (organizational shared state, `brainStore`) | `src/stores/brainStore.ts` | **Add** | new layer (GoBoost-only). Initial impl: `company_documents` + `document_revisions` (Paperclip tables) + retrieval skill | 3-4 | Brain is our IP. Build it on top of Paperclip's documents infrastructure |
| **World State** (Phaser scene runtime: positions, animations) | `src/stores/agentsStore.ts`, `engineStore`, `uiStore` | **Port** | new client-side Zustand stores in `ui/src/` | 2 | Stays client-side; not persisted to Paperclip DB |
| IndexedDB persistence (companies) | `src/services/company-persistence.ts` | **Drop** | Paperclip's embedded Postgres replaces it | — | Server-mediated persistence; no more browser-direct storage |

---

## Table 6 — Adapters & LLM Layer

| Prototype concept | Source file | Decision | Target | Phase | Notes |
|---|---|---|---|---|---|
| `LLMService` (`sendRequest`) | `src/services/llm/LLMService.ts` | **Drop** | Paperclip's `adapter.execute()` handles this | — | No more direct Anthropic SDK calls from our code |
| `dangerouslyAllowBrowser: true` | `src/services/llm/LLMService.ts` | **Drop** | LLM calls happen server-side via adapter | — | Massive security win |
| `AgentPromptBuilder` | `src/services/llm/AgentPromptBuilder.ts` | **Port** | logic moves into a server-side service that builds the adapter's system prompt from `AgentProfile` fields | 3 | Same input → same output, different runtime location |
| `SkillRunner` | `src/services/llm/SkillRunner.ts` | **Replace** | adapter's `syncSkills` + adapter execution flow | — | Paperclip's flow replaces this |
| `MockGenerator` (forced tool_use trick) | `src/services/llm/MockGenerator.ts` | **Drop** | not needed; real adapters return real results | — | Was a prototype workaround |
| Claude adapter (we built it) | `src/services/llm/...` | **Replace** | use Paperclip's `claude-local` built-in adapter | — | Already exists, no work |
| Hermes adapter | (not built — discussed) | **Add via plugin** | install `@henkey/hermes-paperclip-adapter` via `~/.paperclip/adapter-plugins.json` | 2-3 | External plugin, no code from us |
| Anthropic Skills wiring (xlsx/docx/pptx/pdf) | `src/services/agents/AgentExecutor.ts` + `SkillRunner.ts` | **Replace** | runs through claude-local's skills sync | 3 | Paperclip handles the bridging |

---

## Table 7 — Governance, Cost, Audit

| Prototype concept | Source file | Decision | Target | Phase | Notes |
|---|---|---|---|---|---|
| `request_approval` flow | system tool + UI | **Replace** | `approvals` table + `POST /api/approvals` + Approval pages | 3 | Native Paperclip |
| Approval levels (`MANAGER` / `CRITICAL` / `HUMAN`) | enum in our types | **Port** | encoded as `approvals.type` field values (e.g. `'gb_manager'`, `'gb_critical'`, `'gb_human'`) | 3 | Map our levels to Paperclip's open string type |
| Audit log (not built in prototype) | — | **Drop (replaced by Paperclip)** | `activity_log` table — already in place | — | Mutating writes auto-logged per AGENTS.md rules |
| Cost tracking (not built in prototype) | — | **Drop (replaced by Paperclip)** | `cost_events` + dashboards | — | Free upgrade |
| Budget policies (not built in prototype) | — | **Drop (replaced by Paperclip)** | `budget_policies` + `budget_incidents` + hard-stop pause | — | Free upgrade |
| Agent config versioning (not built in prototype) | — | **Drop (replaced by Paperclip)** | `agent_config_revisions` | — | Free upgrade |

---

## Table 8 — UI (the big one)

> **Note on visual positioning.** Paperclip's UI is a polished **dashboard**. Ours needs to be a **"computer game" experience** — characters in a virtual office, speech bubbles, walking, tool-use animations. This is not IP, but it is the dominant market-positioning signal for our customer segment (Israeli SMBs and operations leaders). Customers connect emotionally to a visual agent that "talks" and "uses tools" visibly — not to a list of issues with task counts. **This means Phase 2 is heavier than a typical i18n + theme job.**

| Prototype concept | Source file | Decision | Target | Phase | Notes |
|---|---|---|---|---|---|
| Phaser scene + `WorldScene` | `src/engine/rendering/WorldScene.ts` | **Port** | new GoBoost-only page (`ui/src/pages/OfficeView.tsx`) hosting a Phaser canvas | 2 | The "computer game" page |
| `CharacterRenderer`, breathing animation | `src/engine/rendering/CharacterRenderer.ts` | **Port** | sprites + animations in OfficeView | 2 | Future: swap placeholders for Metro City pack from pixel-agents repo (MIT) |
| `RoomRenderer`, `IdleAnimations` | `src/engine/rendering/RoomRenderer.ts` | **Port** | same place | 2 | |
| `CameraController` | `src/engine/rendering/CameraController.ts` | **Port** | same place | 2 | |
| Pathfinding (door-waypoint + EasyStar) | `src/utils/pathfinding.ts` | **Port** | utility under `ui/src/lib/pathfinding.ts` | 2 | |
| Action handlers (walkTo, speak, sit, etc.) | `src/engine/actions/handlers/` | **Port** | command layer that animates Paperclip events | 2 | Hooked into the 5-Layer Viz |
| `ScenarioRunner` + DAG scenarios | `src/engine/scenario-engine/` | **Drop** | — | — | Scenario Engine is prototype-only paradigm (CLAUDE.md prototype §2.2). Don't carry over |
| 4 prototype scenarios (morning routine, big lead, VIP, directive) | `src/content/scenarios/` | **Drop** | — | — | Bound to ScenarioRunner |
| **5-Layer Tool Visualization Bridge** | `src/services/agents/AgentVisualBridge.ts` | **Port + Adapt** | client-side hook that subscribes to Paperclip's `TranscriptEntry` event stream and fires 5 surfaces | 2 | This is high-IP — port carefully. Adapter outputs tool_call → all 5 layers light up |
| `HierarchyManager` UI (drag-drop) | `src/ui/hierarchy-manager/` | **Port** | new page or section that reorders `agents.reportsTo` | 2 | |
| Org Chart visual | `src/ui/hierarchy-manager/HierarchyManager.tsx` | **Port** | wrap Paperclip's SVG org-chart route or build new | 2 | Paperclip already has an SVG renderer at `server/src/routes/org-chart-svg.ts` |
| WhatsApp-style chat UI | `src/ui/whatsapp-chat/` | **Port** | new page; bind to `issue_comments` under the hood | 2 | Customers love this — preserves the chat-first feel |
| `AttachmentCard` | `src/ui/whatsapp-chat/AttachmentCard.tsx` | **Port** | reuse with Paperclip attachments API | 2 | |
| Wizards (Company / Agent Builder / Sector) | `src/ui/wizards/` | **Port + Add** | port the prototype wizards as GoBoost-only pages; add Sector preset wizard (net-new) | 2-3 | The prototype had Company + Agent wizards working well |
| Inspection panels (`SidePanel`, AgentEditorModal) | `src/ui/inspection/` | **Port** | reuse, bind to Paperclip's agent/issue endpoints | 2 | |
| Brain panel | (planned/partial in prototype) | **Add** | new page for browsing/editing Brain (GoBoost layer) | 3-4 | Brain is GoBoost-only |
| Sector preset cards in landing | `src/ui/landing/` | **Port** | new landing route | 2 | |
| Hebrew RTL throughout | implicit in prototype | **Port** | enable Paperclip's i18n with Hebrew strings; add `tailwindcss-rtl`; switch font to Heebo | 2 | i18n infrastructure exists in Paperclip — additive |

---

## Table 9 — Content (Israeli market)

| Prototype concept | Source | Decision | Target | Phase | Notes |
|---|---|---|---|---|---|
| Sector presets (cafe, tech, retail) | `src/content/sectors/` (partial) | **Port + Deepen** | new content under `skills/sectors/<sector>/` per Paperclip's skills convention | 3 | Deepen to law/accounting/medical for Israeli market |
| Brain seed (per-sector entities, customers, policies) | `src/content/sectors/<sector>/brain-seed.ts` (sparse) | **Port + Expand** | Brain layer (GoBoost) initial entries per sector | 3 | Major content investment |
| Agent profiles per sector | `src/content/agents/` | **Port + Refine** | agents created via wizard from sector preset templates | 3 | |
| Demo scenarios (the 4 we had) | `src/content/scenarios/` | **Drop** | — | — | Scenario Engine paradigm doesn't carry over |
| Knowledge files (uploaded PDFs etc.) | — (Phase 16 deferred) | **Add** | RAG layer over `documents` table | 4-5 | Future horizon |

---

## Table 10 — Active Drops (carry over NOTHING)

Things from the prototype that we **actively do not bring forward**, with the reason. Listing here so a future session doesn't accidentally re-import them.

| Drop | Why |
|---|---|
| `dangerouslyAllowBrowser: true` Anthropic SDK calls | Browser-direct LLM calls are insecure. Paperclip mediates everything server-side |
| `MockGenerator` + `forceMockResponse` | Mocks were prototype-only. Production runs real adapters |
| `AgentExecutor` custom tool-use loop | Paperclip's heartbeat engine is robust. Reinventing it = wasted effort |
| `LLMService` + `ToolSchemaTranslator` | Replaced by adapter layer |
| `ScenarioRunner` + DAG scenarios + atomic action handlers | Paradigm we deprecated in the prototype itself (CLAUDE.md §2.2). Not the future direction |
| IndexedDB-based `company-persistence` | Replaced by embedded Postgres |
| 5-layer prototype renderer strategy (`Simple` vs `Isometric` toggle) | Simplify: one renderer, GoBoost branding |
| `MAX_DELEGATION_DEPTH = 3` | Paperclip's `requestDepth` field on issues replaces it |
| Phase 13a "Conversation Memory" planning notes | Paperclip's session model replaces what we would have built |
| Browser-side context summarization | Server-side context snapshot replaces it |

---

## Phase Allocation Summary

| Phase | What ports there |
|---|---|
| **Phase 1** (done) | Foundation setup only — no content port |
| **Phase 2** (UI Wrapper) | All UI tables (8) + Hebrew RTL + Phaser visualization + 5-Layer Viz + Wizards |
| **Phase 3** (Methodology Port) | All Domain + Agent + Skill + Execution tables (1-7) + Sector preset #1 + first Israeli tools |
| **Phase 4+** (later horizons) | Brain layer + Knowledge files + more sector presets + observability + MCP layer to Paperclip |

---

## Net Summary

- **Prototype features carried via Port:** ~35
- **Prototype features Replaced by Paperclip mechanisms:** ~20 (these are pure savings — no work)
- **Net-new GoBoost Adds:** ~15 (Brain, 4-step ritual, slice-from-plan, success criteria, sector presets, Israeli tools, Hebrew RTL, visualization)
- **Prototype features actively Dropped:** ~10 (deprecated paradigms or hacks)

Approximate work distribution for Horizon 1 (Phases 1-3) versus the original prototype build: **roughly 50%** of the engineering load. The other 50% is provided by Paperclip's existing infrastructure (Conversation Memory, Cost Tracking, Governance, Heartbeats, Adapter Registry, Multi-tenancy, etc.). This is the strategic win of the fork.
