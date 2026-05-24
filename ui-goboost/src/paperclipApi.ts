/**
 * paperclipApi.ts — GoBoost ↔ Paperclip data adapter.
 *
 * Replaces the per-agent mocks that browserMock.ts ships with by subscribing
 * to the running Paperclip backend (typically at http://localhost:3100) and
 * translating its events into the same `window.postMessage` shapes that
 * pixel-agents' useExtensionMessages hook already understands.
 *
 * What we hook into:
 *   - GET  /api/companies                            (initial bootstrap)
 *   - GET  /api/companies/:companyId/agents          (initial agent list)
 *   - WS   /api/companies/:companyId/events/ws       (live event stream)
 *
 * What we currently translate:
 *   activity.logged (entityType=agent, action=create|delete) → agentCreated/agentClosed
 *   agent.status                                              → agentStatus
 *   heartbeat.run.queued/.status                              → agentStatus (active/waiting/idle)
 *   heartbeat.run.event/.log/plugin.*                         → ignored (for now)
 *
 * Out of scope here (planned later):
 *   - tool-call-level visualization (agentToolStart/Done) — needs parsed
 *     TranscriptEntry stream from heartbeat_runs.stdoutExcerpt, not just
 *     the live event channel.
 *   - multi-company picker — we auto-pick the first company today.
 *   - mid-session reconciliation on long disconnects.
 *
 * Engine integration: pixel-agents' OfficeState uses numeric ids; Paperclip
 * uses UUIDs. We keep an in-memory bidirectional mapping (IdMapper). Refresh
 * resets the mapping, but the UUIDs are re-read from /api/agents on reconnect,
 * so the office repopulates correctly.
 */

// Empty string = same-origin (proxied through Vite to http://localhost:3100).
// For production builds or non-proxied environments, override via
// VITE_PAPERCLIP_API_URL env var (e.g. 'http://localhost:3100').
const DEFAULT_PAPERCLIP_BASE = '';
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const PAPERCLIP_PROBE_TIMEOUT_MS = 4_000;

// ── Module-level shared state ─────────────────────────────────────────────
// Helpers below (`fetchAgentIssues`, `postIssueComment`, etc.) need to read
// the active company id, the configured base URL, and the UUID↔numeric
// agent-id mapping. `startPaperclipApi` writes here when it boots.
//
// This is a singleton because there's only ever one Paperclip connection
// per browser tab. If we ever support multi-company switching the call
// pattern stays the same, only the contents change.

let moduleBaseUrl = DEFAULT_PAPERCLIP_BASE;
let moduleCompanyId: string | null = null;
let moduleCompanyName: string | null = null;
let moduleIdMapper: IdMapper | null = null;
// Lookup table for agent names — populated on bootstrap and updated on
// every activity.logged for agents (create/delete). Used by the Tasks
// Panel to render assignee names instead of raw UUIDs.
const agentNameByUuid = new Map<string, string>();

// Activity event subscribers — used by the chat panel to refresh on
// `activity.logged` events (new comment, etc.).
type ActivityEventListener = (payload: Record<string, unknown>) => void;
const activityListeners = new Set<ActivityEventListener>();

export function subscribeActivity(listener: ActivityEventListener): () => void {
  activityListeners.add(listener);
  return () => activityListeners.delete(listener);
}

function emitActivity(payload: Record<string, unknown>): void {
  for (const fn of activityListeners) {
    try {
      fn(payload);
    } catch (err) {
      console.warn('[PaperclipApi] activity listener threw:', err);
    }
  }
}

// Heartbeat-event subscribers (2.B.2.C) — the chat panel's "כל הפעילות"
// mode listens here to splice agent internal lifecycle events into the
// timeline. These come from Paperclip's `heartbeat.run.event` WS type
// (run lifecycle, errors, etc.) — they are the system "inner voice" of
// the agent, distinct from user/agent dialog comments.
export interface PaperclipHeartbeatEvent {
  agentId: string;
  runId: string;
  seq: number;
  eventType: string; // 'lifecycle' | 'error' | (others in the future)
  stream: string | null;
  level: string | null; // 'info' | 'warn' | 'error' | ...
  color: string | null;
  message: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string; // ISO timestamp from the live event envelope
}

type HeartbeatEventListener = (event: PaperclipHeartbeatEvent) => void;
const heartbeatListeners = new Set<HeartbeatEventListener>();

export function subscribeHeartbeatEvents(listener: HeartbeatEventListener): () => void {
  heartbeatListeners.add(listener);
  return () => heartbeatListeners.delete(listener);
}

// ── Run lifecycle (queued / running / terminal) ─────────────────
//
// `heartbeat.run.event` (above) carries internal instrumentation —
// adapter.invoke, lifecycle, error. The actual run state transitions
// (queued → running → succeeded|failed|cancelled|timed_out) arrive on
// the separate WS types `heartbeat.run.queued` and `heartbeat.run.status`.
//
// Both originally only updated agent-status internally. The office's
// speech-bubble bridge needs them too — they are the EARLIEST and most
// reliable signal that "a user just pinged this agent" / "the run is
// now actively executing". So we expose a dedicated subscription that
// fans both event types out as one normalized stream.
export interface PaperclipRunStatusEvent {
  /** 'queued' = run just enqueued (earliest moment we know about it).
   *  Any other value comes verbatim from `heartbeat.run.status` — typically
   *  'running' / 'succeeded' / 'failed' / 'cancelled' / 'timed_out'. */
  kind: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | string;
  agentId: string;
  runId: string;
  createdAt: string;
}

type RunStatusListener = (event: PaperclipRunStatusEvent) => void;
const runStatusListeners = new Set<RunStatusListener>();

export function subscribeRunStatus(listener: RunStatusListener): () => void {
  runStatusListeners.add(listener);
  return () => runStatusListeners.delete(listener);
}

function emitRunStatus(event: PaperclipRunStatusEvent): void {
  for (const fn of runStatusListeners) {
    try {
      fn(event);
    } catch (err) {
      console.warn('[PaperclipApi] run-status listener threw:', err);
    }
  }
}

function emitHeartbeatEvent(event: PaperclipHeartbeatEvent): void {
  for (const fn of heartbeatListeners) {
    try {
      fn(event);
    } catch (err) {
      console.warn('[PaperclipApi] heartbeat listener threw:', err);
    }
  }
}

// ── State for the banner indicator ────────────────────────────────────────

export type PaperclipConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'no-paperclip'
  | 'no-company';

export interface PaperclipStatusDetail {
  state: PaperclipConnectionState;
  companyName?: string;
  message: string;
}

export type PaperclipStatusListener = (status: PaperclipStatusDetail) => void;

// ── Types we read from Paperclip API responses ────────────────────────────

interface PaperclipCompany {
  id: string;
  name: string;
}

interface PaperclipAgent {
  id: string;
  name: string;
  status: string;
  reportsTo?: string | null;
  role?: string;
  title?: string | null;
}

interface PaperclipLiveEvent {
  id: number;
  companyId: string;
  type: string;
  createdAt: string;
  payload?: Record<string, unknown>;
}

// Public shapes consumed by the WhatsApp panel + future task panel.

export interface PaperclipIssue {
  id: string;
  companyId: string;
  parentId: string | null;
  /** Project this issue belongs to — null when unscoped. */
  projectId: string | null;
  title: string;
  description: string | null;
  status: string;
  priority?: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  identifier?: string | null;
  /** Goal the issue is contributing to (single, optional). */
  goalId?: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Comment presentation + metadata (Stream 1 of CHAT_PANEL_DESIGN) ────────
//
// Paperclip distinguishes "system notice" comments from regular dialog via
// the `presentation` jsonb. Without checking presentation we can't tell a
// system notice (alert card) from an ordinary agent message (bubble) —
// they both arrive in /api/issues/:id/comments. The shapes below mirror
// Paperclip's `IssueCommentPresentation` and `IssueCommentMetadata` types
// from packages/shared/src/types/issue.ts.

export type PaperclipCommentPresentationKind = 'message' | 'system_notice';
export type PaperclipCommentPresentationTone =
  | 'neutral'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger';

export interface PaperclipCommentPresentation {
  kind: PaperclipCommentPresentationKind;
  tone: PaperclipCommentPresentationTone;
  title?: string | null;
  detailsDefaultOpen?: boolean;
}

export type PaperclipCommentMetadataRow =
  | { type: 'text'; text: string; label?: string | null }
  | { type: 'code'; code: string; language?: string | null; label?: string | null }
  | { type: 'key_value'; label: string; value: string }
  | {
      type: 'issue_link';
      issueId?: string | null;
      identifier?: string | null;
      title?: string | null;
      label?: string | null;
    }
  | { type: 'agent_link'; agentId: string; name?: string | null; label?: string | null }
  | { type: 'run_link'; runId: string; title?: string | null; label?: string | null };

export interface PaperclipCommentMetadataSection {
  title?: string | null;
  rows: PaperclipCommentMetadataRow[];
}

export interface PaperclipCommentMetadata {
  version: 1;
  sourceRunId?: string | null;
  sections: PaperclipCommentMetadataSection[];
}

export interface PaperclipComment {
  id: string;
  companyId: string;
  issueId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  authorType: string | null; // 'agent' | 'user' | 'system' | ...
  /**
   * When set, this comment was produced during an agent heartbeat run —
   * i.e. it's agent-generated content, even if Paperclip's local_trusted
   * mode attributed it to the `local-board` user. Used by the chat panel
   * to classify the bubble correctly.
   */
  createdByRunId: string | null;
  body: string;
  /**
   * Style hint set by Paperclip when the comment is a structured system
   * notice (alert card, not dialog bubble). null/undefined → regular
   * dialog message.
   */
  presentation: PaperclipCommentPresentation | null;
  /**
   * Optional structured rows (text, code, key-value, links) — Paperclip
   * uses these inside system notices for richer rendering than plain
   * markdown can carry.
   */
  metadata: PaperclipCommentMetadata | null;
  createdAt: string;
  updatedAt: string;
}

// ── Thread interactions (Stream 2 of CHAT_PANEL_DESIGN) ────────────────────
//
// Structured agent → user prompts that demand a response before the issue
// can continue: suggested task plans, follow-up questions, confirmations.
// Backend table: `issue_thread_interactions`. Listed via
//   GET /api/issues/:id/interactions
// Responses go via
//   POST /api/issues/:id/interactions/:interactionId/accept
//   POST /api/issues/:id/interactions/:interactionId/reject

export type PaperclipInteractionKind =
  | 'suggest_tasks'
  | 'ask_user_questions'
  | 'request_confirmation';

export type PaperclipInteractionStatus =
  | 'pending'
  | 'expired'
  | 'accepted'
  | 'rejected';

export interface PaperclipThreadInteraction {
  id: string;
  issueId: string;
  kind: PaperclipInteractionKind;
  status: PaperclipInteractionStatus;
  /** Shape varies per kind — questions list, suggested-tasks list, confirmation prompt. */
  payload: Record<string, unknown> | null;
  /** Set once the user has acted; mirrors payload structure for the response. */
  result: Record<string, unknown> | null;
  continuationPolicy?: string | null;
  createdAt: string;
  resolvedAt?: string | null;
}

export async function fetchIssueThreadInteractions(
  issueId: string,
): Promise<PaperclipThreadInteraction[]> {
  const url = `${moduleBaseUrl}/api/issues/${encodeURIComponent(issueId)}/interactions?limit=100`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = (await r.json()) as unknown;
    if (Array.isArray(raw)) return raw as PaperclipThreadInteraction[];
    if (
      raw &&
      typeof raw === 'object' &&
      Array.isArray((raw as { interactions?: unknown }).interactions)
    ) {
      return (raw as { interactions: PaperclipThreadInteraction[] }).interactions;
    }
    return [];
  } catch (err) {
    console.warn('[PaperclipApi] fetchIssueThreadInteractions failed:', err);
    return [];
  }
}

/**
 * Resolve an interaction. The Paperclip backend has 4 separate routes:
 *   POST /accept   — body: { selectedClientKeys?: string[] }
 *                    Used for suggest_tasks (pick which proposed tasks to
 *                    actually create) and request_confirmation (empty body).
 *   POST /reject   — body: { reason?: string }
 *                    Used for any kind.
 *   POST /respond  — body: { answers: [{questionId, optionIds}], summaryMarkdown? }
 *                    Used specifically for ask_user_questions.
 *   POST /cancel   — body: { reason?: string }
 *                    Used when the *creator* (the agent) wants to retract.
 *
 * Client callers should usually use one of the four convenience wrappers
 * below — `acceptInteraction`, `rejectInteraction`, `answerInteraction`,
 * `cancelInteraction`. This generic `postInteractionAction` is exported
 * for completeness but not normally needed.
 */
type InteractionAction = 'accept' | 'reject' | 'respond' | 'cancel';

async function postInteractionAction(
  issueId: string,
  interactionId: string,
  action: InteractionAction,
  body: Record<string, unknown>,
): Promise<PaperclipThreadInteraction | null> {
  const url = `${moduleBaseUrl}/api/issues/${encodeURIComponent(issueId)}/interactions/${encodeURIComponent(interactionId)}/${action}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} — ${txt.slice(0, 200)}`);
    }
    return (await r.json()) as PaperclipThreadInteraction;
  } catch (err) {
    console.warn(`[PaperclipApi] postInteractionAction(${action}) failed:`, err);
    return null;
  }
}

