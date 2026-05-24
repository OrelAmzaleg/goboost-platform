import { useEffect, useState } from 'react';

import {
  attachmentByteSize,
  attachmentContentUrl,
  attachmentFilename,
  attachmentMimeType,
  deleteAttachment,
  deleteIssueDocument,
  deleteWorkProduct,
  fetchDocumentRevisions,
  fetchIssueApprovals,
  fetchIssueAttachments,
  fetchIssueById,
  fetchIssueChildren,
  fetchIssueComments,
  fetchIssueDocuments,
  fetchIssueWorkProducts,
  getAgentName,
  subscribeActivity,
  uploadIssueAttachment,
  type PaperclipApproval,
  type PaperclipAttachment,
  type PaperclipComment,
  type PaperclipDocumentRevision,
  type PaperclipDocumentSummary,
  type PaperclipIssue,
  type PaperclipWorkProduct,
} from '../paperclipApi.js';
import {
  humanBytes,
  iconForMime,
  validateAttachmentSize,
} from './attachmentHelpers.js';
import { statusColor, statusLabel } from './issuePresentation.js';
import { MarkdownText } from './MarkdownText.js';

/**
 * GoBoost Tasks Panel (Iteration 2.B.2.D).
 *
 * Slides in from the right of the WhatsApp chat panel and shows the
 * structural view of the currently-active issue:
 *   - the issue itself (identifier, title, description, status, assignee)
 *   - its parent (if any) — a small breadcrumb-style chip at the top
 *   - its child issues (the "plan" — usually one per decomposed step)
 *   - success criteria placeholder (Paperclip has no native field today)
 *
 * Layer 4 from CLAUDE.md §4 (the four message-layer model from the
 * prototype). Stays read-only for v1 — editing the plan/criteria is a
 * later iteration. Closes via the X button or by toggling the same
 * "תוכנית" button in WhatsAppPanel.
 */

const TASKS_PANEL_WIDTH = 380;
const CHAT_PANEL_WIDTH = 420;
const COLLAPSED_CHAT_WIDTH = 44;

export interface TasksPanelProps {
  /** The issue currently shown in the chat panel. */
  issue: PaperclipIssue | null;
  /** Whether the panel is open (visible). */
  isOpen: boolean;
  /** Close handler. */
  onClose: () => void;
  /** Whether the chat panel is collapsed — used to calc anchor offset. */
  chatCollapsed: boolean;
  /** Pass-through `size(n)` from WhatsAppPanel so typography stays in sync. */
  size: (base: number) => number;
  /**
   * Jump the chat to another issue — used by clickable sub-issue rows in
   * the "תכנית · צעדים" section. WhatsAppPanel wires this to its
   * `onSelectNode` logic, which re-homes the office to the sub-issue's
   * owner agent when needed.
   */
  onNavigateToIssue?: (issue: PaperclipIssue) => void;
}

// `statusColor` / `statusLabel` now live in ./issuePresentation.ts.

function IssueRow({
  it,
  size,
  highlight = false,
  onClick,
}: {
  it: PaperclipIssue;
  size: (base: number) => number;
  highlight?: boolean;
  /**
   * When provided, the row becomes a clickable button — used by the
   * "תכנית · צעדים" section so the operator can jump the chat to a
   * sub-issue. The highlighted active-issue row passes no `onClick`
   * and stays a static panel.
   */
  onClick?: (it: PaperclipIssue) => void;
}) {
  const assigneeName = getAgentName(it.assigneeAgentId) ?? null;
  const clickable = !!onClick;
  return (
    <div
      onClick={clickable ? () => onClick!(it) : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick!(it);
              }
            }
          : undefined
      }
      title={clickable ? `פתח את ${it.identifier ?? ''} בצ'אט` : undefined}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '10px 12px',
        background: highlight ? 'rgba(99,102,241,0.18)' : 'rgba(255,255,255,0.04)',
        border: highlight
          ? '1px solid rgba(129,140,248,0.5)'
          : '1px solid rgba(255,255,255,0.06)',
        borderRadius: 8,
        cursor: clickable ? 'pointer' : 'default',
        transition: 'background 0.12s',
      }}
      onMouseEnter={
        clickable
          ? (e) => {
              (e.currentTarget as HTMLDivElement).style.background =
                'rgba(255,255,255,0.09)';
            }
          : undefined
      }
      onMouseLeave={
        clickable
          ? (e) => {
              (e.currentTarget as HTMLDivElement).style.background =
                'rgba(255,255,255,0.04)';
            }
          : undefined
      }
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: statusColor(it.status),
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: size(11),
            fontWeight: 700,
            background: 'rgba(0,0,0,0.25)',
            padding: '2px 6px',
            borderRadius: 4,
            letterSpacing: 0.4,
          }}
        >
          {it.identifier ?? '—'}
        </span>
        <span
          style={{
            fontSize: size(10),
            opacity: 0.7,
            padding: '1px 5px',
            background: 'rgba(255,255,255,0.06)',
            borderRadius: 3,
          }}
        >
          {statusLabel(it.status)}
        </span>
        {assigneeName ? (
          <span
            style={{
              fontSize: size(10),
              opacity: 0.7,
              marginInlineStart: 'auto',
              maxWidth: 120,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={`מוקצה ל-${assigneeName}`}
          >
            👤 {assigneeName}
          </span>
        ) : null}
      </div>
      <div
        style={{
          fontSize: size(13),
          lineHeight: 1.5,
          color: '#e2e8f0',
        }}
      >
        {it.title}
      </div>
    </div>
  );
}

