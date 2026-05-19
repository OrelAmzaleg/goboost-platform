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
  title: string;
  description: string | null;
  status: string;
  priority?: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  identifier?: string | null;
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
        const runStatus = String(payload.status ?? 'running');
        if (!uuid) return;
        const numericId = idMapper.toNumeric(uuid);
        const terminal = ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(runStatus);
        dispatch({
          type: 'agentStatus',
          id: numericId,
          status: terminal ? 'active' : 'active', // both map to 'active' until we add finer overlay
        });
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