export function acceptInteraction(
  issueId: string,
  interactionId: string,
  selectedClientKeys?: string[],
): Promise<PaperclipThreadInteraction | null> {
  return postInteractionAction(
    issueId,
    interactionId,
    'accept',
    selectedClientKeys && selectedClientKeys.length > 0
      ? { selectedClientKeys }
      : {},
  );
}

export function rejectInteraction(
  issueId: string,
  interactionId: string,
  reason?: string,
): Promise<PaperclipThreadInteraction | null> {
  return postInteractionAction(
    issueId,
    interactionId,
    'reject',
    reason ? { reason } : {},
  );
}

export interface QuestionAnswer {
  questionId: string;
  optionIds: string[];
}

export function answerInteraction(
  issueId: string,
  interactionId: string,
  answers: QuestionAnswer[],
  summaryMarkdown?: string | null,
): Promise<PaperclipThreadInteraction | null> {
  return postInteractionAction(issueId, interactionId, 'respond', {
    answers,
    ...(summaryMarkdown ? { summaryMarkdown } : {}),
  });
}

export function cancelInteraction(
  issueId: string,
  interactionId: string,
  reason?: string,
): Promise<PaperclipThreadInteraction | null> {
  return postInteractionAction(
    issueId,
    interactionId,
    'cancel',
    reason ? { reason } : {},
  );
}

// ── Issue attachments (Stream 5 of CHAT_PANEL_DESIGN) ──────────────────────
//
// Files attached to an issue. When `issueCommentId` is set the file is the
// "tail" of a specific comment (render inline under that bubble); otherwise
// it's a standalone primitive in the timeline.

export interface PaperclipAttachmentAsset {
  id: string;
  filename: string;
  mimeType: string;
  byteSize?: number | null;
  width?: number | null;
  height?: number | null;
}

/**
 * Attachment shape returned by `/api/issues/:id/attachments`. Paperclip
 * inlines the asset fields directly on the row using `originalFilename`,
 * `contentType`, and `byteSize` (no nested `asset` object). We also keep
 * the legacy `asset`/`filename`/`mimeType` fields so older payloads
 * still work. Readers should prefer `originalFilename` over `filename`.
 *
 * `contentPath` is the relative download URL (e.g. `/api/attachments/:id/content`).
 * We expose `attachmentContentUrl(id)` which builds the same URL with
 * the configured base — they're interchangeable in practice.
 */
export interface PaperclipAttachment {
  id: string;
  issueId: string;
  /** When set, this attachment is "owned" by a specific comment. */
  issueCommentId: string | null;
  assetId: string;
  /** The original filename as uploaded — preferred display name. */
  originalFilename?: string | null;
  contentType?: string | null;
  byteSize?: number | null;
  /** Server-supplied download URL. May be relative. */
  contentPath?: string | null;
  /** Legacy nested shape — older API revisions used this. */
  asset?: PaperclipAttachmentAsset | null;
  filename?: string | null;
  mimeType?: string | null;
  /**
   * Origin attribution — exactly one of these is typically populated.
   * Used by the Tasks Panel to split attachments into:
   *   • "תוצרים להורדה (הסוכן)"   ← createdByAgentId !== null
   *   • "מסמכים מצורפים (אני)"    ← createdByUserId !== null && createdByAgentId === null
   */
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  createdAt: string;
}

export function attachmentContentUrl(attachmentId: string): string {
  return `${moduleBaseUrl}/api/attachments/${encodeURIComponent(attachmentId)}/content`;
}

/**
 * Convenience accessors — readers should use these instead of poking at
 * the discriminated fields directly. They handle both the new flat shape
 * (`originalFilename`, `contentType`) and the older nested shape (`asset.*`).
 */
export function attachmentFilename(att: PaperclipAttachment): string {
  return (
    att.originalFilename ??
    att.asset?.filename ??
    att.filename ??
    `attachment-${att.id.slice(0, 6)}`
  );
}
export function attachmentMimeType(att: PaperclipAttachment): string {
  return att.contentType ?? att.asset?.mimeType ?? att.mimeType ?? '';
}
export function attachmentByteSize(att: PaperclipAttachment): number | null {
  return att.byteSize ?? att.asset?.byteSize ?? null;
}

/**
 * Upload a file as an attachment on an issue.
 *
 * Endpoint: `POST /companies/:companyId/issues/:issueId/attachments`
 * Body: multipart/form-data — field `file` carries the binary, optional
 * `issueCommentId` field binds the attachment to a specific comment.
 *
 * Returns the full attachment row (with `id`, `contentPath`,
 * `originalFilename`, `byteSize`, etc) — callers should add it to local
 * state so the new file appears immediately, without waiting for the
 * WebSocket activity round-trip.
 *
 * Server-side default cap is 10 MB; callers should pre-validate via
 * `validateAttachmentSize` from attachmentHelpers.ts to give the user
 * a clean inline error instead of an opaque 413.
 */
export async function uploadIssueAttachment(
  issueId: string,
  file: File,
  opts?: { issueCommentId?: string | null },
): Promise<PaperclipAttachment | null> {
  if (!moduleCompanyId) {
    console.warn('[PaperclipApi] uploadIssueAttachment before companyId is set');
    return null;
  }
  const url = `${moduleBaseUrl}/api/companies/${encodeURIComponent(moduleCompanyId)}/issues/${encodeURIComponent(issueId)}/attachments`;
  const form = new FormData();
  form.append('file', file, file.name);
  if (opts?.issueCommentId) {
    form.append('issueCommentId', opts.issueCommentId);
  }
  try {
    const r = await fetch(url, { method: 'POST', body: form });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} — ${txt.slice(0, 200)}`);
    }
    return (await r.json()) as PaperclipAttachment;
  } catch (err) {
    console.warn('[PaperclipApi] uploadIssueAttachment failed:', err);
    return null;
  }
}

export async function fetchIssueAttachments(
  issueId: string,
): Promise<PaperclipAttachment[]> {
  const url = `${moduleBaseUrl}/api/issues/${encodeURIComponent(issueId)}/attachments?limit=100`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = (await r.json()) as unknown;
    if (Array.isArray(raw)) return raw as PaperclipAttachment[];
    if (
      raw &&
      typeof raw === 'object' &&
      Array.isArray((raw as { attachments?: unknown }).attachments)
    ) {
      return (raw as { attachments: PaperclipAttachment[] }).attachments;
    }
    return [];
  } catch (err) {
    console.warn('[PaperclipApi] fetchIssueAttachments failed:', err);
    return [];
  }
}

// ── Issue documents + revisions (Tasks Panel) ──────────────────────────────
//
// Documents are markdown/spec artifacts pinned to an issue. Each has a `key`
// inside the issue (e.g. "plan", "spec") and a history of revisions.
//   GET /api/issues/:id/documents
//   GET /api/issues/:id/documents/:key/revisions

export interface PaperclipDocumentSummary {
  id: string;
  documentId: string;
  issueId: string;
  key: string;
  /** Some backends inline the latest revision body for convenience. */
  latestRevision?: PaperclipDocumentRevision | null;
  createdAt: string;
}

export interface PaperclipDocumentRevision {
  id: string;
  documentId: string;
  revisionNumber: number;
  body: string;
  format: string;
  changeSummary?: string | null;
  createdByAgentId?: string | null;
  createdByRunId?: string | null;
  createdAt: string;
}

export async function fetchIssueDocuments(
  issueId: string,
): Promise<PaperclipDocumentSummary[]> {
  const url = `${moduleBaseUrl}/api/issues/${encodeURIComponent(issueId)}/documents?limit=100`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = (await r.json()) as unknown;
    if (Array.isArray(raw)) return raw as PaperclipDocumentSummary[];
    if (
      raw &&
      typeof raw === 'object' &&
      Array.isArray((raw as { documents?: unknown }).documents)
    ) {
      return (raw as { documents: PaperclipDocumentSummary[] }).documents;
    }
    return [];
  } catch (err) {
    console.warn('[PaperclipApi] fetchIssueDocuments failed:', err);
    return [];
  }
}

export async function fetchDocumentRevisions(
  issueId: string,
  key: string,
): Promise<PaperclipDocumentRevision[]> {
  const url = `${moduleBaseUrl}/api/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}/revisions?limit=50`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = (await r.json()) as unknown;
    if (Array.isArray(raw)) return raw as PaperclipDocumentRevision[];
    if (
      raw &&
      typeof raw === 'object' &&
      Array.isArray((raw as { revisions?: unknown }).revisions)
    ) {
      return (raw as { revisions: PaperclipDocumentRevision[] }).revisions;
    }
    return [];
  } catch (err) {
    console.warn('[PaperclipApi] fetchDocumentRevisions failed:', err);
    return [];
  }
}

// ── Issue work products (Tasks Panel) ──────────────────────────────────────
//
// Downloadable agent outputs — spreadsheets, PDFs, generated docs. Each has
// a public URL (asset.url) for direct download.
//   GET /api/issues/:id/work-products

export interface PaperclipWorkProduct {
  id: string;
  issueId: string;
  type: string; // 'spreadsheet' | 'pdf' | 'doc' | ...
  provider?: string | null;
  externalId?: string | null;
  title: string;
  url?: string | null;
  status?: string | null;
  reviewState?: string | null;
  isPrimary?: boolean;
  healthStatus?: string | null;
  createdByRunId?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export async function fetchIssueWorkProducts(
  issueId: string,
): Promise<PaperclipWorkProduct[]> {
  const url = `${moduleBaseUrl}/api/issues/${encodeURIComponent(issueId)}/work-products?limit=100`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = (await r.json()) as unknown;
    if (Array.isArray(raw)) return raw as PaperclipWorkProduct[];
    if (
      raw &&
      typeof raw === 'object' &&
      Array.isArray((raw as { workProducts?: unknown }).workProducts)
    ) {
      return (raw as { workProducts: PaperclipWorkProduct[] }).workProducts;
    }
    return [];
  } catch (err) {
    console.warn('[PaperclipApi] fetchIssueWorkProducts failed:', err);
    return [];
  }
}

// ── Issue approvals (Tasks Panel) ──────────────────────────────────────────
//
// Approval gates linked to an issue. The approval itself lives in the
// `approvals` table; the join table `issue_approvals` links it to the
// issue. The list endpoint denormalizes for us.
//   GET /api/issues/:id/approvals

export type PaperclipApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface PaperclipApproval {
  id: string;
  type: string;
  status: PaperclipApprovalStatus;
  payload?: Record<string, unknown> | null;
  decidedByUserId?: string | null;
  decidedAt?: string | null;
  createdAt: string;
  /** Present when joined via issue_approvals. */
  linkedByAgentId?: string | null;
  linkedByUserId?: string | null;
}

export async function fetchIssueApprovals(
  issueId: string,
): Promise<PaperclipApproval[]> {
  const url = `${moduleBaseUrl}/api/issues/${encodeURIComponent(issueId)}/approvals?limit=100`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = (await r.json()) as unknown;
    if (Array.isArray(raw)) return raw as PaperclipApproval[];
    if (
      raw &&
      typeof raw === 'object' &&
      Array.isArray((raw as { approvals?: unknown }).approvals)
    ) {
      return (raw as { approvals: PaperclipApproval[] }).approvals;
    }
    return [];
  } catch (err) {
    console.warn('[PaperclipApi] fetchIssueApprovals failed:', err);
    return [];
  }
}

/**
 * Approve or reject an approval gate. The endpoint pair is:
 *   POST /approvals/:id/approve  → body: { decisionNote?: string }
 *   POST /approvals/:id/reject   → same body
 *
 * The board user must be authenticated; the local_trusted dev path
 * does this transparently. Returns the updated approval row.
 */
export async function resolveApproval(
  approvalId: string,
  decision: 'approve' | 'reject',
  decisionNote?: string,
): Promise<PaperclipApproval | null> {
  const url = `${moduleBaseUrl}/api/approvals/${encodeURIComponent(approvalId)}/${decision}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(decisionNote ? { decisionNote } : {}),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} — ${txt.slice(0, 200)}`);
    }
    return (await r.json()) as PaperclipApproval;
  } catch (err) {
    console.warn(`[PaperclipApi] resolveApproval(${decision}) failed:`, err);
    return null;
  }
}

/**
 * Delete a work product. The endpoint is:
 *   DELETE /work-products/:id
 *
 * No response body; we just resolve to `true` on success so callers can
 * remove the row optimistically.
 */
export async function deleteWorkProduct(workProductId: string): Promise<boolean> {
  const url = `${moduleBaseUrl}/api/work-products/${encodeURIComponent(workProductId)}`;
  try {
    const r = await fetch(url, { method: 'DELETE' });
    if (!r.ok && r.status !== 204) {
      const txt = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} — ${txt.slice(0, 200)}`);
    }
    return true;
  } catch (err) {
    console.warn('[PaperclipApi] deleteWorkProduct failed:', err);
    return false;
  }
}

/**
 * Delete an issue attachment. The endpoint is:
 *   DELETE /attachments/:attachmentId
 *
 * Used by the Tasks Panel to remove agent-generated files (PPT/PDF/DOCX)
 * that the user no longer wants to keep around.
 */