export function TasksPanel({
  issue,
  isOpen,
  onClose,
  chatCollapsed,
  size,
  onNavigateToIssue,
}: TasksPanelProps) {
  const [parent, setParent] = useState<PaperclipIssue | null>(null);
  const [children, setChildren] = useState<PaperclipIssue[]>([]);
  const [loadingChildren, setLoadingChildren] = useState(false);

  // 2.B.8 additions — documents, work products, approvals.
  const [documents, setDocuments] = useState<PaperclipDocumentSummary[]>([]);
  const [workProducts, setWorkProducts] = useState<PaperclipWorkProduct[]>([]);
  const [approvals, setApprovals] = useState<PaperclipApproval[]>([]);
  // Attachments are surfaced alongside work products under "תוצרים להורדה".
  // In practice agents drop generated files (PPT/PDF/DOCX/MD) as
  // `issue_attachments` via the attachment-upload tool — they only become
  // `issue_work_products` when an external provider URL is attached. The
  // operator doesn't care about the distinction; both are "downloadables".
  const [attachments, setAttachments] = useState<PaperclipAttachment[]>([]);
  // Comments are also fetched here (separately from the chat panel) so
  // we can time-correlate attachments with heartbeat-emitted agent
  // comments. The reliable origin signal (`createdByAgentId`) is broken
  // in local_trusted mode because no JWT is injected for the agent's
  // API calls — every upload gets attributed to `local-board`. We work
  // around it by treating an attachment as agent-produced if it landed
  // within ±AGENT_UPLOAD_WINDOW_MS of any comment with `createdByRunId`.
  const [comments, setComments] = useState<PaperclipComment[]>([]);
  const [loadingSideStreams, setLoadingSideStreams] = useState(false);

  // Documents with their loaded latest revision body (lazy — only the
  // currently-expanded document fetches its revisions for the inline preview).
  const [docRevisions, setDocRevisions] = useState<
    Record<string, PaperclipDocumentRevision[]>
  >({});
  const [expandedDocKey, setExpandedDocKey] = useState<string | null>(null);

  const toggleDoc = async (doc: PaperclipDocumentSummary) => {
    if (!issue) return;
    if (expandedDocKey === doc.key) {
      setExpandedDocKey(null);
      return;
    }
    setExpandedDocKey(doc.key);
    if (!docRevisions[doc.key]) {
      const revs = await fetchDocumentRevisions(issue.id, doc.key);
      setDocRevisions((prev) => ({ ...prev, [doc.key]: revs }));
    }
  };

  // Modal-state for the "eye" viewer — shows the document body in a
  // larger reader-friendly overlay. When `viewerDoc` is set, the modal
  // is open; clicking the backdrop or close button clears it.
  const [viewerDoc, setViewerDoc] = useState<{
    key: string;
    title: string;
    body: string;
    format: string;
  } | null>(null);

  const openViewer = async (doc: PaperclipDocumentSummary) => {
    if (!issue) return;
    let revs = docRevisions[doc.key];
    if (!revs) {
      revs = await fetchDocumentRevisions(issue.id, doc.key);
      setDocRevisions((prev) => ({ ...prev, [doc.key]: revs! }));
    }
    const latest = revs[0] ?? doc.latestRevision ?? null;
    if (!latest) return;
    setViewerDoc({
      key: doc.key,
      title: doc.key,
      body: latest.body,
      format: latest.format ?? 'markdown',
    });
  };

  // Download a document's latest revision as a local file. Plain text
  // blob — Paperclip serves the body inline rather than as an attachment,
  // so we construct the file on the client side.
  const downloadDoc = async (doc: PaperclipDocumentSummary) => {
    if (!issue) return;
    let revs = docRevisions[doc.key];
    if (!revs) {
      revs = await fetchDocumentRevisions(issue.id, doc.key);
      setDocRevisions((prev) => ({ ...prev, [doc.key]: revs! }));
    }
    const latest = revs[0] ?? doc.latestRevision ?? null;
    if (!latest) return;
    const ext = latest.format === 'markdown' ? 'md' : 'txt';
    const blob = new Blob([latest.body], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${doc.key}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // Remove a document. Confirmation is required because the backend
  // cascades the revision history. Local state is updated optimistically;
  // a failure restores via refetch.
  const [removingDocKey, setRemovingDocKey] = useState<string | null>(null);
  const removeDoc = async (doc: PaperclipDocumentSummary) => {
    if (!issue) return;
    if (!window.confirm(`להסיר את המסמך "${doc.key}"?`)) return;
    setRemovingDocKey(doc.key);
    const ok = await deleteIssueDocument(issue.id, doc.key);
    setRemovingDocKey(null);
    if (ok) {
      setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
      if (expandedDocKey === doc.key) setExpandedDocKey(null);
    } else {
      void fetchIssueDocuments(issue.id).then(setDocuments);
    }
  };

  // Remove a work product. Same pattern as documents.
  const [removingWpId, setRemovingWpId] = useState<string | null>(null);
  const removeWorkProduct = async (wp: PaperclipWorkProduct) => {
    if (!window.confirm(`להסיר את התוצר "${wp.title}"?`)) return;
    setRemovingWpId(wp.id);
    const ok = await deleteWorkProduct(wp.id);
    setRemovingWpId(null);
    if (ok) {
      setWorkProducts((prev) => prev.filter((p) => p.id !== wp.id));
    } else if (issue) {
      void fetchIssueWorkProducts(issue.id).then(setWorkProducts);
    }
  };

  // Remove an attachment (downloadable file like PPT/PDF/DOCX that the
  // agent emitted). Same pattern as work products.
  // Direct attachment upload from the "מסמכים מצורפים" section. Unlike
  // the chat composer, this does NOT post a comment — it just adds the
  // file to the issue's knowledge base. No comment means no heartbeat
  // wake, so the operator can stock reference docs without nudging the
  // agent. Paperclip exposes the same `/attachments` endpoint; we just
  // omit `issueCommentId`.
  const [uploadingUserAtt, setUploadingUserAtt] = useState(false);
  const [userAttError, setUserAttError] = useState<string | null>(null);
  // Attachment ids that THIS panel uploaded as user reference docs.
  // The agent/user split heuristic (`looksAgentEmitted`) time-correlates
  // against heartbeat comments and could mis-bucket a doc uploaded while
  // the agent happens to be running. Tracking explicit user uploads
  // overrides that heuristic for the current session.
  const [userUploadedIds, setUserUploadedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const onAddUserAttachments = async (
    files: FileList | File[] | null | undefined,
  ) => {
    if (!issue || !files) return;
    const arr = Array.from(files);
    if (arr.length === 0) return;
    // Reject the whole batch if any file fails the size cap — keeps
    // the interaction simple (no partial-staging UI in this panel).
    const oversize = arr.find((f) => !validateAttachmentSize(f).ok);
    if (oversize) {
      setUserAttError(
        validateAttachmentSize(oversize).error ?? 'קובץ גדול מדי',
      );
      return;
    }
    setUploadingUserAtt(true);
    setUserAttError(null);
    const results = await Promise.all(
      arr.map((f) => uploadIssueAttachment(issue.id, f)),
    );
    setUploadingUserAtt(false);
    const succeeded = results.filter(
      (a): a is PaperclipAttachment => a != null,
    );
    if (succeeded.length > 0) {
      setAttachments((prev) => [...prev, ...succeeded]);
      setUserUploadedIds((prev) => {
        const next = new Set(prev);
        for (const a of succeeded) next.add(a.id);
        return next;
      });
    }
    if (succeeded.length < arr.length) {
      setUserAttError(
        `${arr.length - succeeded.length} מתוך ${arr.length} קבצים נכשלו בהעלאה.`,
      );
    }
  };

  const [removingAttId, setRemovingAttId] = useState<string | null>(null);
  const removeAttachment = async (att: PaperclipAttachment) => {
    const name = att.asset?.filename ?? att.filename ?? 'הקובץ';
    if (!window.confirm(`להסיר את "${name}"?`)) return;
    setRemovingAttId(att.id);
    const ok = await deleteAttachment(att.id);
    setRemovingAttId(null);
    if (ok) {
      setAttachments((prev) => prev.filter((a) => a.id !== att.id));
    } else if (issue) {
      void fetchIssueAttachments(issue.id).then(setAttachments);
    }
  };

  // Split attachments by author. Two signals are used, in order:
  //   1. `createdByAgentId !== null` — reliable when present. Today it's
  //      almost always null because Paperclip's local_trusted mode
  //      doesn't inject a JWT for agent API calls, so uploads get
  //      attributed to the `local-board` user. When/if that bug is
  //      fixed upstream this becomes the primary path.
  //   2. Time-correlation fallback — if the attachment landed within
  //      ±AGENT_UPLOAD_WINDOW_MS of any heartbeat-emitted comment, treat
  //      it as agent-produced. Heartbeat-emitted = comment.createdByRunId
  //      is set, which is reliably populated regardless of JWT.
  // Anything left over is treated as user-uploaded reference material.
  const AGENT_UPLOAD_WINDOW_MS = 120_000; // 2 minutes
  const agentRunCommentTimestamps = comments
    .filter((c) => c.createdByRunId != null)
    .map((c) => new Date(c.createdAt).getTime())
    .filter((t) => Number.isFinite(t));

  function looksAgentEmitted(att: PaperclipAttachment): boolean {
    // Explicit user uploads from this panel always count as user docs,
    // regardless of what the time-correlation heuristic would say.
    if (userUploadedIds.has(att.id)) return false;
    if (att.createdByAgentId) return true;
    const t = new Date(att.createdAt).getTime();
    if (!Number.isFinite(t)) return false;
    return agentRunCommentTimestamps.some(
      (ct) => Math.abs(ct - t) <= AGENT_UPLOAD_WINDOW_MS,
    );
  }

  const agentAttachments = attachments.filter(looksAgentEmitted);
  const userAttachments = attachments.filter(
    (a) => !looksAgentEmitted(a),
  );

  // `humanBytes` and `iconForMime` now live in ./attachmentHelpers.ts so
  // the upload form, chips, and Tasks Panel all share one vocabulary.

  // Live refresh — when activity fires for our streams, refetch.
  // Same logic as WhatsAppPanel's activity handler: approvals fire
  // against entityType="approval" (not "issue"), so we refresh on any
  // `approval.*` action whose linkedIssueIds includes our issue.
  // Attachments / documents / work_products fire against the issue, so
  // a simple action regex is enough.
  useEffect(() => {
    if (!isOpen || !issue) return;
    const unsubscribe = subscribeActivity((payload) => {
      const action = String(payload.action ?? '');
      const entityType = String(payload.entityType ?? '');
      const entityId = String(payload.entityId ?? '');
      const issueIdInPayload = String(payload.issueId ?? '');
      const matchesIssue =
        (entityType === 'issue' && entityId === issue.id) ||
        issueIdInPayload === issue.id;

      if (action.startsWith('approval.')) {
        const details = (payload.details ?? {}) as { linkedIssueIds?: unknown };
        const linkedIds = Array.isArray(details.linkedIssueIds)
          ? (details.linkedIssueIds as unknown[])
          : [];
        if (linkedIds.includes(issue.id) || linkedIds.length === 0) {
          void fetchIssueApprovals(issue.id).then(setApprovals);
        }
        return;
      }
      if (!matchesIssue) return;
      if (/attachment/i.test(action)) {
        void fetchIssueAttachments(issue.id).then(setAttachments);
      }
      // Comment activity → refetch so the agent/user split (which uses
      // heartbeat-emitted comments as a time anchor) stays accurate.
      if (/comment|reply|message/i.test(action)) {
        void fetchIssueComments(issue.id).then(setComments);
      }
      if (/document/i.test(action)) {
        void fetchIssueDocuments(issue.id).then(setDocuments);
        // Drop cached revisions for any doc; the body may have changed.
        setDocRevisions({});
      }
      if (/work_product/i.test(action)) {
        void fetchIssueWorkProducts(issue.id).then(setWorkProducts);
      }
      if (/approval_linked|approval_unlinked/i.test(action)) {
        void fetchIssueApprovals(issue.id).then(setApprovals);
      }
    });
    return unsubscribe;
  }, [issue, isOpen]);

  // Load parent + children + side streams whenever the active issue changes.
  useEffect(() => {
    if (!isOpen || !issue) {
      setParent(null);
      setChildren([]);
      setDocuments([]);
      setWorkProducts([]);
      setApprovals([]);
      setAttachments([]);
      setComments([]);
      setDocRevisions({});
      setExpandedDocKey(null);
      return;
    }
    let cancelled = false;
    setLoadingChildren(true);
    setLoadingSideStreams(true);
    (async () => {
      const [p, kids, docs, wps, apps, atts, cmts] = await Promise.all([
        issue.parentId ? fetchIssueById(issue.parentId) : Promise.resolve(null),
        fetchIssueChildren(issue.id),
        fetchIssueDocuments(issue.id),
        fetchIssueWorkProducts(issue.id),
        fetchIssueApprovals(issue.id),
        fetchIssueAttachments(issue.id),
        fetchIssueComments(issue.id),
      ]);
      if (cancelled) return;
      setParent(p);
      setChildren(kids);
      setDocuments(docs);
      setWorkProducts(wps);
      setApprovals(apps);
      setAttachments(atts);
      setComments(cmts);
      setLoadingChildren(false);
      setLoadingSideStreams(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [issue, isOpen]);

  if (!isOpen) return null;

  // Anchor: when chat is open we sit immediately to the left of it (in RTL,
  // that's `right: CHAT_PANEL_WIDTH`). When chat is collapsed we sit next
  // to the slim strip instead.
  const anchorRight = chatCollapsed ? COLLAPSED_CHAT_WIDTH : CHAT_PANEL_WIDTH;

  return (
    <aside
      dir="rtl"
      className="gb-chat-panel-scope"
      style={
        {
          position: 'fixed',
          // 38 connection banner + 38 bookmarks bar.
          top: 76,
          right: anchorRight,
          bottom: 0,
          width: TASKS_PANEL_WIDTH,
          background: 'rgba(15, 23, 42, 0.96)',
          backdropFilter: 'blur(8px)',
          borderInlineStart: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          flexDirection: 'column',
          color: '#e2e8f0',
          fontSize: size(14),
          zIndex: 99, // just below the chat panel (z=100) so chat picker overflows on top
          boxShadow: '-2px 0 12px rgba(0,0,0,0.35)',
          ['--gb-chat-font' as string]: "'Heebo', system-ui, -apple-system, sans-serif",
        } as React.CSSProperties
      }
    >
      {/* Header */}
      <header
        style={{
          padding: '14px 16px',
          background: 'linear-gradient(90deg, #0f766e 0%, #0ea5e9 100%)',
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <span style={{ fontSize: size(18) }}>📋</span>
        <div style={{ fontWeight: 700, fontSize: size(16), flex: 1 }}>
          תוכנית הביצוע
        </div>
        <button
          type="button"
          title="סגור"
          aria-label="סגור"
          onClick={onClose}
          style={{
            width: 28,
            height: 28,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(255,255,255,0.12)',
            color: '#fff',
            border: 'none',
            borderRadius: 7,
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 16,
            fontWeight: 700,
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      </header>

      {/* Body */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {!issue ? (
          <div
            style={{
              textAlign: 'center',
              color: '#94a3b8',
              fontSize: size(13),
              marginTop: 32,
              lineHeight: 1.6,
            }}
          >
            אין issue פעיל בשיחה
            <br />
            <span style={{ fontSize: size(11), opacity: 0.7 }}>
              סגור את הפאנל ובחר issue ב-session navigator.
            </span>
          </div>
        ) : (
          <>
            {/* Parent breadcrumb */}
            {parent ? (
              <div
                style={{
                  fontSize: size(11),
                  opacity: 0.75,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
                title={parent.title}
              >
                <span>נמצא תחת:</span>
                <span
                  style={{
                    fontWeight: 700,
                    background: 'rgba(255,255,255,0.08)',
                    padding: '1px 5px',
                    borderRadius: 3,
                  }}
                >
                  {parent.identifier ?? '—'}
                </span>
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: 220,
                  }}
                >
                  {parent.title}
                </span>
              </div>
            ) : null}

            {/* This issue */}
            <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div
                style={{
                  fontSize: size(11),
                  opacity: 0.7,
                  fontWeight: 600,
                  letterSpacing: 0.5,
                }}
              >
                ה-ISSUE הפעיל
              </div>
              <IssueRow it={issue} size={size} highlight />
              {issue.description ? (
                <div
                  style={{
                    padding: '10px 12px',
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    borderRadius: 8,
                    fontSize: size(13),
                    lineHeight: 1.55,
                    color: '#cbd5e1',
                    whiteSpace: 'pre-wrap',
                    maxHeight: 200,
                    overflowY: 'auto',
                  }}
                >
                  {issue.description}
                </div>
              ) : null}
            </section>

            {/* Plan / Steps (child issues) */}
            <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div
                style={{
                  fontSize: size(11),
                  opacity: 0.7,
                  fontWeight: 600,
                  letterSpacing: 0.5,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span>תוכנית · צעדים</span>
                {children.length > 0 ? (
                  <span
                    style={{
                      fontSize: size(10),
                      background: 'rgba(255,255,255,0.08)',
                      padding: '1px 6px',
                      borderRadius: 10,
                      fontWeight: 700,
                    }}
                  >
                    {children.length}
                  </span>
                ) : null}
              </div>
              {loadingChildren ? (
                <div style={{ fontSize: size(12), opacity: 0.6 }}>טוען…</div>
              ) : children.length === 0 ? (
                <div
                  style={{
                    fontSize: size(12),
                    opacity: 0.6,
                    fontStyle: 'italic',
                    padding: '8px 12px',
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px dashed rgba(255,255,255,0.08)',
                    borderRadius: 8,
                  }}
                >
                  אין child issues. ה-issue הזה לא פורק לצעדים, או שמדובר ב-step עלה
                  בעצמו.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <CollapsibleList size={size}>
                    {children.map((c) => (
                      <IssueRow
                        key={c.id}
                        it={c}
                        size={size}
                        onClick={onNavigateToIssue}
                      />
                    ))}
                  </CollapsibleList>
                </div>
              )}
            </section>

            {/* ── 2.B.8: Documents ───────────────────────────────────────
                Markdown/spec artifacts pinned to the issue. Each has a
                `key` (e.g. "plan", "spec") and a revision history. Clicking
                the row loads the revisions and shows the latest body. */}
            <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div
                style={{
                  fontSize: size(11),
                  opacity: 0.7,
                  fontWeight: 600,
                  letterSpacing: 0.5,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span>📝 מסמכים</span>
                {documents.length > 0 ? (
                  <span
                    style={{
                      fontSize: size(10),
                      background: 'rgba(255,255,255,0.08)',
                      padding: '1px 6px',
                      borderRadius: 10,
                      fontWeight: 700,
                    }}
                  >
                    {documents.length}
                  </span>
                ) : null}
              </div>
              {loadingSideStreams ? (
                <div style={{ fontSize: size(12), opacity: 0.6 }}>טוען…</div>
              ) : documents.length === 0 ? (
                <div
                  style={{
                    fontSize: size(12),
                    opacity: 0.55,
                    fontStyle: 'italic',
                    padding: '6px 10px',
                    border: '1px dashed rgba(255,255,255,0.08)',
                    borderRadius: 8,
                  }}
                >
                  אין מסמכים מקושרים.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <CollapsibleList size={size}>
                  {documents.map((doc) => {
                    const expanded = expandedDocKey === doc.key;
                    const revs = docRevisions[doc.key] ?? [];
                    const latest = revs[0] ?? doc.latestRevision ?? null;
                    return (
                      <div
                        key={doc.id}
                        style={{
                          background: 'rgba(255,255,255,0.04)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          borderRadius: 8,
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            width: '100%',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '8px 10px',
                            color: '#e2e8f0',
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => void toggleDoc(doc)}
                            title={expanded ? 'הסתר תוכן' : 'הצג תוכן'}
                            style={{
                              flex: 1,
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              padding: 0,
                              background: 'transparent',
                              border: 'none',
                              color: 'inherit',
                              fontFamily: 'inherit',
                              cursor: 'pointer',
                              textAlign: 'start',
                              minWidth: 0,
                            }}
                          >
                            <span aria-hidden style={{ fontSize: size(13) }}>📄</span>
                            <span
                              style={{
                                fontWeight: 700,
                                fontSize: size(12),
                                background: 'rgba(0,0,0,0.25)',
                                padding: '1px 6px',
                                borderRadius: 4,
                                letterSpacing: 0.3,
                                flexShrink: 0,
                              }}
                            >
                              {doc.key}
                            </span>
                            {latest ? (
                              <span style={{ fontSize: size(10), opacity: 0.65 }}>
                                v{latest.revisionNumber}
                                {latest.format ? ` · ${latest.format}` : ''}
                              </span>
                            ) : null}
                            <span
                              style={{
                                marginInlineStart: 'auto',
                                fontSize: size(10),
                                opacity: 0.55,
                                flexShrink: 0,
                              }}
                            >
                              {expanded ? '▲' : '▼'}
                            </span>
                          </button>
                          {/* Action icons: view (modal), download, remove. */}
                          <DocIconButton
                            title="פתח קריאה נוחה"
                            onClick={() => void openViewer(doc)}
                            size={size}
                          >
                            👁
                          </DocIconButton>
                          <DocIconButton
                            title="הורד MD"
                            onClick={() => void downloadDoc(doc)}
                            size={size}
                          >
                            ⬇
                          </DocIconButton>
                          <DocIconButton
                            title="הסר מסמך"
                            onClick={() => void removeDoc(doc)}
                            disabled={removingDocKey === doc.key}
                            tone="danger"
                            size={size}
                          >
                            {removingDocKey === doc.key ? '…' : '✕'}
                          </DocIconButton>
                        </div>
                        {expanded && latest ? (
                          <div
                            style={{
                              padding: '8px 12px',
                              borderBlockStart: '1px solid rgba(255,255,255,0.06)',
                              background: 'rgba(0,0,0,0.18)',
                              fontSize: size(12),
                              lineHeight: 1.55,
                              color: '#cbd5e1',
                              wordBreak: 'break-word',
                              maxHeight: 220,
                              overflowY: 'auto',
                              fontFamily:
                                latest.format === 'markdown'
                                  ? 'inherit'
                                  : 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                            }}
                          >
                            {latest.format === 'markdown' ? (
                              <MarkdownText
                                text={latest.body}
                                emphasisColor="#f1f5f9"
                              />
                            ) : (
                              <pre
                                style={{
                                  margin: 0,
                                  whiteSpace: 'pre-wrap',
                                  fontFamily: 'inherit',
                                }}
                              >
                                {latest.body}
                              </pre>
                            )}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                  </CollapsibleList>
                </div>
              )}
            </section>

            {/* ── 2.B.8: Work products ──────────────────────────────────
                Downloadable agent outputs (spreadsheets, PDFs, generated
                docs). Each has a public URL via `work_product.url`. */}
            <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div
                style={{
                  fontSize: size(11),
                  opacity: 0.7,
                  fontWeight: 600,
                  letterSpacing: 0.5,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span>📦 תוצרים להורדה (הסוכן)</span>
                {workProducts.length + agentAttachments.length > 0 ? (
                  <span
                    style={{
                      fontSize: size(10),
                      background: 'rgba(255,255,255,0.08)',
                      padding: '1px 6px',
                      borderRadius: 10,
                      fontWeight: 700,
                    }}
                  >
                    {workProducts.length + agentAttachments.length}
                  </span>
                ) : null}
              </div>
              {loadingSideStreams ? (
                <div style={{ fontSize: size(12), opacity: 0.6 }}>טוען…</div>
              ) : workProducts.length === 0 && agentAttachments.length === 0 ? (
                <div
                  style={{
                    fontSize: size(12),
                    opacity: 0.55,
                    fontStyle: 'italic',
                    padding: '6px 10px',
                    border: '1px dashed rgba(255,255,255,0.08)',
                    borderRadius: 8,
                  }}
                >
                  הסוכן לא ייצר תוצרים להורדה עדיין.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <CollapsibleList size={size}>
                  {/* Attachments emitted by the agent during a run. */}
                  {agentAttachments.map((att) => {
                    const filename = attachmentFilename(att);
                    const mime = attachmentMimeType(att);
                    const bytes = attachmentByteSize(att);
                    const url = attachmentContentUrl(att.id);
                    return (
                      <div
                        key={`att:${att.id}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '8px 10px',
                          background: 'rgba(255,255,255,0.04)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          borderRadius: 8,
                        }}
                      >
                        <span
                          aria-hidden
                          style={{ fontSize: size(15), flexShrink: 0 }}
                        >
                          {iconForMime(mime)}
                        </span>
                        <div
                          style={{
                            flex: 1,
                            minWidth: 0,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 2,
                          }}
                        >
                          <div
                            style={{
                              fontWeight: 700,
                              fontSize: size(13),
                              color: '#f1f5f9',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                            title={filename}
                          >
                            {filename}
                          </div>
                          <div
                            style={{
                              fontSize: size(10),
                              opacity: 0.65,
                              display: 'flex',
                              gap: 6,
                            }}
                          >
                            {mime ? <span>{mime}</span> : null}
                            {humanBytes(bytes) ? (
                              <span>· {humanBytes(bytes)}</span>
                            ) : null}
                          </div>
                        </div>
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          download={filename}
                          style={{
                            padding: '4px 10px',
                            background: 'rgba(99,102,241,0.3)',
                            border: '1px solid rgba(129,140,248,0.6)',
                            borderRadius: 6,
                            color: '#e0e7ff',
                            textDecoration: 'none',
                            fontSize: size(11),
                            fontWeight: 700,
                            flexShrink: 0,
                          }}
                        >
                          הורד
                        </a>
                        <DocIconButton
                          title="הסר קובץ"
                          onClick={() => void removeAttachment(att)}
                          disabled={removingAttId === att.id}
                          tone="danger"
                          size={size}
                        >
                          {removingAttId === att.id ? '…' : '✕'}
                        </DocIconButton>
                      </div>
                    );
                  })}
                  {workProducts.map((wp) => (
                    <div
                      key={wp.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '8px 10px',
                        background: 'rgba(255,255,255,0.04)',
                        border: wp.isPrimary
                          ? '1px solid rgba(129,140,248,0.5)'
                          : '1px solid rgba(255,255,255,0.08)',
                        borderRadius: 8,
                      }}
                    >
                      <span aria-hidden style={{ fontSize: size(15), flexShrink: 0 }}>
                        {wp.type === 'spreadsheet'
                          ? '📊'
                          : wp.type === 'pdf'
                            ? '📕'
                            : wp.type === 'doc'
                              ? '📘'
                              : '📦'}
                      </span>
                      <div
                        style={{
                          flex: 1,
                          minWidth: 0,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 2,
                        }}
                      >
                        <div
                          style={{
                            fontWeight: 700,
                            fontSize: size(13),
                            color: '#f1f5f9',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={wp.title}
                        >
                          {wp.title}
                        </div>
                        <div
                          style={{
                            fontSize: size(10),
                            opacity: 0.65,
                            display: 'flex',
                            gap: 6,
                          }}
                        >
                          <span>{wp.type}</span>
                          {wp.provider ? <span>· {wp.provider}</span> : null}
                          {wp.status ? <span>· {wp.status}</span> : null}
                        </div>
                      </div>
                      {wp.url ? (
                        <a
                          href={wp.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            padding: '4px 10px',
                            background: 'rgba(99,102,241,0.3)',
                            border: '1px solid rgba(129,140,248,0.6)',
                            borderRadius: 6,
                            color: '#e0e7ff',
                            textDecoration: 'none',
                            fontSize: size(11),
                            fontWeight: 700,
                            flexShrink: 0,
                          }}
                        >
                          פתח
                        </a>
                      ) : null}
                      <DocIconButton
                        title="הסר תוצר"
                        onClick={() => void removeWorkProduct(wp)}
                        disabled={removingWpId === wp.id}
                        tone="danger"
                        size={size}
                      >
                        {removingWpId === wp.id ? '…' : '✕'}
                      </DocIconButton>
                    </div>
                  ))}
                  </CollapsibleList>
                </div>
              )}
            </section>

            {/* ── User-uploaded reference files ─────────────────────────
                Files the operator attached via the chat composer or
                Paperclip dashboard — distinct from agent-produced
                downloadables above. Provides shared context (briefs,
                spec PDFs, screenshots) the agent can read from. */}
            <section
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
              }}
              onDrop={(e) => {
                e.preventDefault();
                void onAddUserAttachments(e.dataTransfer.files);
              }}
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              <div
                style={{
                  fontSize: size(11),
                  opacity: 0.7,
                  fontWeight: 600,
                  letterSpacing: 0.5,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span>📎 מסמכים מצורפים (אני)</span>
                {userAttachments.length > 0 ? (
                  <span
                    style={{
                      fontSize: size(10),
                      background: 'rgba(255,255,255,0.08)',
                      padding: '1px 6px',
                      borderRadius: 10,
                      fontWeight: 700,
                    }}
                  >
                    {userAttachments.length}
                  </span>
                ) : null}
                {/* Direct upload — adds to the issue knowledge base
                    without posting a comment (no heartbeat wake). */}
                <label
                  title="צרף מסמך — מתווסף ל-Issue ללא שליחת הודעה"
                  style={{
                    marginInlineStart: 'auto',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '2px 8px',
                    background: 'rgba(99,102,241,0.22)',
                    border: '1px solid rgba(129,140,248,0.45)',
                    borderRadius: 7,
                    color: '#e0e7ff',
                    cursor: uploadingUserAtt ? 'not-allowed' : 'pointer',
                    opacity: uploadingUserAtt ? 0.6 : 1,
                    fontSize: size(10),
                    fontWeight: 700,
                  }}
                >
                  <span aria-hidden style={{ fontSize: size(11) }}>＋</span>
                  <span>{uploadingUserAtt ? 'מעלה…' : 'צרף מסמך'}</span>
                  <input
                    type="file"
                    multiple
                    hidden
                    disabled={uploadingUserAtt}
                    onChange={(e) => {
                      void onAddUserAttachments(e.target.files);
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
              {userAttError ? (
                <div
                  style={{
                    fontSize: size(11),
                    color: '#fecaca',
                    background: 'rgba(127,29,29,0.4)',
                    padding: '4px 8px',
                    borderRadius: 6,
                  }}
                >
                  {userAttError}
                </div>
              ) : null}
              {loadingSideStreams ? (
                <div style={{ fontSize: size(12), opacity: 0.6 }}>טוען…</div>
              ) : userAttachments.length === 0 ? (
                <div
                  style={{
                    fontSize: size(12),
                    opacity: 0.55,
                    fontStyle: 'italic',
                    padding: '6px 10px',
                    border: '1px dashed rgba(255,255,255,0.08)',
                    borderRadius: 8,
                  }}
                >
                  לא צורפו מסמכי הקשר עדיין. לחץ "צרף מסמך" או גרור קבצים לכאן.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <CollapsibleList size={size}>
                  {userAttachments.map((att) => {
                    const filename = attachmentFilename(att);
                    const mime = attachmentMimeType(att);
                    const bytes = attachmentByteSize(att);
                    const url = attachmentContentUrl(att.id);
                    return (
                      <div
                        key={`uatt:${att.id}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '8px 10px',
                          background: 'rgba(255,255,255,0.04)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          borderRadius: 8,
                        }}
                      >
                        <span
                          aria-hidden
                          style={{ fontSize: size(15), flexShrink: 0 }}
                        >
                          {iconForMime(mime)}
                        </span>
                        <div
                          style={{
                            flex: 1,
                            minWidth: 0,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 2,
                          }}
                        >
                          <div
                            style={{
                              fontWeight: 700,
                              fontSize: size(13),
                              color: '#f1f5f9',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                            title={filename}
                          >
                            {filename}
                          </div>
                          <div
                            style={{
                              fontSize: size(10),
                              opacity: 0.65,
                              display: 'flex',
                              gap: 6,
                            }}
                          >
                            {mime ? <span>{mime}</span> : null}
                            {humanBytes(bytes) ? (
                              <span>· {humanBytes(bytes)}</span>
                            ) : null}
                          </div>
                        </div>
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          download={filename}
                          style={{
                            padding: '4px 10px',
                            background: 'rgba(99,102,241,0.3)',
                            border: '1px solid rgba(129,140,248,0.6)',
                            borderRadius: 6,
                            color: '#e0e7ff',
                            textDecoration: 'none',
                            fontSize: size(11),
                            fontWeight: 700,
                            flexShrink: 0,
                          }}
                        >
                          הורד
                        </a>
                        <DocIconButton
                          title="הסר קובץ"
                          onClick={() => void removeAttachment(att)}
                          disabled={removingAttId === att.id}
                          tone="danger"
                          size={size}
                        >
                          {removingAttId === att.id ? '…' : '✕'}
                        </DocIconButton>
                      </div>
                    );
                  })}
                  </CollapsibleList>
                </div>
              )}
            </section>

            {/* ── 2.B.8: Approvals ──────────────────────────────────────
                Approval gates linked to the issue. Status enum: pending |
                approved | rejected. Listed read-only here — actual
                accept/reject UI lives in Paperclip's classic dashboard. */}
            <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div
                style={{
                  fontSize: size(11),
                  opacity: 0.7,
                  fontWeight: 600,
                  letterSpacing: 0.5,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span>✋ אישורים</span>
                {approvals.length > 0 ? (
                  <span
                    style={{
                      fontSize: size(10),
                      background: 'rgba(255,255,255,0.08)',
                      padding: '1px 6px',
                      borderRadius: 10,
                      fontWeight: 700,
                    }}
                  >
                    {approvals.length}
                  </span>
                ) : null}
              </div>
              {loadingSideStreams ? (
                <div style={{ fontSize: size(12), opacity: 0.6 }}>טוען…</div>
              ) : approvals.length === 0 ? (
                <div
                  style={{
                    fontSize: size(12),
                    opacity: 0.55,
                    fontStyle: 'italic',
                    padding: '6px 10px',
                    border: '1px dashed rgba(255,255,255,0.08)',
                    borderRadius: 8,
                  }}
                >
                  אין אישורים בתהליך.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <CollapsibleList size={size}>
                  {approvals.map((a) => {
                    const tone =
                      a.status === 'approved'
                        ? { bg: 'rgba(34,197,94,0.18)', border: '#4ade80', label: 'אושר' }
                        : a.status === 'rejected'
                          ? { bg: 'rgba(220,38,38,0.18)', border: '#f87171', label: 'נדחה' }
                          : { bg: 'rgba(245,158,11,0.18)', border: '#fbbf24', label: 'ממתין' };
                    // Prefer the human-readable title that the agent put in
                    // the approval payload over the raw `type` enum. Falling
                    // back to type keeps the row meaningful even when the
                    // agent forgot to set a title.
                    const payload = (a.payload ?? {}) as {
                      title?: string;
                      summary?: string;
                    };
                    const displayTitle =
                      payload.title?.trim() ?? payload.summary?.trim() ?? a.type;
                    return (
                      <div
                        key={a.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '8px 10px',
                          background: tone.bg,
                          border: `1px solid ${tone.border}55`,
                          borderRadius: 8,
                        }}
                      >
                        <span
                          style={{
                            fontSize: size(11),
                            fontWeight: 700,
                            padding: '2px 8px',
                            borderRadius: 999,
                            background: `${tone.border}33`,
                            color: tone.border,
                            border: `1px solid ${tone.border}88`,
                            flexShrink: 0,
                          }}
                        >
                          {tone.label}
                        </span>
                        <div
                          style={{
                            flex: 1,
                            minWidth: 0,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 2,
                          }}
                        >
                          <div
                            style={{
                              fontWeight: 600,
                              fontSize: size(12),
                              color: '#f1f5f9',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                            title={`${a.type} · ${displayTitle}`}
                          >
                            {displayTitle}
                          </div>
                          <div
                            style={{
                              fontSize: size(10),
                              opacity: 0.6,
                              display: 'flex',
                              gap: 6,
                            }}
                          >
                            <span
                              style={{
                                fontFamily:
                                  'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                                background: 'rgba(0,0,0,0.2)',
                                padding: '0 5px',
                                borderRadius: 3,
                                letterSpacing: 0.3,
                              }}
                            >
                              {a.type}
                            </span>
                            <span>·</span>
                            <span>
                              {a.decidedAt
                                ? `הוחלט: ${new Date(a.decidedAt).toLocaleString('he-IL', {
                                    day: '2-digit',
                                    month: '2-digit',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })}`
                                : `נוצר: ${new Date(a.createdAt).toLocaleString('he-IL', {
                                    day: '2-digit',
                                    month: '2-digit',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })}`}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  </CollapsibleList>
                </div>
              )}
            </section>

            {/* Success criteria — Paperclip doesn't have a native column.
                We'll surface them from issue.executionState.successCriteria
                once GoBoost methodology port lands (Phase 3). Placeholder
                for now so the section is visible. */}
            <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div
                style={{
                  fontSize: size(11),
                  opacity: 0.7,
                  fontWeight: 600,
                  letterSpacing: 0.5,
                }}
              >
                קריטריוני הצלחה
              </div>
              <div
                style={{
                  fontSize: size(12),
                  opacity: 0.6,
                  fontStyle: 'italic',
                  padding: '8px 12px',
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px dashed rgba(255,255,255,0.08)',
                  borderRadius: 8,
                  lineHeight: 1.5,
                }}
              >
                Paperclip בסיסי לא מנהל קריטריוני הצלחה.
                <br />
                ייווסף ב-Phase 3 (Methodology Port) דרך
                <code style={{ marginInline: 4 }}>executionState.successCriteria</code>.
              </div>
            </section>
          </>
        )}
      </div>

      {/* Document viewer modal — opens when the operator clicks the eye
          icon on a document row. Renders the latest revision body in a
          reader-friendly overlay with full markdown rendering. */}
      {viewerDoc ? (
        <div
          onClick={() => setViewerDoc(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            dir="rtl"
            style={{
              width: 'min(720px, 100%)',
              maxHeight: '85vh',
              background: '#0f172a',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 12,
              boxShadow: '0 12px 36px rgba(0,0,0,0.55)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <header
              style={{
                padding: '12px 16px',
                background:
                  'linear-gradient(90deg, #0f766e 0%, #0ea5e9 100%)',
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span aria-hidden style={{ fontSize: size(18) }}>📄</span>
              <span style={{ fontWeight: 700, fontSize: size(15) }}>
                {viewerDoc.title}
              </span>
              <span
                style={{
                  fontSize: size(10),
                  opacity: 0.8,
                  background: 'rgba(255,255,255,0.15)',
                  padding: '1px 6px',
                  borderRadius: 4,
                  marginInlineStart: 6,
                }}
              >
                {viewerDoc.format}
              </span>
              <button
                type="button"
                onClick={() => setViewerDoc(null)}
                title="סגור"
                aria-label="סגור"
                style={{
                  marginInlineStart: 'auto',
                  width: 28,
                  height: 28,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'rgba(255,255,255,0.15)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 7,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: 16,
                  fontWeight: 700,
                  lineHeight: 1,
                }}
              >
                ✕
              </button>
            </header>
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '16px 18px',
                color: '#e2e8f0',
                fontSize: size(14),
                lineHeight: 1.6,
              }}
            >
              {viewerDoc.format === 'markdown' ? (
                <MarkdownText text={viewerDoc.body} emphasisColor="#f1f5f9" />
              ) : (
                <pre
                  style={{
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                    fontSize: size(13),
                  }}
                >
                  {viewerDoc.body}
                </pre>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * CollapsibleList — modern "show more" pattern for long item lists.
 *
 * When there are more items than `previewCount` (default 2), only the
 * first N are shown. The LAST item of the preview is rendered at
 * reduced opacity (with a soft fade-out mask) so the user gets a
 * visual hint that the list continues. A subtle chevron-pill below
 * toggles between the preview and the full list.
 *
 * Used by each section in the Tasks Panel so long backlogs (plans with
 * many steps, dozens of approvals, etc.) don't push the rest of the
 * panel off-screen.
 */
function CollapsibleList({
  children,
  previewCount = 2,
  size,
  labelMore = 'הצג עוד',
  labelLess = 'הצג פחות',
}: {
  children: React.ReactNode[];
  previewCount?: number;
  size: (base: number) => number;
  labelMore?: string;
  labelLess?: string;
}) {
  const [open, setOpen] = useState(false);
  const total = children.length;
  if (total <= previewCount) {
    return <>{children}</>;
  }
  const visible = open ? children : children.slice(0, previewCount);
  const hiddenCount = total - previewCount;
  return (
    <>
      {visible.map((child, i) => {
        // Last preview slot is faded — visual hint that more rows
        // are tucked behind the toggle. A linear-gradient mask
        // softens the bottom edge so it looks intentional rather
        // than a CSS bug.
        const fade = !open && i === previewCount - 1;
        return (
          <div
            key={`cl:${i}`}
            style={{
              opacity: fade ? 0.45 : 1,
              transition: 'opacity 0.2s',
              maskImage: fade
                ? 'linear-gradient(to bottom, #000 55%, rgba(0,0,0,0.35) 100%)'
                : undefined,
              WebkitMaskImage: fade
                ? 'linear-gradient(to bottom, #000 55%, rgba(0,0,0,0.35) 100%)'
                : undefined,
              pointerEvents: fade ? 'none' : undefined,
            }}
          >
            {child}
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          alignSelf: 'center',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 12px',
          background: 'transparent',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 999,
          color: '#cbd5e1',
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: size(11),
          fontWeight: 600,
          marginBlockStart: 2,
          transition: 'background 0.15s, color 0.15s',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background =
            'rgba(255,255,255,0.06)';
          (e.currentTarget as HTMLButtonElement).style.color = '#f1f5f9';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
          (e.currentTarget as HTMLButtonElement).style.color = '#cbd5e1';
        }}
      >
        <span style={{ fontSize: size(9) }}>{open ? '▲' : '▼'}</span>
        <span>{open ? labelLess : `${labelMore} (${hiddenCount})`}</span>
      </button>
    </>
  );
}

/**
 * Compact icon button used by the documents row for the eye/download/
 * remove actions. Lives next to the disclosure toggle so the row stays
 * a single horizontal strip. `tone="danger"` is used for the remove
 * action to make the destructive intent visible at a glance.
 */
function DocIconButton({
  title,
  onClick,
  disabled,
  tone,
  size,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'danger';
  size: (base: number) => number;
  children: React.ReactNode;
}) {
  const accent =
    tone === 'danger' ? 'rgba(248,113,113,0.45)' : 'rgba(255,255,255,0.12)';
  const bg =
    tone === 'danger' ? 'rgba(220,38,38,0.16)' : 'rgba(255,255,255,0.06)';
  const color = tone === 'danger' ? '#fecaca' : '#e2e8f0';
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 24,
        height: 24,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: bg,
        color,
        border: `1px solid ${accent}`,
        borderRadius: 6,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontFamily: 'inherit',
        fontSize: size(12),
        fontWeight: 700,
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}
