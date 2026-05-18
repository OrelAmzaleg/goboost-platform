import { useEffect, useState } from 'react';

import {
  fetchIssueById,
  fetchIssueChildren,
  getAgentName,
  type PaperclipIssue,
} from '../paperclipApi.js';

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
}

function statusColor(status: string): string {
  switch (status) {
    case 'in_progress':
      return '#3b82f6';
    case 'in_review':
      return '#f59e0b';
    case 'blocked':
      return '#fb923c';
    case 'done':
      return '#22c55e';
    case 'cancelled':
      return '#dc2626';
    case 'todo':
    case 'backlog':
    default:
      return '#94a3b8';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'backlog':
      return 'תור';
    case 'todo':
      return 'לעשות';
    case 'in_progress':
      return 'בעבודה';
    case 'in_review':
      return 'בבדיקה';
    case 'blocked':
      return 'חסום';
    case 'done':
      return 'הושלם';
    case 'cancelled':
      return 'בוטל';
    default:
      return status;
  }
}

function IssueRow({
  it,
  size,
  highlight = false,
}: {
  it: PaperclipIssue;
  size: (base: number) => number;
  highlight?: boolean;
}) {
  const assigneeName = getAgentName(it.assigneeAgentId) ?? null;
  return (
    <div
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
      }}
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
}: TasksPanelProps) {
  const [parent, setParent] = useState<PaperclipIssue | null>(null);
  const [children, setChildren] = useState<PaperclipIssue[]>([]);
  const [loadingChildren, setLoadingChildren] = useState(false);

  // Load parent + children whenever the active issue changes (and panel is open).
  useEffect(() => {
    if (!isOpen || !issue) {
      setParent(null);
      setChildren([]);
      return;
    }
    let cancelled = false;
    setLoadingChildren(true);
    (async () => {
      const [p, kids] = await Promise.all([
        issue.parentId ? fetchIssueById(issue.parentId) : Promise.resolve(null),
        fetchIssueChildren(issue.id),
      ]);
      if (cancelled) return;
      setParent(p);
      setChildren(kids);
      setLoadingChildren(false);
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
          top: 38,
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
                  {children.map((c) => (
                    <IssueRow key={c.id} it={c} size={size} />
                  ))}
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
    </aside>
  );
}