export async function deleteAttachment(attachmentId: string): Promise<boolean> {
  const url = `${moduleBaseUrl}/api/attachments/${encodeURIComponent(attachmentId)}`;
  try {
    const r = await fetch(url, { method: 'DELETE' });
    if (!r.ok && r.status !== 204) {
      const txt = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} — ${txt.slice(0, 200)}`);
    }
    return true;
  } catch (err) {
    console.warn('[PaperclipApi] deleteAttachment failed:', err);
    return false;
  }
}

/**
 * Delete an issue document by key. The endpoint is:
 *   DELETE /issues/:id/documents/:key
 *
 * Paperclip logs `issue.document_deleted` activity on success.
 */
export async function deleteIssueDocument(
  issueId: string,
  key: string,
): Promise<boolean> {
  const url = `${moduleBaseUrl}/api/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`;
  try {
    const r = await fetch(url, { method: 'DELETE' });
    if (!r.ok && r.status !== 204) {
      const txt = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} — ${txt.slice(0, 200)}`);
    }
    return true;
  } catch (err) {
    console.warn('[PaperclipApi] deleteIssueDocument failed:', err);
    return false;
  }
}

// ── UUID ↔ numeric id mapping ─────────────────────────────────────────────
//
// pixel-agents engine was built around Claude Code agent ids that happen to
// be numbers (process pids / sequence numbers). Paperclip uses UUID strings.
// We bridge them here. Mapping is in-memory and resets on refresh — agents
// are re-listed via the API on every (re)connect, so nothing is lost.

class IdMapper {
  private uuidToId = new Map<string, number>();
  private idToUuid = new Map<number, string>();
  private nextId = 1;

  toNumeric(uuid: string): number {
    const existing = this.uuidToId.get(uuid);
    if (existing !== undefined) return existing;
    const id = this.nextId++;
    this.uuidToId.set(uuid, id);
    this.idToUuid.set(id, uuid);
    return id;
  }

  toUuid(id: number): string | undefined {
    return this.idToUuid.get(id);
  }

  forget(uuid: string): number | undefined {
    const id = this.uuidToId.get(uuid);
    if (id !== undefined) {
      this.uuidToId.delete(uuid);
      this.idToUuid.delete(id);
    }
    return id;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function dispatch(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

function wsUrlFromBase(baseUrl: string, companyId: string): string {
  // Same-origin proxy case: derive from current page origin (http→ws, https→wss).
  if (!baseUrl) {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}/api/companies/${encodeURIComponent(companyId)}/events/ws`;
  }
  const wsBase = baseUrl.replace(/^http/i, 'ws');
  return `${wsBase}/api/companies/${encodeURIComponent(companyId)}/events/ws`;
}

// ── Public helpers consumed by chat panel / future task panel ─────────────

/** Returns the active company id, or null if not yet connected. */
export function getActiveCompanyId(): string | null {
  return moduleCompanyId;
}

/** Returns the active company name, or null. Useful for headers. */
export function getActiveCompanyName(): string | null {
  return moduleCompanyName;
}

/** Translate numeric pixel-agents id → Paperclip UUID. */
export function uuidForNumericAgentId(numericId: number): string | null {
  if (!moduleIdMapper) return null;
  return moduleIdMapper.toUuid(numericId) ?? null;
}

/**
 * Translate Paperclip UUID → numeric pixel-agents id. Used by the chat
 * panel to "re-home" the visual office when navigating to an issue owned
 * by a different agent — it dispatches `agentSelected` with this numeric
 * id. Every agent that exists has already been registered via the
 * bootstrap `agentCreated` dispatch, so `toNumeric` returns the existing
 * mapping rather than minting a new one.
 */
export function numericIdForAgentUuid(uuid: string): number | null {
  if (!moduleIdMapper) return null;
  return moduleIdMapper.toNumeric(uuid);
}

/**
 * List issues assigned to a given agent (most recent first). Backend
 * default ordering is `updatedAt DESC`.
 */
export async function fetchAgentIssues(agentUuid: string): Promise<PaperclipIssue[]> {
  if (!moduleCompanyId) return [];
  const url = `${moduleBaseUrl}/api/companies/${encodeURIComponent(moduleCompanyId)}/issues?assigneeAgentId=${encodeURIComponent(agentUuid)}&limit=50`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = (await r.json()) as unknown;
    // The endpoint returns either a plain array or { issues: [...] } depending
    // on filters — normalize.
    if (Array.isArray(raw)) return raw as PaperclipIssue[];
    if (raw && typeof raw === 'object' && Array.isArray((raw as { issues?: unknown }).issues)) {
      return (raw as { issues: PaperclipIssue[] }).issues;
    }
    console.warn('[PaperclipApi] unexpected issues response shape:', raw);
    return [];
  } catch (err) {
    console.warn('[PaperclipApi] fetchAgentIssues failed:', err);
    return [];
  }
}

/**
 * A project — the framing unit one level above issues. The bookmarks bar
 * renders one tab per project. Fields mirror Paperclip's `projects` table;
 * we keep only what the UI needs.
 */
export interface PaperclipProject {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  status: string;
  color: string | null;
  leadAgentId: string | null;
  targetDate: string | null;
  archivedAt: string | null;
  /** Linked goal ids — present when the API hydrates the response. */
  goalIds?: string[] | null;
  createdAt: string;
  updatedAt: string;
}

/** List the company's projects. Used to build the bookmarks bar. */
export async function fetchCompanyProjects(): Promise<PaperclipProject[]> {
  if (!moduleCompanyId) return [];
  const url = `${moduleBaseUrl}/api/companies/${encodeURIComponent(moduleCompanyId)}/projects`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = (await r.json()) as unknown;
    if (Array.isArray(raw)) return raw as PaperclipProject[];
    if (raw && typeof raw === 'object' && Array.isArray((raw as { projects?: unknown }).projects)) {
      return (raw as { projects: PaperclipProject[] }).projects;
    }
    return [];
  } catch (err) {
    console.warn('[PaperclipApi] fetchCompanyProjects failed:', err);
    return [];
  }
}

/** Fields editable when creating or updating a project. */
export interface ProjectInput {
  name?: string;
  description?: string | null;
  status?: string;
  color?: string | null;
  targetDate?: string | null;
  leadAgentId?: string | null;
  /** Goal ids linked to the project (Paperclip's `goalIds` array). */
  goalIds?: string[];
}

/** Create a project. `name` is required. Returns the new project row. */
export async function createProject(
  input: ProjectInput,
): Promise<PaperclipProject | null> {
  if (!moduleCompanyId) return null;
  const url = `${moduleBaseUrl}/api/companies/${encodeURIComponent(moduleCompanyId)}/projects`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} — ${txt.slice(0, 200)}`);
    }
    return (await r.json()) as PaperclipProject;
  } catch (err) {
    console.warn('[PaperclipApi] createProject failed:', err);
    return null;
  }
}

/**
 * Update a project (partial). Endpoint: `PATCH /projects/:id`.
 * Archiving is a PATCH that sets `archivedAt`; see `archiveProject`.
 */
export async function updateProject(
  projectId: string,
  patch: ProjectInput & { archivedAt?: string | null },
): Promise<PaperclipProject | null> {
  const url = `${moduleBaseUrl}/api/projects/${encodeURIComponent(projectId)}`;
  try {
    const r = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} — ${txt.slice(0, 200)}`);
    }
    return (await r.json()) as PaperclipProject;
  } catch (err) {
    console.warn('[PaperclipApi] updateProject failed:', err);
    return null;
  }
}

/** Archive a project — soft-delete via `archivedAt` timestamp. */
export function archiveProject(
  projectId: string,
): Promise<PaperclipProject | null> {
  return updateProject(projectId, { archivedAt: new Date().toISOString() });
}

/** Un-archive a project — clears `archivedAt`. */
export function unarchiveProject(
  projectId: string,
): Promise<PaperclipProject | null> {
  return updateProject(projectId, { archivedAt: null });
}

// ── Goals ────────────────────────────────────────────────────────
//
// Paperclip's `goals` table is a flat list with optional parent linkage
// (`parentId`) so a company can build a goal tree (e.g. company-level →
// team-level → agent-level). Goals are referenced by projects via
// `projects.goalIds[]` and by issues via `issues.goalId` (single).
//
// The level + status enums are mirrored from the Paperclip backend
// schema. Exporting them as `as const` arrays lets the Goals modal
// drive its dropdowns from the same source of truth.

export const GOAL_LEVELS = ['company', 'team', 'agent', 'task'] as const;
export type GoalLevel = (typeof GOAL_LEVELS)[number];

export const GOAL_STATUSES = ['planned', 'active', 'achieved', 'cancelled'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/**
 * A goal row from Paperclip. Used by the Goals modal (CRUD) AND the
 * project create/edit modals (read-only selector).
 */
export interface PaperclipGoal {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  /** Hierarchy band — narrows what the goal is "about". */
  level: GoalLevel;
  status: GoalStatus;
  /** Parent goal for tree structure; null = top-level. */
  parentId: string | null;
  /** Agent responsible for advancing this goal; null = unassigned. */
  ownerAgentId: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * The body shape accepted by POST `/companies/:id/goals` and PATCH
 * `/goals/:id`. All fields are optional on PATCH; `title` + `level` are
 * required on POST. Matches Paperclip's `upsertGoalSchema`.
 */
export interface GoalInput {
  title?: string;
  description?: string | null;
  level?: GoalLevel;
  status?: GoalStatus;
  parentId?: string | null;
  ownerAgentId?: string | null;
}

/** List the company's goals — for the Goals modal AND the project modals' goal multi-select. */
export async function fetchCompanyGoals(): Promise<PaperclipGoal[]> {
  if (!moduleCompanyId) return [];
  const url = `${moduleBaseUrl}/api/companies/${encodeURIComponent(moduleCompanyId)}/goals`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = (await r.json()) as unknown;
    if (Array.isArray(raw)) return raw as PaperclipGoal[];
    if (raw && typeof raw === 'object' && Array.isArray((raw as { goals?: unknown }).goals)) {
      return (raw as { goals: PaperclipGoal[] }).goals;
    }
    return [];
  } catch (err) {
    console.warn('[PaperclipApi] fetchCompanyGoals failed:', err);
    return [];
  }
}

// ── Agent lifecycle actions ──────────────────────────────────────
//
// Mirror of the action buttons on Paperclip's per-agent dashboard.
// All return `true` on HTTP success, `false` on any failure (network /
// 4xx / 5xx). Callers refetch the agent's state either way so a brief
// 4xx doesn't leave the UI inconsistent.

async function postAgentAction(
  agentId: string,
  action: 'heartbeat/invoke' | 'pause' | 'resume' | 'wakeup' | 'terminate',
  body?: Record<string, unknown>,
): Promise<boolean> {
  const url = `${moduleBaseUrl}/api/agents/${encodeURIComponent(agentId)}/${action}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (!r.ok) {
      console.warn(`[PaperclipApi] agent action ${action} failed:`, r.status);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[PaperclipApi] agent action ${action} threw:`, err);
    return false;
  }
}

/** Invoke a heartbeat run manually (the ❤️ toolbar button). */
export function invokeAgentHeartbeat(agentId: string): Promise<boolean> {
  return postAgentAction(agentId, 'heartbeat/invoke');
}

/** Pause an agent — sets status to "paused" until resume. */
export function pauseAgent(agentId: string): Promise<boolean> {
  return postAgentAction(agentId, 'pause');
}

/** Resume a paused agent. */
export function resumeAgent(agentId: string): Promise<boolean> {
  return postAgentAction(agentId, 'resume');
}

/** Wake an idle/sleeping agent (the 💭 button). */
export function wakeupAgent(agentId: string): Promise<boolean> {
  return postAgentAction(agentId, 'wakeup');
}

/** Terminate an agent — permanent until re-approved. The ✕ button. */
export function terminateAgent(agentId: string): Promise<boolean> {
  return postAgentAction(agentId, 'terminate');
}

/** Detailed agent record from `GET /agents/:id`. Superset of the summary. */
export interface PaperclipAgentDetail extends PaperclipAgentSummary {
  description?: string | null;
  icon?: string | null;
  // Renamed `adapter` → `adapterType` (Session 5): matches the actual
  // backend column. `adapter` is kept transitively-deprecated; new
  // code should always use `adapterType`.
  adapterType?: string | null;
  adapterConfig?: Record<string, unknown> | null;
  runtimeConfig?: Record<string, unknown> | null;
  model?: string | null;
  maxConcurrentRuns?: number | null;
  budgetMonthlyCents?: number | null;
  permissions?: Record<string, boolean> | null;
  capabilities?: string | null;
  defaultEnvironmentId?: string | null;
  desiredSkills?: string[] | null;
  metadata?: Record<string, unknown> | null;
}

/** Fetch the full agent record. Used by the AgentManagementModal. */
export async function fetchAgentById(
  agentId: string,
): Promise<PaperclipAgentDetail | null> {
  const url = `${moduleBaseUrl}/api/agents/${encodeURIComponent(agentId)}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as PaperclipAgentDetail;
  } catch (err) {
    console.warn('[PaperclipApi] fetchAgentById failed:', err);
    return null;
  }
}

// ── Budget overview ──────────────────────────────────────────────
//
// Paperclip's budget endpoints return per-scope (company/project/agent)
// monthly spend caps + actual usage. The agent dashboard's Budget tab
// reads the per-agent slice and writes back a new cap when the user
// edits it. We expose the minimum surface needed for both.

export interface PaperclipBudgetPolicy {
  scopeType: 'company' | 'project' | 'agent';
  scopeId: string | null;
  monthlyCents: number;
  /** "ok" | "hard_stop" | "paused" — drives the status pill. */
  status?: string;
}

export interface PaperclipBudgetOverviewEntry {
  scopeType: string;
  scopeId: string | null;
  monthlyCents: number;
  spentThisMonthCents: number;
  remainingCents: number;
  status: string;
}

export interface PaperclipBudgetOverview {
  entries: PaperclipBudgetOverviewEntry[];
}

export async function fetchBudgetOverview(): Promise<PaperclipBudgetOverview | null> {
  if (!moduleCompanyId) return null;
  const url = `${moduleBaseUrl}/api/companies/${encodeURIComponent(moduleCompanyId)}/budgets/overview`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const raw = (await r.json()) as unknown;
    if (Array.isArray(raw)) {
      return { entries: raw as PaperclipBudgetOverviewEntry[] };
    }
    if (raw && typeof raw === 'object') {
      const obj = raw as { entries?: unknown };
      if (Array.isArray(obj.entries)) {
        return { entries: obj.entries as PaperclipBudgetOverviewEntry[] };
      }
    }
    return { entries: [] };
  } catch (err) {
    console.warn('[PaperclipApi] fetchBudgetOverview failed:', err);
    return null;
  }
}

export async function upsertBudgetPolicy(
  policy: PaperclipBudgetPolicy & { windowKind?: string },
): Promise<boolean> {
  if (!moduleCompanyId) return false;
  const url = `${moduleBaseUrl}/api/companies/${encodeURIComponent(moduleCompanyId)}/budgets/policies`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scopeType: policy.scopeType,
        scopeId: policy.scopeId,
        monthlyCents: policy.monthlyCents,
        windowKind: policy.windowKind ?? 'monthly',
      }),
    });
    return r.ok;
  } catch (err) {
    console.warn('[PaperclipApi] upsertBudgetPolicy failed:', err);
    return false;
  }
}

// ── Agent skills (Session 6 — snapshot model) ───────────────────
//
// Paperclip's Skills tab works on a snapshot model: the GET endpoint
// returns BOTH the desired-skills list (what the operator wants
// enabled) and a full entry list (every skill the adapter knows
// about, with state + origin metadata). The earlier "array of skill
// objects" assumption returned empty for agents whose snapshot didn't
// match that shape — fixed here.
//
// To toggle skills the operator POSTs `{ desiredSkills: [...] }` to
// /skills/sync (full-set replacement, not incremental).
//
// Separately, the company-wide skills library is fetched from
// /companies/:id/skills — used to populate the "add skill" picker.

export type PaperclipSkillState =
  | 'available'
  | 'configured'
  | 'installed'
  | 'missing'
  | 'stale'
  | 'external';

export type PaperclipSkillOrigin =
  | 'company_managed'
  | 'paperclip_required'
  | 'user_installed'
  | 'external_unknown';

export interface PaperclipAgentSkillEntry {
  key: string;
  runtimeName?: string | null;
  desired: boolean;
  managed: boolean;
  required?: boolean;
  state: PaperclipSkillState | string;
  origin: PaperclipSkillOrigin | string;
  originLabel?: string | null;
  locationLabel?: string | null;
  readOnly?: boolean;
  sourcePath?: string | null;
  targetPath?: string | null;
  detail?: string | null;
}

export interface PaperclipAgentSkillSnapshot {
  adapterType: string;
  supported: boolean;
  mode: 'unsupported' | 'persistent' | 'ephemeral' | string;
  desiredSkills: string[];
  entries: PaperclipAgentSkillEntry[];
  warnings: string[];
}

export async function fetchAgentSkills(
  agentId: string,
): Promise<PaperclipAgentSkillSnapshot | null> {
  const url = `${moduleBaseUrl}/api/agents/${encodeURIComponent(agentId)}/skills`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const raw = (await r.json()) as Record<string, unknown>;
    const entriesRaw = Array.isArray(raw.entries)
      ? (raw.entries as Record<string, unknown>[])
      : [];
    return {
      adapterType: String(raw.adapterType ?? ''),
      supported: Boolean(raw.supported ?? false),
      mode: String(raw.mode ?? 'unsupported'),
      desiredSkills: Array.isArray(raw.desiredSkills)
        ? (raw.desiredSkills as string[])
        : [],
      entries: entriesRaw.map((e) => ({
        key: String(e.key ?? ''),
        runtimeName: (e.runtimeName as string | null | undefined) ?? null,
        desired: Boolean(e.desired),
        managed: Boolean(e.managed),
        required: Boolean(e.required),
        state: String(e.state ?? 'available'),
        origin: String(e.origin ?? 'external_unknown'),
        originLabel: (e.originLabel as string | null | undefined) ?? null,
        locationLabel: (e.locationLabel as string | null | undefined) ?? null,
        readOnly: Boolean(e.readOnly),
        sourcePath: (e.sourcePath as string | null | undefined) ?? null,
        targetPath: (e.targetPath as string | null | undefined) ?? null,
        detail: (e.detail as string | null | undefined) ?? null,
      })),
      warnings: Array.isArray(raw.warnings) ? (raw.warnings as string[]) : [],
    };
  } catch (err) {
    console.warn('[PaperclipApi] fetchAgentSkills failed:', err);
    return null;
  }
}

/** Replace the agent's desiredSkills set (full list, not incremental). */
export async function syncAgentSkills(
  agentId: string,
  desiredSkills: string[],
): Promise<PaperclipAgentSkillSnapshot | null> {
  const url = `${moduleBaseUrl}/api/agents/${encodeURIComponent(agentId)}/skills/sync`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ desiredSkills }),
    });
    if (!r.ok) return null;
    const raw = (await r.json()) as Record<string, unknown>;
    return fetchAgentSkills(agentId).then(
      (snap) => snap ?? (raw as unknown as PaperclipAgentSkillSnapshot),
    );
  } catch (err) {
    console.warn('[PaperclipApi] syncAgentSkills failed:', err);
    return null;
  }
}

// Company-wide skills library — populates the "+ skill" picker so
// the operator can add a skill the agent doesn't yet have. Shape is
// looser since this is the library, not a per-agent snapshot.
export interface PaperclipCompanySkill {
  key: string;
  name?: string | null;
  description?: string | null;
  managed?: boolean;
  category?: string | null;
}

export async function fetchCompanySkills(): Promise<PaperclipCompanySkill[]> {
  if (!moduleCompanyId) return [];
  const url = `${moduleBaseUrl}/api/companies/${encodeURIComponent(moduleCompanyId)}/skills`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const raw = (await r.json()) as unknown;
    const arr = Array.isArray(raw)
      ? raw
      : ((raw as { skills?: unknown[] })?.skills ?? []);
    return (arr as Record<string, unknown>[]).map((s) => ({
      key: String(s.key ?? s.id ?? ''),
      name: (s.name as string | null | undefined) ?? null,
      description: (s.description as string | null | undefined) ?? null,
      managed: Boolean(s.managed),
      category: (s.category as string | null | undefined) ?? null,
    }));
  } catch (err) {
    console.warn('[PaperclipApi] fetchCompanySkills failed:', err);
    return [];
  }
}

// ── Heartbeat runs (history + drill-down) ────────────────────────

export interface PaperclipHeartbeatRunSummary {
  id: string;
  agentId: string;
  status: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  invocationSource?: string | null;
  triggerDetail?: string | null;
  /** Aggregated metrics, when the backend provides them on the summary. */
  inputTokens?: number | null;
  outputTokens?: number | null;
  costCents?: number | null;
  model?: string | null;
  provider?: string | null;
}

/** Per-agent run list, newest first. Backend caps to ~50 most recent. */
export async function fetchAgentRuns(
  agentId: string,
  limit = 30,
): Promise<PaperclipHeartbeatRunSummary[]> {
  if (!moduleCompanyId) return [];
  const url = `${moduleBaseUrl}/api/companies/${encodeURIComponent(moduleCompanyId)}/heartbeat-runs?agentId=${encodeURIComponent(agentId)}&limit=${limit}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const raw = (await r.json()) as unknown;
    if (Array.isArray(raw)) return raw as PaperclipHeartbeatRunSummary[];
    if (raw && typeof raw === 'object') {
      const obj = raw as { runs?: unknown };
      if (Array.isArray(obj.runs)) return obj.runs as PaperclipHeartbeatRunSummary[];
    }
    return [];
  } catch (err) {
    console.warn('[PaperclipApi] fetchAgentRuns failed:', err);
    return [];
  }
}

export interface PaperclipRunLogChunk {
  ts: string;
  stream: string;
  chunk: string;
}

export async function fetchRunLog(
  runId: string,
): Promise<PaperclipRunLogChunk[]> {
  const url = `${moduleBaseUrl}/api/heartbeat-runs/${encodeURIComponent(runId)}/log`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const raw = (await r.json()) as unknown;
    if (Array.isArray(raw)) return raw as PaperclipRunLogChunk[];
    if (raw && typeof raw === 'object') {
      const obj = raw as { entries?: unknown; log?: unknown };
      if (Array.isArray(obj.entries)) return obj.entries as PaperclipRunLogChunk[];
      if (Array.isArray(obj.log)) return obj.log as PaperclipRunLogChunk[];
    }
    return [];
  } catch (err) {
    console.warn('[PaperclipApi] fetchRunLog failed:', err);
    return [];
  }
}

// ── Run drill-down (Session 6 — Events / Issues / Workspace) ────
//
// Paperclip's Runs tab opens a per-run drawer with multiple sub-panels.
// We already had Log; these are the rest.

export interface PaperclipRunEvent {
  id: string;
  seq: number;
  eventType: string;
  stream?: 'system' | 'stdout' | 'stderr' | string | null;
  level?: string | null;
  color?: string | null;
  message?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt: string;
}

export async function fetchRunEvents(
  runId: string,
  opts: { afterSeq?: number; limit?: number } = {},
): Promise<PaperclipRunEvent[]> {
  const params = new URLSearchParams();
  if (opts.afterSeq != null) params.set('afterSeq', String(opts.afterSeq));
  params.set('limit', String(opts.limit ?? 200));
  const url = `${moduleBaseUrl}/api/heartbeat-runs/${encodeURIComponent(runId)}/events?${params}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const raw = (await r.json()) as unknown;
    if (Array.isArray(raw)) return raw as PaperclipRunEvent[];
    if (raw && typeof raw === 'object') {
      const obj = raw as { events?: unknown };
      if (Array.isArray(obj.events)) return obj.events as PaperclipRunEvent[];
    }
    return [];
  } catch (err) {
    console.warn('[PaperclipApi] fetchRunEvents failed:', err);
    return [];
  }
}

export interface PaperclipRunIssue {
  issueId: string;
  identifier?: string | null;
  title: string;
  status: string;
  priority?: string | null;
}

export async function fetchRunIssuesTouched(
  runId: string,
): Promise<PaperclipRunIssue[]> {
  const url = `${moduleBaseUrl}/api/heartbeat-runs/${encodeURIComponent(runId)}/issues`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const raw = (await r.json()) as unknown;
    if (Array.isArray(raw)) return raw as PaperclipRunIssue[];
    if (raw && typeof raw === 'object') {
      const obj = raw as { issues?: unknown };
      if (Array.isArray(obj.issues)) return obj.issues as PaperclipRunIssue[];
    }
    return [];
  } catch (err) {
    console.warn('[PaperclipApi] fetchRunIssuesTouched failed:', err);
    return [];
  }
}

export interface PaperclipWorkspaceOperation {
  id: string;
  operation: string;
  status?: string | null;
  message?: string | null;
  createdAt: string;
  payload?: Record<string, unknown> | null;
}

export async function fetchRunWorkspaceOperations(
  runId: string,
): Promise<PaperclipWorkspaceOperation[]> {
  const url = `${moduleBaseUrl}/api/heartbeat-runs/${encodeURIComponent(runId)}/workspace-operations`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const raw = (await r.json()) as unknown;
    if (Array.isArray(raw)) return raw as PaperclipWorkspaceOperation[];
    if (raw && typeof raw === 'object') {
      const obj = raw as { operations?: unknown };
      if (Array.isArray(obj.operations)) {
        return obj.operations as PaperclipWorkspaceOperation[];
      }
    }
    return [];
  } catch (err) {
    console.warn('[PaperclipApi] fetchRunWorkspaceOperations failed:', err);
    return [];
  }
}

export async function cancelRun(runId: string): Promise<boolean> {
  const url = `${moduleBaseUrl}/api/heartbeat-runs/${encodeURIComponent(runId)}/cancel`;
  try {
    const r = await fetch(url, { method: 'POST' });
    return r.ok;
  } catch (err) {
    console.warn('[PaperclipApi] cancelRun failed:', err);
    return false;
  }
}

// ── Routines (Session 7) ─────────────────────────────────────────
//
// Paperclip's recurring/triggered work mechanism. Each routine has:
//   - core fields: title, description, assigneeAgentId, projectId
//   - status: active | paused | archived (terminal)
//   - one or more triggers (kind = schedule | webhook | api)
//   - a history of runs (one per fire)
//   - immutable revisions on every save
//
// Our v1 surface:
//   - List + create + status toggle + delete (archive)
//   - Edit title/description, run manually
//   - Schedule triggers via a preset → cron translator (every day /
//     hour / week / custom). Webhook + api kinds visible in the list
//     but not editable here (webhook needs secret rotation UI).
//   - Runs + Activity + History sub-tabs.
//
// No agentId server-side filter — `fetchCompanyRoutines` returns all,
// caller filters by `assigneeAgentId` for the per-agent modal.

export type PaperclipRoutineStatus = 'active' | 'paused' | 'archived';

export type PaperclipRoutinePriority = 'critical' | 'high' | 'medium' | 'low';

export type PaperclipRoutineConcurrency =
  | 'coalesce_if_active'
  | 'skip_if_active'
  | 'always_enqueue';

export type PaperclipRoutineCatchUp =
  | 'skip_missed'
  | 'enqueue_missed_with_cap';

export interface PaperclipRoutineVariable {
  key: string;
  label?: string | null;
  type: 'text' | 'number' | 'boolean' | 'select' | string;
  required?: boolean;
  defaultValue?: unknown;
  options?: string[];
}

export interface PaperclipRoutine {
  id: string;
  companyId: string;
  projectId?: string | null;
  goalId?: string | null;
  parentIssueId?: string | null;
  title: string;
  description?: string | null;
  assigneeAgentId?: string | null;
  priority: PaperclipRoutinePriority;
  status: PaperclipRoutineStatus;
  concurrencyPolicy?: PaperclipRoutineConcurrency;
  catchUpPolicy?: PaperclipRoutineCatchUp;
  variables?: PaperclipRoutineVariable[];
  latestRevisionId?: string | null;
  latestRevisionNumber?: number;
  lastTriggeredAt?: string | null;
  lastEnqueuedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Some endpoints return triggers inline on the detail response. */
  triggers?: PaperclipRoutineTrigger[];
}

export type PaperclipTriggerKind = 'schedule' | 'webhook' | 'api';

export interface PaperclipRoutineTrigger {
  id: string;
  routineId: string;
  kind: PaperclipTriggerKind | string;
  label?: string | null;
  enabled: boolean;
  // Schedule fields
  cronExpression?: string | null;
  timezone?: string | null;
  nextRunAt?: string | null;
  lastFiredAt?: string | null;
  // Webhook fields
  publicId?: string | null;
  signingMode?: 'bearer' | 'hmac_sha256' | string | null;
  replayWindowSec?: number | null;
  lastResult?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PaperclipRoutineRunStatus =
  | 'received'
  | 'coalesced'
  | 'skipped'
  | 'issue_created'
  | 'completed';

export type PaperclipRoutineRunSource =
  | 'schedule'
  | 'manual'
  | 'api'
  | 'webhook';

export interface PaperclipRoutineRun {
  id: string;
  companyId: string;
  routineId: string;
  triggerId?: string | null;
  source: PaperclipRoutineRunSource | string;
  status: PaperclipRoutineRunStatus | string;
  triggeredAt: string;
  completedAt?: string | null;
  linkedIssueId?: string | null;
  failureReason?: string | null;
}

export interface PaperclipRoutineRevision {
  id: string;
  routineId: string;
  revisionNumber: number;
  createdAt: string;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  changedKeys?: string[];
  /** Free-form snapshot — the detail dialog shows the title/description. */
  snapshot?: Record<string, unknown>;
}

// ── Routines: CRUD ──────────────────────────────────────────────

export async function fetchCompanyRoutines(): Promise<PaperclipRoutine[]> {
  if (!moduleCompanyId) return [];
  const url = `${moduleBaseUrl}/api/companies/${encodeURIComponent(moduleCompanyId)}/routines`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const raw = (await r.json()) as unknown;
    if (Array.isArray(raw)) return raw as PaperclipRoutine[];
    if (raw && typeof raw === 'object') {
      const obj = raw as { routines?: unknown };
      if (Array.isArray(obj.routines)) return obj.routines as PaperclipRoutine[];
    }
    return [];
  } catch (err) {
    console.warn('[PaperclipApi] fetchCompanyRoutines failed:', err);
    return [];
  }
}

export async function fetchRoutine(
  routineId: string,
): Promise<PaperclipRoutine | null> {
  const url = `${moduleBaseUrl}/api/routines/${encodeURIComponent(routineId)}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as PaperclipRoutine;
  } catch (err) {
    console.warn('[PaperclipApi] fetchRoutine failed:', err);
    return null;
  }
}

export interface CreateRoutineInput {
  title: string;
  description?: string | null;
  assigneeAgentId?: string | null;
  projectId?: string | null;
  goalId?: string | null;
  parentIssueId?: string | null;
  priority?: PaperclipRoutinePriority;
  status?: PaperclipRoutineStatus;
  concurrencyPolicy?: PaperclipRoutineConcurrency;
  catchUpPolicy?: PaperclipRoutineCatchUp;
  variables?: PaperclipRoutineVariable[];
}

export async function createRoutine(
  input: CreateRoutineInput,
): Promise<PaperclipRoutine | null> {
  if (!moduleCompanyId) return null;
  const url = `${moduleBaseUrl}/api/companies/${encodeURIComponent(moduleCompanyId)}/routines`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} — ${txt.slice(0, 200)}`);
    }
    return (await r.json()) as PaperclipRoutine;
  } catch (err) {
    console.warn('[PaperclipApi] createRoutine failed:', err);
    return null;
  }
}

export async function updateRoutine(
  routineId: string,
  patch: Partial<CreateRoutineInput>,
): Promise<PaperclipRoutine | null> {
  const url = `${moduleBaseUrl}/api/routines/${encodeURIComponent(routineId)}`;
  try {
    const r = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} — ${txt.slice(0, 200)}`);
    }
    return (await r.json()) as PaperclipRoutine;
  } catch (err) {
    console.warn('[PaperclipApi] updateRoutine failed:', err);
    return null;
  }
}

/** Delete = archive. Paperclip treats archived as terminal. */
export async function deleteRoutine(routineId: string): Promise<boolean> {
  const url = `${moduleBaseUrl}/api/routines/${encodeURIComponent(routineId)}`;
  try {
    const r = await fetch(url, { method: 'DELETE' });
    if (r.ok) return true;
    // Some installs reject hard delete; fall back to status=archived.
    const patched = await updateRoutine(routineId, { status: 'archived' });
    return patched != null;
  } catch (err) {
    console.warn('[PaperclipApi] deleteRoutine failed:', err);
    return false;
  }
}

/** Fire a manual run NOW. Returns the created run or null. */
export async function runRoutineNow(
  routineId: string,
  opts: { triggerId?: string; payload?: Record<string, unknown> } = {},
): Promise<PaperclipRoutineRun | null> {
  const url = `${moduleBaseUrl}/api/routines/${encodeURIComponent(routineId)}/run`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'manual', ...opts }),
    });
    if (!r.ok) return null;
    return (await r.json()) as PaperclipRoutineRun;
  } catch (err) {
    console.warn('[PaperclipApi] runRoutineNow failed:', err);
    return null;
  }
}

// ── Triggers ────────────────────────────────────────────────────

export interface CreateScheduleTriggerInput {
  kind: 'schedule';
  cronExpression: string;
  timezone?: string;
  label?: string;
  enabled?: boolean;
}

export interface CreateWebhookTriggerInput {
  kind: 'webhook';
  signingMode?: 'bearer' | 'hmac_sha256';
  replayWindowSec?: number;
  label?: string;
  enabled?: boolean;
}

export interface CreateApiTriggerInput {
  kind: 'api';
  label?: string;
  enabled?: boolean;
}

export type CreateTriggerInput =
  | CreateScheduleTriggerInput
  | CreateWebhookTriggerInput
  | CreateApiTriggerInput;

export async function createRoutineTrigger(
  routineId: string,
  input: CreateTriggerInput,
): Promise<PaperclipRoutineTrigger | null> {
  const url = `${moduleBaseUrl}/api/routines/${encodeURIComponent(routineId)}/triggers`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} — ${txt.slice(0, 200)}`);
    }
    return (await r.json()) as PaperclipRoutineTrigger;
  } catch (err) {
    console.warn('[PaperclipApi] createRoutineTrigger failed:', err);
    return null;
  }
}

export async function updateRoutineTrigger(
  triggerId: string,
  patch: Partial<{
    cronExpression: string;
    timezone: string;
    enabled: boolean;
    label: string;
    signingMode: 'bearer' | 'hmac_sha256';
    replayWindowSec: number;
  }>,
): Promise<PaperclipRoutineTrigger | null> {
  const url = `${moduleBaseUrl}/api/routine-triggers/${encodeURIComponent(triggerId)}`;
  try {
    const r = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) return null;
    return (await r.json()) as PaperclipRoutineTrigger;
  } catch (err) {
    console.warn('[PaperclipApi] updateRoutineTrigger failed:', err);
    return null;
  }
}

export async function deleteRoutineTrigger(
  triggerId: string,
): Promise<boolean> {
  const url = `${moduleBaseUrl}/api/routine-triggers/${encodeURIComponent(triggerId)}`;
  try {
    const r = await fetch(url, { method: 'DELETE' });
    return r.ok;
  } catch (err) {
    console.warn('[PaperclipApi] deleteRoutineTrigger failed:', err);
    return false;
  }
}

// ── Runs + Revisions ───────────────────────────────────────────

export async function fetchRoutineRuns(
  routineId: string,
  limit = 50,
): Promise<PaperclipRoutineRun[]> {
  const url = `${moduleBaseUrl}/api/routines/${encodeURIComponent(routineId)}/runs?limit=${limit}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const raw = (await r.json()) as unknown;
    if (Array.isArray(raw)) return raw as PaperclipRoutineRun[];
    if (raw && typeof raw === 'object') {
      const obj = raw as { runs?: unknown };
      if (Array.isArray(obj.runs)) return obj.runs as PaperclipRoutineRun[];
    }
    return [];
  } catch (err) {
    console.warn('[PaperclipApi] fetchRoutineRuns failed:', err);
    return [];
  }
}

export async function fetchRoutineRevisions(
  routineId: string,
): Promise<PaperclipRoutineRevision[]> {
  const url = `${moduleBaseUrl}/api/routines/${encodeURIComponent(routineId)}/revisions`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const raw = (await r.json()) as unknown;
    if (Array.isArray(raw)) return raw as PaperclipRoutineRevision[];
    if (raw && typeof raw === 'object') {
      const obj = raw as { revisions?: unknown };
      if (Array.isArray(obj.revisions))
        return obj.revisions as PaperclipRoutineRevision[];
    }
    return [];
  } catch (err) {
    console.warn('[PaperclipApi] fetchRoutineRevisions failed:', err);
    return [];
  }
}

export async function restoreRoutineRevision(
  routineId: string,
  revisionId: string,
): Promise<boolean> {
  const url = `${moduleBaseUrl}/api/routines/${encodeURIComponent(routineId)}/revisions/${encodeURIComponent(revisionId)}/restore`;
  try {
    const r = await fetch(url, { method: 'POST' });
    return r.ok;
  } catch (err) {
    console.warn('[PaperclipApi] restoreRoutineRevision failed:', err);
    return false;
  }
}

// ── Cron preset helpers (Session 7 UI sugar) ────────────────────
//
// Translates between Paperclip's cron strings ("M H * * *") and the
// UI's preset chooser. Daily / hourly / weekly / custom — matches the
// dashboard screenshot's schedule editor.

export type SchedulePreset = 'minutely' | 'hourly' | 'daily' | 'weekly' | 'custom';

export interface ScheduleParts {
  preset: SchedulePreset;
  hour?: number; // 0..23
  minute?: number; // 0..59
  dayOfWeek?: number; // 0..6 (0 = Sunday)
  customCron?: string;
}

/** Compose a cron string from preset + time bits. */
export function partsToCron(parts: ScheduleParts): string {
  const m = parts.minute ?? 0;
  const h = parts.hour ?? 0;
  const d = parts.dayOfWeek ?? 0;
  switch (parts.preset) {
    case 'minutely':
      return '* * * * *';
    case 'hourly':
      return `${m} * * * *`;
    case 'daily':
      return `${m} ${h} * * *`;
    case 'weekly':
      return `${m} ${h} * * ${d}`;
    case 'custom':
      return (parts.customCron ?? '').trim();
  }
}

/** Best-effort decode of common preset patterns. Falls back to 'custom'. */
export function cronToParts(cron: string | null | undefined): ScheduleParts {
  if (!cron) return { preset: 'daily', hour: 9, minute: 0 };
  const trimmed = cron.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return { preset: 'custom', customCron: trimmed };
  const [m, h, dom, mon, dow] = parts;
  const mNum = Number(m);
  const hNum = Number(h);
  const dowNum = Number(dow);
  if (trimmed === '* * * * *') return { preset: 'minutely' };
  if (h === '*' && dom === '*' && mon === '*' && dow === '*' && Number.isFinite(mNum)) {
    return { preset: 'hourly', minute: mNum };
  }
  if (dom === '*' && mon === '*' && dow === '*' && Number.isFinite(mNum) && Number.isFinite(hNum)) {
    return { preset: 'daily', hour: hNum, minute: mNum };
  }
  if (
    dom === '*' &&
    mon === '*' &&
    Number.isFinite(mNum) &&
    Number.isFinite(hNum) &&
    Number.isFinite(dowNum)
  ) {
    return { preset: 'weekly', hour: hNum, minute: mNum, dayOfWeek: dowNum };
  }
  return { preset: 'custom', customCron: trimmed };
}

/** Human-readable description for the schedule chip. */
export function describeCron(cron: string | null | undefined): string {
  if (!cron) return '—';
  const p = cronToParts(cron);
  const t = (h?: number, m?: number) =>
    `${String(h ?? 0).padStart(2, '0')}:${String(m ?? 0).padStart(2, '0')}`;
  const days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  switch (p.preset) {
    case 'minutely':
      return 'כל דקה';
    case 'hourly':
      return `כל שעה ב-:${String(p.minute ?? 0).padStart(2, '0')}`;
    case 'daily':
      return `כל יום ב-${t(p.hour, p.minute)}`;
    case 'weekly':
      return `כל ${days[p.dayOfWeek ?? 0] ?? '—'} ב-${t(p.hour, p.minute)}`;
    case 'custom':
      return `cron: ${p.customCron ?? cron}`;
  }
}

// ── Agent configuration (Session 5) ──────────────────────────────
//
// Three endpoints live here, mirroring Paperclip's own Configuration
// tab:
//   GET  /agents/:id/configuration       → live config snapshot
//   GET  /agents/:id/config-revisions    → history list
//   GET  /agents/:id/config-revisions/:r → single revision detail
//   POST /agents/:id/config-revisions/:r/rollback → restore
//   PATCH /agents/:id/permissions        → permissions (separate from
//                                          the main PATCH agent endpoint)
//
// Update writes use `updateAgent` (already defined above), which hits
// `PATCH /agents/:id` with the merged adapterConfig semantics. Pass
// `replaceAdapterConfig: true` in the patch to fully replace rather
// than shallow-merge (we use merge by default — safer when the UI
// only knows about a subset of keys).

export interface PaperclipAgentPermissions {
  canCreateAgents: boolean;
  canAssignTasks: boolean;
}

export interface PaperclipAgentConfiguration {
  id: string;
  companyId: string;
  name: string;
  role?: string | null;
  title?: string | null;
  status?: string | null;
  reportsTo?: string | null;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  permissions: PaperclipAgentPermissions;
  updatedAt?: string;
}

export async function fetchAgentConfiguration(
  agentId: string,
): Promise<PaperclipAgentConfiguration | null> {
  const url = `${moduleBaseUrl}/api/agents/${encodeURIComponent(agentId)}/configuration`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const raw = (await r.json()) as Partial<PaperclipAgentConfiguration>;
    return {
      id: String(raw.id ?? agentId),
      companyId: String(raw.companyId ?? ''),
      name: String(raw.name ?? ''),
      role: raw.role ?? null,
      title: raw.title ?? null,
      status: raw.status ?? null,
      reportsTo: raw.reportsTo ?? null,
      adapterType: String(raw.adapterType ?? ''),
      adapterConfig:
        (raw.adapterConfig as Record<string, unknown> | undefined) ?? {},
      runtimeConfig:
        (raw.runtimeConfig as Record<string, unknown> | undefined) ?? {},
      permissions: {
        canCreateAgents: Boolean(raw.permissions?.canCreateAgents),
        canAssignTasks: Boolean(raw.permissions?.canAssignTasks),
      },
      updatedAt: raw.updatedAt,
    };
  } catch (err) {
    console.warn('[PaperclipApi] fetchAgentConfiguration failed:', err);
    return null;
  }
}

export interface PaperclipConfigRevision {
  id: string;
  companyId: string;
  agentId: string;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  source: string;
  rolledBackFromRevisionId?: string | null;
  changedKeys: string[];
  beforeConfig?: Record<string, unknown>;
  afterConfig?: Record<string, unknown>;
  createdAt: string;
}

export async function fetchAgentConfigRevisions(
  agentId: string,
): Promise<PaperclipConfigRevision[]> {
  const url = `${moduleBaseUrl}/api/agents/${encodeURIComponent(agentId)}/config-revisions`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const raw = (await r.json()) as unknown;
    if (Array.isArray(raw)) return raw as PaperclipConfigRevision[];
    if (raw && typeof raw === 'object') {
      const obj = raw as { revisions?: unknown };
      if (Array.isArray(obj.revisions)) return obj.revisions as PaperclipConfigRevision[];
    }
    return [];
  } catch (err) {
    console.warn('[PaperclipApi] fetchAgentConfigRevisions failed:', err);
    return [];
  }
}

export async function rollbackAgentConfigRevision(
  agentId: string,
  revisionId: string,
): Promise<boolean> {
  const url = `${moduleBaseUrl}/api/agents/${encodeURIComponent(agentId)}/config-revisions/${encodeURIComponent(revisionId)}/rollback`;
  try {
    const r = await fetch(url, { method: 'POST' });
    return r.ok;
  } catch (err) {
    console.warn('[PaperclipApi] rollbackAgentConfigRevision failed:', err);
    return false;
  }
}

export async function updateAgentPermissions(
  agentId: string,
  permissions: PaperclipAgentPermissions,
): Promise<boolean> {
  const url = `${moduleBaseUrl}/api/agents/${encodeURIComponent(agentId)}/permissions`;
  try {
    const r = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(permissions),
    });
    return r.ok;
  } catch (err) {
    console.warn('[PaperclipApi] updateAgentPermissions failed:', err);
    return false;
  }
}

// ── Agent instructions bundle (Session 6 — multi-file) ──────────
//
// Paperclip's Instructions tab is a multi-file bundle, not a single
// document. The bundle has an `entryFile` (the primary prompt — like
// `system.md`) and any number of sibling files (knowledge base
// attachments the agent can reference). UI shows a file tree + an
// editor pane for the selected file.
//
// Endpoints:
//   GET    /agents/:id/instructions-bundle         → bundle + files[]
//   PATCH  /agents/:id/instructions-bundle         → bundle metadata
//   GET    /agents/:id/instructions-bundle/file?path=… → single file
//   PUT    /agents/:id/instructions-bundle/file    → upsert file
//   DELETE /agents/:id/instructions-bundle/file?path=… → remove file

export interface PaperclipInstructionsFile {
  path: string;
  bytes?: number;
  updatedAt?: string;
  /** True when the entry-file is this one (drives the "★" badge). */
  isEntry?: boolean;
}

export interface PaperclipInstructionsBundle {
  agentId: string;
  mode?: 'managed' | 'external' | string;
  rootPath?: string | null;
  managedRootPath?: string | null;
  /** Path of the primary file (often `system.md` or `AGENTS.md`). */
  entryPath: string;
  /** Resolved absolute path on disk — useful for "open in editor" hints. */
  resolvedEntryPath?: string | null;
  /** True when the operator can edit (false for read-only managed bundles). */
  editable: boolean;
  warnings: string[];
  files: PaperclipInstructionsFile[];
}

function normalizeBundle(
  agentId: string,
  raw: Record<string, unknown>,
): PaperclipInstructionsBundle {
  const entryFile = (raw.entryFile as Record<string, unknown> | undefined) ?? {};
  const entryPath = String(
    (entryFile.path as string | undefined) ??
      (raw.entryPath as string | undefined) ??
      'system.md',
  );
  const filesRaw = Array.isArray(raw.files) ? (raw.files as unknown[]) : [];
  const files: PaperclipInstructionsFile[] = filesRaw
    .map((f) => f as Record<string, unknown>)
    .map((f) => ({
      path: String(f.path ?? ''),
      bytes: typeof f.bytes === 'number' ? f.bytes : undefined,
      updatedAt: typeof f.updatedAt === 'string' ? f.updatedAt : undefined,
      isEntry: String(f.path ?? '') === entryPath,
    }))
    .filter((f) => f.path.length > 0);
  // Ensure entry-file is in the list even if the backend omitted it.
  if (!files.some((f) => f.path === entryPath)) {
    files.unshift({ path: entryPath, isEntry: true });
  }
  return {
    agentId,
    mode: (raw.mode as string | undefined) ?? undefined,
    rootPath: (raw.rootPath as string | undefined) ?? null,
    managedRootPath: (raw.managedRootPath as string | undefined) ?? null,
    entryPath,
    resolvedEntryPath:
      (raw.resolvedEntryPath as string | undefined) ?? null,
    editable: raw.editable !== false,
    warnings: Array.isArray(raw.warnings) ? (raw.warnings as string[]) : [],
    files,
  };
}

export async function fetchAgentInstructions(
  agentId: string,
): Promise<PaperclipInstructionsBundle | null> {
  const url = `${moduleBaseUrl}/api/agents/${encodeURIComponent(agentId)}/instructions-bundle`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const raw = (await r.json()) as Record<string, unknown>;
    return normalizeBundle(agentId, raw);
  } catch (err) {
    console.warn('[PaperclipApi] fetchAgentInstructions failed:', err);
    return null;
  }
}

/** Fetch a single file's content from the bundle. */
export async function fetchInstructionsFile(
  agentId: string,
  path: string,
): Promise<{ path: string; content: string } | null> {
  const url = `${moduleBaseUrl}/api/agents/${encodeURIComponent(agentId)}/instructions-bundle/file?path=${encodeURIComponent(path)}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const raw = (await r.json()) as { path?: string; content?: string };
    return {
      path: String(raw.path ?? path),
      content: String(raw.content ?? ''),
    };
  } catch (err) {
    console.warn('[PaperclipApi] fetchInstructionsFile failed:', err);
    return null;
  }
}

/** Upsert a file's content (PUT). Used by the editor's Save button. */
export async function saveInstructionsFile(
  agentId: string,
  path: string,
  content: string,
): Promise<boolean> {
  const url = `${moduleBaseUrl}/api/agents/${encodeURIComponent(agentId)}/instructions-bundle/file`;
  try {
    const r = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    });
    return r.ok;
  } catch (err) {
    console.warn('[PaperclipApi] saveInstructionsFile failed:', err);
    return false;
  }
}

export async function deleteInstructionsFile(
  agentId: string,
  path: string,
): Promise<boolean> {
  const url = `${moduleBaseUrl}/api/agents/${encodeURIComponent(agentId)}/instructions-bundle/file?path=${encodeURIComponent(path)}`;
  try {
    const r = await fetch(url, { method: 'DELETE' });
    return r.ok;
  } catch (err) {
    console.warn('[PaperclipApi] deleteInstructionsFile failed:', err);
    return false;
  }
}

/**
 * Back-compat for the single-file save the old InstructionsTab used.
 * New callers should prefer `saveInstructionsFile(agentId, path, content)`
 * since the bundle is multi-file. Kept as a thin alias that resolves
 * the entry-file path from the bundle first.
 */
export async function updateAgentInstructions(
  agentId: string,
  content: string,
): Promise<boolean> {
  const bundle = await fetchAgentInstructions(agentId);
  if (!bundle) return false;
  return saveInstructionsFile(agentId, bundle.entryPath, content);
}

/** PATCH `/agents/:id` with partial config changes. */
export async function updateAgent(
  agentId: string,
  patch: Partial<PaperclipAgentDetail>,
): Promise<PaperclipAgentDetail | null> {
  const url = `${moduleBaseUrl}/api/agents/${encodeURIComponent(agentId)}`;
  try {
    const r = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} — ${txt.slice(0, 200)}`);
    }
    return (await r.json()) as PaperclipAgentDetail;
  } catch (err) {
    console.warn('[PaperclipApi] updateAgent failed:', err);
    return null;
  }
}

// ── Agent creation (Session 3 — "+ agent" flow) ──────────────────
//
// Paperclip's self-create form posts to `/companies/:id/agent-hires`
// (NOT `/agents`). The endpoint validates against `createAgentSchema`
// which has 3 required fields (name, role, adapterType) and ~22
// optional ones. We expose a narrow GoalsModal-friendly subset; the
// operator can edit deeper fields via the AgentManagementModal after
// the agent exists.
//
// The "ask CEO" path doesn't hit this endpoint at all — it just
// creates a regular issue assigned to the CEO (caller's responsibility
// to find the CEO and use `createIssue` directly).

export const AGENT_ROLES = [
  'ceo',
  'cto',
  'cmo',
  'cfo',
  'coo',
  'engineer',
  'designer',
  'pm',
  'qa',
  'finance',
  'operations',
  'general',
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

// Adapter types Paperclip's backend accepts on POST /agent-hires.
// Verified against `packages/shared/src/constants.ts AGENT_ADAPTER_TYPES`.
// The backend rejects any other value with HTTP 422 ("Unknown adapter
// type: ..."). Note the underscore + `_local` / `_cloud` suffixes —
// they are NOT hyphenated like the UI labels suggest.
export const AGENT_ADAPTER_TYPES = [
  'claude_local',
  'codex_local',
  'cursor',
  'cursor_cloud',
  'gemini_local',
  'grok_local',
  'hermes_local',
  'openclaw_gateway',
  'opencode_local',
  'pi_local',
] as const;
export type AgentAdapterType = (typeof AGENT_ADAPTER_TYPES)[number];

export interface CreateAgentInput {
  name: string;
  role?: AgentRole;
  title?: string | null;
  icon?: string | null;
  reportsTo?: string | null;
  adapterType: AgentAdapterType | string;
  adapterConfig?: Record<string, unknown>;
  /**
   * Top-level runtime knobs (heartbeat policy, max turns, etc.). Sent
   * separately from adapterConfig so the backend can split per-adapter
   * defaults from policy-level overrides.
   */
  runtimeConfig?: Record<string, unknown>;
  capabilities?: string | null;
  budgetMonthlyCents?: number;
}

export interface CreateAgentResult {
  agent: PaperclipAgentDetail;
  /** Some installs require admin approval — pending approval row, if any. */
  approval?: unknown;
}

/** Create a new agent. Endpoint: `POST /companies/:id/agent-hires`. */
export async function createAgentHire(
  input: CreateAgentInput,
): Promise<CreateAgentResult | null> {
  if (!moduleCompanyId) return null;
  const url = `${moduleBaseUrl}/api/companies/${encodeURIComponent(moduleCompanyId)}/agent-hires`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: input.name,
        role: input.role ?? 'general',
        title: input.title ?? null,
        icon: input.icon ?? null,
        reportsTo: input.reportsTo ?? null,
        adapterType: input.adapterType,
        adapterConfig: input.adapterConfig ?? {},
        ...(input.runtimeConfig ? { runtimeConfig: input.runtimeConfig } : {}),
        capabilities: input.capabilities ?? null,
        budgetMonthlyCents: input.budgetMonthlyCents ?? 0,
      }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} — ${txt.slice(0, 200)}`);
    }
    return (await r.json()) as CreateAgentResult;
  } catch (err) {
    console.warn('[PaperclipApi] createAgentHire failed:', err);
    return null;
  }
}

// ── Organizational hierarchy ─────────────────────────────────────
//
// Paperclip exposes `GET /companies/:id/org` which returns the agent
// hierarchy as a pre-built recursive tree (walking `reportsTo`
// server-side, so we don't have to do it ourselves). Each node has
// the agent's identity + role + status, plus a `reports[]` array of
// child OrgNodes.
//
// Note (Session 1.2 cleanup): the previously-exposed server-rendered
// SVG/PNG exports (`/org.svg`, `/org.png`) were dropped from the UI
// because the static image had no interactive value. Session 3 will
// replace this list view with a proper visual hierarchy (boxes-and-
// lines, drag-to-reparent).

export interface OrgNode {
  id: string;
  name: string;
  role?: string | null;
  title?: string | null;
  status?: string | null;
  icon?: string | null;
  reports: OrgNode[];
}

/** Fetch the company's hierarchy tree (recursive). Null on failure. */
export async function fetchCompanyOrg(): Promise<OrgNode[] | null> {
  if (!moduleCompanyId) return null;
  const url = `${moduleBaseUrl}/api/companies/${encodeURIComponent(moduleCompanyId)}/org`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const raw = (await r.json()) as unknown;
    // Endpoint may return either an array of root nodes or a single root
    // wrapped in { root: ... } — accept both.
    if (Array.isArray(raw)) return raw as OrgNode[];
    if (raw && typeof raw === 'object') {
      const obj = raw as { roots?: unknown; root?: unknown; tree?: unknown };
      if (Array.isArray(obj.roots)) return obj.roots as OrgNode[];
      if (Array.isArray(obj.tree)) return obj.tree as OrgNode[];
      if (obj.root && typeof obj.root === 'object') return [obj.root as OrgNode];
    }
    return null;
  } catch (err) {
    console.warn('[PaperclipApi] fetchCompanyOrg failed:', err);
    return null;
  }
}

/** Fetch one goal by id — used by the Goals modal's edit form. */
export async function fetchGoalById(goalId: string): Promise<PaperclipGoal | null> {
  const url = `${moduleBaseUrl}/api/goals/${encodeURIComponent(goalId)}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as PaperclipGoal;
  } catch (err) {
    console.warn('[PaperclipApi] fetchGoalById failed:', err);
    return null;
  }
}

/** Create a goal. `title` and `level` are required by the backend. */
export async function createGoal(input: GoalInput): Promise<PaperclipGoal | null> {
  if (!moduleCompanyId) return null;
  const url = `${moduleBaseUrl}/api/companies/${encodeURIComponent(moduleCompanyId)}/goals`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} — ${txt.slice(0, 200)}`);
    }
    return (await r.json()) as PaperclipGoal;
  } catch (err) {
    console.warn('[PaperclipApi] createGoal failed:', err);
    return null;
  }
}

/** Update a goal (partial). Endpoint: `PATCH /goals/:id`. */
export async function updateGoal(
  goalId: string,
  patch: GoalInput,
): Promise<PaperclipGoal | null> {
  const url = `${moduleBaseUrl}/api/goals/${encodeURIComponent(goalId)}`;
  try {
    const r = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} — ${txt.slice(0, 200)}`);
    }
    return (await r.json()) as PaperclipGoal;
  } catch (err) {
    console.warn('[PaperclipApi] updateGoal failed:', err);
    return null;
  }
}

/**
 * Delete a goal. Backend returns 204 on success. Returns true on
 * success, false on any error — callers refetch the list either way.
 */
export async function deleteGoal(goalId: string): Promise<boolean> {
  const url = `${moduleBaseUrl}/api/goals/${encodeURIComponent(goalId)}`;
  try {
    const r = await fetch(url, { method: 'DELETE' });
    return r.ok;
  } catch (err) {
    console.warn('[PaperclipApi] deleteGoal failed:', err);
    return false;
  }
}

/** Fetch one project by id — used by the edit modal. */
export async function fetchProjectById(
  projectId: string,
): Promise<PaperclipProject | null> {
  const url = `${moduleBaseUrl}/api/projects/${encodeURIComponent(projectId)}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as PaperclipProject;
  } catch (err) {
    console.warn('[PaperclipApi] fetchProjectById failed:', err);
    return null;
  }
}

/**
 * Set a lifetime budget cap on a project — upserts a `budget_policies`
 * row scoped to the project. Endpoint: `POST /companies/:id/budgets/policies`.
 * `amountCents` is the cap in cents.
 *
 * Note: reading the *current* cap / live spend lives in Paperclip's cost
 * dashboard; this client only writes the cap.
 */
export async function setProjectBudget(
  projectId: string,
  amountCents: number,
): Promise<boolean> {
  if (!moduleCompanyId) return false;
  const url = `${moduleBaseUrl}/api/companies/${encodeURIComponent(moduleCompanyId)}/budgets/policies`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scopeType: 'project',
        scopeId: projectId,
        amount: amountCents,
        windowKind: 'lifetime',
      }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} — ${txt.slice(0, 200)}`);
    }
    return true;
  } catch (err) {
    console.warn('[PaperclipApi] setProjectBudget failed:', err);
    return false;
  }
}

/**
 * A heartbeat run summary — only the fields the chat panel needs.
 * Used to resolve which agent emitted a comment when `authorAgentId`
 * is missing (local_trusted mode, no JWT injected) but `createdByRunId`
 * is set. The run's `agentId` is the authoritative answer.
 *
 * `issueCommentSatisfiedByCommentId` is the comment the run *produced*
 * (as opposed to merely processed). It is the disambiguator between two
 * shapes that look identical from comment fields alone:
 *   • a comment the AGENT produced but Paperclip stamped with
 *     `authorType: 'user'` because no JWT was injected, and
 *   • a comment the USER typed that happened to wake the run.
 * If `run.issueCommentSatisfiedByCommentId === comment.id` the run
 * produced it → it is agent content despite the `authorType`.
 */
export interface PaperclipHeartbeatRunRef {
  id: string;
  agentId: string;
  issueId?: string | null;
  issueCommentSatisfiedByCommentId?: string | null;
}

/** Fetch a single heartbeat run — used to back-fill agent attribution. */
export async function fetchHeartbeatRun(
  runId: string,
): Promise<PaperclipHeartbeatRunRef | null> {
  const url = `${moduleBaseUrl}/api/heartbeat-runs/${encodeURIComponent(runId)}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const raw = (await r.json()) as Partial<PaperclipHeartbeatRunRef> & {
      id?: string;
      agentId?: string;
      issueCommentSatisfiedByCommentId?: string | null;
    };
    if (!raw.id || !raw.agentId) return null;
    return {
      id: raw.id,
      agentId: raw.agentId,
      issueId: raw.issueId ?? null,
      issueCommentSatisfiedByCommentId:
        raw.issueCommentSatisfiedByCommentId ?? null,
    };
  } catch (err) {
    console.warn('[PaperclipApi] fetchHeartbeatRun failed:', err);
    return null;
  }
}

/**
 * List every issue an agent has *participated* in — Paperclip's
 * `participantAgentId` filter returns issues where the agent is the
 * assignee, creator, a comment author, OR an activity-log actor. This is
 * the correct query for "which issue trees is this agent involved in",
 * as opposed to `fetchAgentIssues` which only covers current assignment.
 *
 * `opts.projectId` adds a server-side `projectId` filter (the two combine
 * with AND) — used by project bookmarks. The "no project" bookmark omits
 * it and filters `projectId === null` client-side, since Paperclip has no
 * null-project sentinel.
 */
export async function fetchParticipantIssues(
  agentUuid: string,
  opts?: { projectId?: string },
): Promise<PaperclipIssue[]> {
  if (!moduleCompanyId) return [];
  let url = `${moduleBaseUrl}/api/companies/${encodeURIComponent(moduleCompanyId)}/issues?participantAgentId=${encodeURIComponent(agentUuid)}&limit=200`;
  if (opts?.projectId) {
    url += `&projectId=${encodeURIComponent(opts.projectId)}`;
  }
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = (await r.json()) as unknown;
    if (Array.isArray(raw)) return raw as PaperclipIssue[];
    if (raw && typeof raw === 'object' && Array.isArray((raw as { issues?: unknown }).issues)) {
      return (raw as { issues: PaperclipIssue[] }).issues;
    }
    console.warn('[PaperclipApi] unexpected issues response shape:', raw);
    return [];
  } catch (err) {
    console.warn('[PaperclipApi] fetchParticipantIssues failed:', err);
    return [];
  }
}

/**
 * List every descendant of an issue — Paperclip's `descendantOf` filter
 * walks the whole sub-tree in a single recursive-CTE query. Does NOT
 * include the ancestor itself; callers merge that in separately.
 */
export async function fetchIssueDescendants(
  rootIssueId: string,
): Promise<PaperclipIssue[]> {
  if (!moduleCompanyId) return [];
  const url = `${moduleBaseUrl}/api/companies/${encodeURIComponent(moduleCompanyId)}/issues?descendantOf=${encodeURIComponent(rootIssueId)}&limit=500`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = (await r.json()) as unknown;
    if (Array.isArray(raw)) return raw as PaperclipIssue[];
    if (raw && typeof raw === 'object' && Array.isArray((raw as { issues?: unknown }).issues)) {
      return (raw as { issues: PaperclipIssue[] }).issues;
    }
    return [];
  } catch (err) {
    console.warn('[PaperclipApi] fetchIssueDescendants failed:', err);
    return [];
  }
}

/** List comments on an issue, ascending (oldest first — chat order). */
export async function fetchIssueComments(issueId: string): Promise<PaperclipComment[]> {
  const url = `${moduleBaseUrl}/api/issues/${encodeURIComponent(issueId)}/comments?order=asc&limit=200`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as PaperclipComment[];
  } catch (err) {
    console.warn('[PaperclipApi] fetchIssueComments failed:', err);
    return [];
  }
}

/**
 * List the direct child issues of a parent — used by the Tasks Panel to
 * render the issue tree (steps under a plan).
 */
export async function fetchIssueChildren(parentIssueId: string): Promise<PaperclipIssue[]> {
  if (!moduleCompanyId) return [];
  const url = `${moduleBaseUrl}/api/companies/${encodeURIComponent(moduleCompanyId)}/issues?parentId=${encodeURIComponent(parentIssueId)}&limit=200`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = (await r.json()) as unknown;
    if (Array.isArray(raw)) return raw as PaperclipIssue[];
    if (raw && typeof raw === 'object' && Array.isArray((raw as { issues?: unknown }).issues)) {
      return (raw as { issues: PaperclipIssue[] }).issues;
    }
    return [];
  } catch (err) {
    console.warn('[PaperclipApi] fetchIssueChildren failed:', err);
    return [];
  }
}

/** Fetch a single issue by id — used for parent breadcrumbs in the Tasks Panel. */
export async function fetchIssueById(issueId: string): Promise<PaperclipIssue | null> {
  const url = `${moduleBaseUrl}/api/issues/${encodeURIComponent(issueId)}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as PaperclipIssue;
  } catch (err) {
    console.warn('[PaperclipApi] fetchIssueById failed:', err);
    return null;
  }
}

/** Look up a cached agent display name. Returns null if unknown. */
export function getAgentName(uuid: string | null | undefined): string | null {
  if (!uuid) return null;
  return agentNameByUuid.get(uuid) ?? null;
}

/**
 * Public-facing agent summary — minimum needed by the chat panel's assignee
 * picker. Paperclip's `/api/companies/:id/agents` returns more fields; we
 * keep the shape narrow on purpose.
 */
export interface PaperclipAgentSummary {
  id: string;
  name: string;
  status: string;
  title?: string | null;
  reportsTo?: string | null;
}

/** List all agents in the active company. Used by the assignee picker. */
export async function fetchCompanyAgents(): Promise<PaperclipAgentSummary[]> {
  if (!moduleCompanyId) return [];
  const url = `${moduleBaseUrl}/api/companies/${encodeURIComponent(moduleCompanyId)}/agents`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as PaperclipAgentSummary[];
  } catch (err) {
    console.warn('[PaperclipApi] fetchCompanyAgents failed:', err);
    return [];
  }
}

/**
 * Change an issue's assignee. Paperclip's PATCH /issues/:id accepts a
 * partial update — we only ever send the one field we care about so
 * unrelated server-side fields aren't accidentally cleared.
 *
 * Side effects on the backend (per server/src/routes/issues.ts):
 *   • Logs `issue.assignee_changed` activity.
 *   • Calls `queueIssueAssignmentWakeup` for the new assignee.
 */
export async function updateIssueAssignee(
  issueId: string,
  assigneeAgentId: string,
): Promise<PaperclipIssue | null> {
  const url = `${moduleBaseUrl}/api/issues/${encodeURIComponent(issueId)}`;
  try {
    const r = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assigneeAgentId }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} — ${txt.slice(0, 200)}`);
    }
    return (await r.json()) as PaperclipIssue;
  } catch (err) {
    console.warn('[PaperclipApi] updateIssueAssignee failed:', err);
    return null;
  }
}

/**
 * Create a new issue assigned to an agent — used by the "+" button in
 * the chat panel to start a brand-new conversation. We intentionally
 * keep the title minimal and the description empty: from the operator's
 * POV this is "open a new chat with X", not "fill an issue form".
 * The issue can always be renamed later in Paperclip's classic UI.
 */
/**
 * Paperclip distinguishes two issue work modes (column `workMode` on the
 * issues table; first-class field, not metadata):
 *   • "standard" — a regular executable task. Default for new issues.
 *   • "planning" — a planning unit. The agent treats it as ideation
 *      / decomposition work rather than direct execution.
 * The createIssue endpoint accepts the value optionally; omitting it
 * leaves the backend's default ("standard") in place.
 */
export type PaperclipIssueWorkMode = 'standard' | 'planning';

export async function createIssue(args: {
  title: string;
  description?: string;
  assigneeAgentId: string;
  /** Status to start in. Defaults to 'todo' so heartbeats may pick it up. */
  status?: string;
  /** Optional priority — Paperclip's vocab: low / medium / high / urgent. */
  priority?: string;
  /** Optional parent issue — used for sub-tasks under a plan. */
  parentId?: string | null;
  /** Optional work mode. Server default is 'standard' when omitted. */
  workMode?: PaperclipIssueWorkMode;
  /** Optional goal this issue contributes to (single, nullable). */
  goalId?: string | null;
}): Promise<PaperclipIssue | null> {
  if (!moduleCompanyId) {
    console.warn('[PaperclipApi] createIssue called before company is known');
    return null;
  }
  const url = `${moduleBaseUrl}/api/companies/${encodeURIComponent(moduleCompanyId)}/issues`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: args.title,
        description: args.description ?? '',
        assigneeAgentId: args.assigneeAgentId,
        status: args.status ?? 'todo',
        ...(args.priority ? { priority: args.priority } : {}),
        ...(args.parentId ? { parentId: args.parentId } : {}),
        ...(args.workMode ? { workMode: args.workMode } : {}),
        ...(args.goalId !== undefined ? { goalId: args.goalId } : {}),
      }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} — ${txt.slice(0, 200)}`);
    }
    return (await r.json()) as PaperclipIssue;
  } catch (err) {
    console.warn('[PaperclipApi] createIssue failed:', err);
    return null;
  }
}

/**
 * Post a new comment to an issue as the human board user. The backend
 * (`POST /api/issues/:id/comments`) records it, fires activity.logged on
 * the WS, and the chat panel picks it up via subscribeActivity.
 */
export async function postIssueComment(issueId: string, body: string): Promise<PaperclipComment | null> {
  const text = body.trim();
  if (!text) return null;
  const url = `${moduleBaseUrl}/api/issues/${encodeURIComponent(issueId)}/comments`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: text }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} — ${txt.slice(0, 200)}`);
    }
    return (await r.json()) as PaperclipComment;
  } catch (err) {
    console.warn('[PaperclipApi] postIssueComment failed:', err);
    return null;
  }
}

async function fetchJson<T>(url: string, timeoutMs?: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
    return (await r.json()) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Status translation: Paperclip → pixel-agents ──────────────────────────

/**
 * pixel-agents `agentStatus.status` semantics (from useExtensionMessages.ts):
 *   'active'   → engine treats as idle/ready (clears the status overlay,
 *                setAgentActive(id, true) drives the working animation)
 *   'waiting'  → engine shows the waiting bubble + playDoneSound()
 *   anything   → engine stores as overlay string (custom label)
 *
 * Paperclip agent.status values (from packages/db/schema/agents.ts):
 *   'idle' | 'running' | 'paused' | 'error' (and similar)
 *
 * Mapping below errs on the side of "show the character lively" — silence
 * looks broken in a visual UI.
 */
function mapPaperclipStatus(paperclipStatus: string): string {
  switch (paperclipStatus) {
    case 'running':
      return 'active'; // working animation
    case 'paused':
      return 'waiting'; // shows waiting bubble
    case 'idle':
      return 'active'; // calm/idle; engine character still breathes
    case 'error':
      return 'error'; // custom overlay
    default:
      return 'active';
  }
}

// ── Main entry point ──────────────────────────────────────────────────────

export interface StartPaperclipApiOptions {
  baseUrl?: string;
  onStatusChange?: PaperclipStatusListener;
}

export interface PaperclipApiHandle {
  stop: () => void;
}

export async function startPaperclipApi(
  opts: StartPaperclipApiOptions = {},
): Promise<PaperclipApiHandle | null> {
  const baseUrl = opts.baseUrl ?? DEFAULT_PAPERCLIP_BASE;
  const setStatus = opts.onStatusChange ?? (() => {});

  // GoBoost: reuse the existing IdMapper if one is already populated so
  // numeric ids stay stable across React StrictMode double-invokes and
  // across WS reconnects. Fresh start only when there's nothing to keep.
  if (!moduleIdMapper) {
    moduleIdMapper = new IdMapper();
  }
  const idMapper = moduleIdMapper;

  // Publish to module-level singletons so chat panel + future task panel
  // helpers (fetchAgentIssues, postIssueComment, ...) can read them.
  moduleBaseUrl = baseUrl;

  // ── Step 1: probe Paperclip is alive ──
  setStatus({ state: 'connecting', message: 'בודק חיבור ל-Paperclip…' });
  let companies: PaperclipCompany[];
  try {
    companies = await fetchJson<PaperclipCompany[]>(
      `${baseUrl}/api/companies`,
      PAPERCLIP_PROBE_TIMEOUT_MS,
    );
  } catch (err) {
    console.warn('[PaperclipApi] Paperclip not reachable:', err);
    setStatus({
      state: 'no-paperclip',
      message: `Paperclip לא זמין ב-${baseUrl}. הפעל אותו עם pnpm dev.`,
    });
    return null;
  }

  // ── Step 2: pick a company (first one for MVP) ──
  if (companies.length === 0) {
    setStatus({
      state: 'no-company',
      message: 'אין companies. צור אחת ב-Paperclip ב-:3100 ורענן.',
    });
    return null;
  }
  const company = companies[0]!;
  moduleCompanyId = company.id;
  moduleCompanyName = company.name;
  console.log(`[PaperclipApi] Connected to company: ${company.name} (${company.id})`);

  // ── Step 3: load initial agents and seed the office ──
  let agents: PaperclipAgent[] = [];
  try {
    agents = await fetchJson<PaperclipAgent[]>(
      `${baseUrl}/api/companies/${company.id}/agents`,
    );
  } catch (err) {
    console.warn('[PaperclipApi] Failed to load initial agents:', err);
  }

  // GoBoost note: we previously used `existingAgents` for the bulk seed,
  // but pixel-agents' handler BUFFERS those events into a `pendingAgents`
  // list that's only drained inside `layoutLoaded`. browserMock dispatches
  // layoutLoaded BEFORE we fetch agents, so the buffer was always empty by
  // the time it drained — pre-existing agents never appeared.
  // `agentCreated` has no such buffering: it calls `os.addAgent` immediately.
  for (const a of agents) {
    const numericId = idMapper.toNumeric(a.id);
    agentNameByUuid.set(a.id, a.name);
    dispatch({
      type: 'agentCreated',
      id: numericId,
      folderName: a.name,
    });
    const mapped = mapPaperclipStatus(a.status);
    if (mapped !== 'active') {
      dispatch({ type: 'agentStatus', id: numericId, status: mapped });
    }
  }

  // ── Step 4: open the live WebSocket with auto-reconnect ──
  let ws: WebSocket | null = null;
  let reconnectDelay = RECONNECT_MIN_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function scheduleReconnect(): void {
    if (stopped) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      connect();
    }, reconnectDelay);
  }

  function connect(): void {
    if (stopped) return;
    const url = wsUrlFromBase(baseUrl, company.id);
    setStatus({
      state: 'connecting',
      companyName: company.name,
      message: `מתחבר ל-${company.name}…`,
    });
    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.error('[PaperclipApi] WS construct failed:', err);
      setStatus({
        state: 'disconnected',
        companyName: company.name,
        message: 'WebSocket לא נפתח — מנסה שוב…',
      });
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      console.log('[PaperclipApi] WS connected');
      reconnectDelay = RECONNECT_MIN_MS;
      setStatus({
        state: 'connected',
        companyName: company.name,
        message: `מחובר: ${company.name}`,
      });
    };

    ws.onmessage = (msg) => {
      try {
        const event = JSON.parse(String(msg.data)) as PaperclipLiveEvent;
        handleLiveEvent(event);
      } catch (err) {
        console.warn('[PaperclipApi] failed to parse message:', err);
      }
    };

    ws.onerror = (err) => {
      console.warn('[PaperclipApi] WS error:', err);
    };

    ws.onclose = (ev) => {
      console.log(`[PaperclipApi] WS closed (code=${ev.code}, reason=${ev.reason})`);
      ws = null;
      setStatus({
        state: 'disconnected',
        companyName: company.name,
        message: `WebSocket נסגר. מנסה שוב בעוד ${Math.round(reconnectDelay / 1000)}s…`,
      });
      scheduleReconnect();
    };
  }

  async function refetchAgentAndDispatchCreate(uuid: string): Promise<void> {
    try {
      const a = await fetchJson<PaperclipAgent>(`${baseUrl}/api/agents/${uuid}`);
      const numericId = idMapper.toNumeric(a.id);
      agentNameByUuid.set(a.id, a.name);
      dispatch({
        type: 'agentCreated',
        id: numericId,
        folderName: a.name,
      });
      const mapped = mapPaperclipStatus(a.status);
      if (mapped !== 'active') {
        dispatch({ type: 'agentStatus', id: numericId, status: mapped });
      }
    } catch (err) {
      console.warn(`[PaperclipApi] failed to fetch new agent ${uuid}:`, err);
    }
  }

  function handleLiveEvent(event: PaperclipLiveEvent): void {
    const payload = event.payload ?? {};

    switch (event.type) {
      // ── Agent lifecycle status ──
      case 'agent.status': {
        const uuid = String(payload.agentId ?? '');
        const paperclipStatus = String(payload.status ?? '');
        if (!uuid) return;
        const mapped = mapPaperclipStatus(paperclipStatus);
        dispatch({
          type: 'agentStatus',
          id: idMapper.toNumeric(uuid),
          status: mapped,
        });
        return;
      }

      // ── A run is queued / starting / finishing ──
      // We mirror to agentStatus so the character animates while work is happening.
      case 'heartbeat.run.queued':
      case 'heartbeat.run.status': {
        const uuid = String(payload.agentId ?? '');
        const runId = String(payload.runId ?? '');
        const runStatus = String(payload.status ?? 'running');
        if (!uuid) return;
        const numericId = idMapper.toNumeric(uuid);
        const terminal = ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(runStatus);
        dispatch({
          type: 'agentStatus',
          id: numericId,
          status: terminal ? 'active' : 'active', // both map to 'active' until we add finer overlay
        });
        // Fan out to the run-status subscription (used by the office's
        // speech-bubble bridge for "user just woke me up" / "I'm now
        // running" beats). For .queued events Paperclip doesn't send a
        // `status` field — synthesize 'queued' to mark the distinction.
        if (runId) {
          emitRunStatus({
            kind: event.type === 'heartbeat.run.queued' ? 'queued' : runStatus,
            agentId: uuid,
            runId,
            createdAt: event.createdAt,
          });
        }
        return;
      }

      // ── Activity log entries (agent created / deleted / comment added) ──
      case 'activity.logged': {
        // Fan-out to chat panel + future task panel subscribers first,
        // before we apply our own agent lifecycle interpretations.
        emitActivity(payload);

        const entityType = String(payload.entityType ?? '');
        const action = String(payload.action ?? '');
        const entityId = String(payload.entityId ?? '');
        if (entityType !== 'agent' || !entityId) return;
        // Paperclip's action vocabulary varies — match liberally
        if (/create|added|hired/i.test(action)) {
          void refetchAgentAndDispatchCreate(entityId);
        } else if (/delete|removed|terminated/i.test(action)) {
          const numericId = idMapper.forget(entityId);
          agentNameByUuid.delete(entityId);
          if (numericId !== undefined) {
            dispatch({ type: 'agentClosed', id: numericId });
          }
        }
        return;
      }

      // ── Heartbeat run event — system "inner voice" of the agent (2.B.2.C) ──
      // We fan out to subscribers; the chat panel's "כל הפעילות" view splices
      // these into the same scrollable timeline alongside issue_comments.
      case 'heartbeat.run.event': {
        emitHeartbeatEvent({
          agentId: String(payload.agentId ?? ''),
          runId: String(payload.runId ?? ''),
          seq: Number(payload.seq ?? 0),
          eventType: String(payload.eventType ?? ''),
          stream: (payload.stream as string | null) ?? null,
          level: (payload.level as string | null) ?? null,
          color: (payload.color as string | null) ?? null,
          message: (payload.message as string | null) ?? null,
          payload: (payload.payload as Record<string, unknown> | null) ?? null,
          createdAt: event.createdAt,
        });
        return;
      }

      // ── Intentionally ignored for v1 ──
      case 'heartbeat.run.log':
      case 'plugin.ui.updated':
      case 'plugin.worker.crashed':
      case 'plugin.worker.restarted':
        return;

      default:
        // Unknown event type — surface to console for triage
        console.debug('[PaperclipApi] unhandled event:', event.type);
        return;
    }
  }

  connect();

  return {
    stop: () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        try {
          ws.close(1000, 'client stop');
        } catch {
          // ignore
        }
      }
    },
  };
}
