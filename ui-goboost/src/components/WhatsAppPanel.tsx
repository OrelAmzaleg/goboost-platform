import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  fetchAgentIssues,
  fetchIssueComments,
  postIssueComment,
  subscribeActivity,
  uuidForNumericAgentId,
  type PaperclipComment,
  type PaperclipIssue,
} from '../paperclipApi.js';

/**
 * GoBoost WhatsApp Chat Panel.
 *
 * Iteration 2.B.1 — basic chat with selected agent's most-recent issue.
 * Iteration 2.B.2.A — UX polish: collapsible, font scale, font family,
 *   minimal icon-only controls in the header.
 *
 * Layered in 2.B.2.B/.C/.D (separate sub-iterations):
 *   - Session navigator (multi-issue picker)
 *   - Message type separation (system events tab)
 *   - Tasks Panel (issue tree + criteria)
 */
export interface WhatsAppPanelProps {
  /** Pixel-agents numeric id of the selected agent, or null when none. */
  selectedAgentId: number | null;
  /** Display name of the selected agent (from useExtensionMessages). */
  selectedAgentName?: string | null;
}

// ── User preferences (persisted in localStorage) ────────────────────────────

const LS_COLLAPSED = 'goboost.panel.collapsed';
const LS_FONT_SCALE = 'goboost.panel.fontScale';

// Font scale levels — 7 steps for fine-grained control, including a smaller
// option (0.7) per user request. Center = 1.0.
const FONT_SCALES = [0.7, 0.85, 1.0, 1.15, 1.3, 1.5, 1.7] as const;
const DEFAULT_FONT_SCALE = 1.0;

// Single font family — Heebo. The earlier multi-font cycler was removed:
// in practice Heebo covers every legibility case and the toggle didn't
// add operational value.
const PANEL_FONT_STACK = "'Heebo', system-ui, -apple-system, sans-serif";

function readBoolPref(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return raw === '1';
  } catch {
    return fallback;
  }
}
function readScalePref(): number {
  try {
    const raw = localStorage.getItem(LS_FONT_SCALE);
    const n = raw == null ? NaN : Number.parseFloat(raw);
    return FONT_SCALES.includes(n as (typeof FONT_SCALES)[number])
      ? n
      : DEFAULT_FONT_SCALE;
  } catch {
    return DEFAULT_FONT_SCALE;
  }
}
// ── Helpers ─────────────────────────────────────────────────────────────────

interface BubbleAuthor {
  type: 'human' | 'agent' | 'system';
  name: string;
}

function authorFor(comment: PaperclipComment, fallbackAgentName: string): BubbleAuthor {
  if (comment.authorType === 'user' || comment.authorUserId) {
    return { type: 'human', name: 'אני' };
  }
  if (comment.authorType === 'agent' || comment.authorAgentId) {
    return { type: 'agent', name: fallbackAgentName };
  }
  return { type: 'system', name: 'מערכת' };
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

// Status color for the issue picker dot. Paperclip statuses:
//   backlog/todo → cool gray (queued)
//   in_progress  → blue
//   in_review    → amber (waiting for sign-off)
//   blocked      → orange (impeded)
//   done         → green
//   cancelled    → red/muted
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

// Hebrew label for the status (compact, for the picker rows).
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

// Header icon button — small, minimal, white-on-purple-gradient.
function IconButton({
  title,
  onClick,
  children,
  disabled,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
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
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        fontFamily: 'inherit',
        fontSize: 13,
        fontWeight: 700,
        lineHeight: 1,
        transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => {
        if (!disabled) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.22)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.12)';
      }}
    >
      {children}
    </button>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export function WhatsAppPanel({ selectedAgentId, selectedAgentName }: WhatsAppPanelProps) {
  // Chat state
  const [issue, setIssue] = useState<PaperclipIssue | null>(null);
  const [allIssues, setAllIssues] = useState<PaperclipIssue[]>([]);
  const [comments, setComments] = useState<PaperclipComment[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  // UX preferences (persisted)
  const [collapsed, setCollapsed] = useState(() => readBoolPref(LS_COLLAPSED, false));
  const [fontScale, setFontScale] = useState<number>(() => readScalePref());

  // Session picker (2.B.2.B) — dropdown of all issues assigned to the
  // current agent. Closes on outside-click or when an item is selected.
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerWrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (pickerWrapRef.current && target && !pickerWrapRef.current.contains(target)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pickerOpen]);
  const onSelectIssue = useCallback((next: PaperclipIssue) => {
    setIssue(next);
    setPickerOpen(false);
  }, []);

  useEffect(() => {
    try { localStorage.setItem(LS_COLLAPSED, collapsed ? '1' : '0'); } catch {}
  }, [collapsed]);
  useEffect(() => {
    try { localStorage.setItem(LS_FONT_SCALE, String(fontScale)); } catch {}
  }, [fontScale]);

  // Convenience size function — all measured-text sizes pass through this so
  // the scale control applies uniformly.
  const size = useCallback((base: number) => Math.round(base * fontScale), [fontScale]);

  const scaleIndex = FONT_SCALES.indexOf(fontScale as (typeof FONT_SCALES)[number]);
  const canScaleDown = scaleIndex > 0;
  const canScaleUp = scaleIndex >= 0 && scaleIndex < FONT_SCALES.length - 1;
  const onScaleDown = useCallback(() => {
    const i = FONT_SCALES.indexOf(fontScale as (typeof FONT_SCALES)[number]);
    if (i > 0) setFontScale(FONT_SCALES[i - 1]);
  }, [fontScale]);
  const onScaleUp = useCallback(() => {
    const i = FONT_SCALES.indexOf(fontScale as (typeof FONT_SCALES)[number]);
    if (i >= 0 && i < FONT_SCALES.length - 1) setFontScale(FONT_SCALES[i + 1]);
  }, [fontScale]);
  const onToggleCollapsed = useCallback(() => setCollapsed((c) => !c), []);

  const agentName = selectedAgentName ?? 'סוכן';
  const agentInitial = useMemo(() => {
    const trimmed = agentName.trim();
    return trimmed.length > 0 ? trimmed.charAt(0) : '?';
  }, [agentName]);

  const agentUuid = useMemo(
    () => (selectedAgentId == null ? null : uuidForNumericAgentId(selectedAgentId)),
    [selectedAgentId],
  );

  // Reset state when a different agent is selected
  useEffect(() => {
    setIssue(null);
    setAllIssues([]);
    setComments([]);
    setDraft('');
    setErrorText(null);
  }, [selectedAgentId]);

  // Effect A: when the selected agent changes, fetch their issue list and
  // auto-select the most-recently-updated one. Comments load is delegated
  // to Effect B so manual issue switching (via the session picker) shares
  // the same code path as initial auto-select.
  useEffect(() => {
    if (!agentUuid) {
      setAllIssues([]);
      setIssue(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const issues = await fetchAgentIssues(agentUuid);
      if (cancelled) return;
      setAllIssues(issues);
      setIssue(issues[0] ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [agentUuid]);

  // Effect B: whenever the active issue changes (auto-selected or
  // operator-picked from the session navigator), fetch its comments.
  useEffect(() => {
    if (!issue) {
      setComments([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const c = await fetchIssueComments(issue.id);
      if (cancelled) return;
      setComments(c);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [issue]);

  // Refresh comments when activity fires for our current issue
  useEffect(() => {
    if (!issue) return;
    const unsubscribe = subscribeActivity((payload) => {
      const entityType = String(payload.entityType ?? '');
      const entityId = String(payload.entityId ?? '');
      const action = String(payload.action ?? '');
      const issueIdInPayload = String(payload.issueId ?? '');
      const matchesIssue =
        (entityType === 'issue' && entityId === issue.id) || issueIdInPayload === issue.id;
      const isCommentAction = /comment|reply|message/i.test(action);
      if (matchesIssue && isCommentAction) {
        void fetchIssueComments(issue.id).then(setComments);
      }
    });
    return unsubscribe;
  }, [issue]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [comments]);

  const handleSend = useCallback(async () => {
    if (!issue) return;
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    setErrorText(null);
    const created = await postIssueComment(issue.id, text);
    setSending(false);
    if (!created) {
      setErrorText('שליחת ההודעה נכשלה. ודא ש-Paperclip זמין ונסה שוב.');
      return;
    }
    setDraft('');
    setComments((prev) => [...prev, created]);
  }, [issue, draft]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  const empty = !selectedAgentId || !agentUuid;

  // ── Collapsed strip ────────────────────────────────────────────────────────
  if (collapsed) {
    return (
      <aside
        dir="rtl"
        className="gb-chat-panel-scope"
        style={
          {
            position: 'fixed',
            top: 38,
            right: 0,
            bottom: 0,
            width: 44,
            background: 'rgba(15, 23, 42, 0.92)',
            backdropFilter: 'blur(8px)',
            borderInlineStart: '1px solid rgba(255,255,255,0.08)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            paddingBlockStart: 10,
            gap: 10,
            zIndex: 100,
            boxShadow: '-2px 0 12px rgba(0,0,0,0.35)',
            // CSS variable read by `.gb-chat-panel-scope` in index.css — the
            // scope class beats the global `*` rule that would otherwise force
            // every descendant to FS Pixel Sans.
            ['--gb-chat-font' as string]: PANEL_FONT_STACK,
          } as React.CSSProperties
        }
      >
        <button
          type="button"
          onClick={onToggleCollapsed}
          title="הצג פאנל"
          aria-label="הצג פאנל"
          style={{
            width: 28,
            height: 28,
            background: 'linear-gradient(135deg, #4f46e5, #7c3aed)',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontSize: 16,
            fontWeight: 700,
            lineHeight: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          ‹
        </button>
        <div
          title={empty ? 'אין סוכן נבחר' : agentName}
          style={{
            width: 28,
            height: 28,
            background: empty ? '#475569' : '#16a34a',
            color: '#fff',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 13,
            fontWeight: 700,
            border: '1px solid rgba(255,255,255,0.2)',
          }}
        >
          {agentInitial}
        </div>
        {comments.length > 0 && !empty ? (
          <div
            title={`${comments.length} הודעות`}
            style={{
              fontSize: 10,
              color: '#94a3b8',
              fontWeight: 600,
            }}
          >
            {comments.length}
          </div>
        ) : null}
      </aside>
    );
  }

  // ── Expanded panel ────────────────────────────────────────────────────────
  return (
    <aside
      dir="rtl"
      className="gb-chat-panel-scope"
      style={
        {
          position: 'fixed',
          top: 38,
          right: 0,
          bottom: 0,
          width: 420,
          background: 'rgba(15, 23, 42, 0.92)',
          backdropFilter: 'blur(8px)',
          borderInlineStart: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          flexDirection: 'column',
          color: '#e2e8f0',
          fontSize: size(15),
          zIndex: 100,
          boxShadow: '-2px 0 12px rgba(0,0,0,0.35)',
          transition: 'width 0.2s ease-in-out',
          // CSS variable read by `.gb-chat-panel-scope` in index.css.
          ['--gb-chat-font' as string]: PANEL_FONT_STACK,
        } as React.CSSProperties
      }
    >
      {/* Header */}
      <header
        style={{
          padding: '12px 14px',
          background: 'linear-gradient(90deg, #4f46e5 0%, #7c3aed 100%)',
          color: '#fff',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {/* Top row: title + minimal controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              fontWeight: 700,
              fontSize: size(18),
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {empty ? 'בחר סוכן במשרד' : agentName}
          </div>
          <div style={{ display: 'inline-flex', gap: 4, flexShrink: 0 }}>
            <IconButton
              title="הקטן גופנים"
              onClick={onScaleDown}
              disabled={!canScaleDown}
            >
              A−
            </IconButton>
            <IconButton
              title="הגדל גופנים"
              onClick={onScaleUp}
              disabled={!canScaleUp}
            >
              A+
            </IconButton>
            <IconButton title="קפל פאנל" onClick={onToggleCollapsed}>
              ›
            </IconButton>
          </div>
        </div>
        {/* Sub-row: session picker (issue identifier + title + dropdown).
            When the agent has no issues, this collapses to a hint. When
            there's exactly one issue we still render the picker chip
            (consistent affordance + lets the user see the identifier). */}
        <div style={{ position: 'relative' }} ref={pickerWrapRef}>
          {empty ? (
            <div style={{ fontSize: size(13), opacity: 0.9 }}>
              לחץ על דמות במשרד כדי לפתוח שיחה
            </div>
          ) : !issue && allIssues.length === 0 ? (
            <div style={{ fontSize: size(13), opacity: 0.9 }}>
              אין issues פעילים לסוכן הזה
            </div>
          ) : !issue ? (
            <div style={{ fontSize: size(13), opacity: 0.9 }}>—</div>
          ) : (
            <button
              type="button"
              onClick={() => setPickerOpen((o) => !o)}
              title={`${issue.identifier ?? '—'} · ${issue.title}`}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                background: 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 8,
                color: '#fff',
                cursor: 'pointer',
                textAlign: 'start',
                fontFamily: 'inherit',
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  'rgba(255,255,255,0.15)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  'rgba(255,255,255,0.08)';
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: statusColor(issue.status),
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  fontSize: size(12),
                  fontWeight: 700,
                  background: 'rgba(0,0,0,0.25)',
                  padding: '2px 6px',
                  borderRadius: 4,
                  flexShrink: 0,
                  letterSpacing: 0.5,
                }}
              >
                {issue.identifier ?? '—'}
              </span>
              <span
                style={{
                  fontSize: size(13),
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {issue.title}
              </span>
              <span style={{ fontSize: size(11), opacity: 0.7, flexShrink: 0 }}>
                {allIssues.length > 1 ? `${allIssues.length} ${pickerOpen ? '▲' : '▼'}` : ''}
              </span>
            </button>
          )}

          {/* Dropdown: list of all agent's issues. Anchored below the chip. */}
          {pickerOpen && allIssues.length > 0 ? (
            <div
              style={{
                position: 'absolute',
                top: 'calc(100% + 6px)',
                insetInlineStart: 0,
                insetInlineEnd: 0,
                maxHeight: 320,
                overflowY: 'auto',
                background: '#1e293b',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 10,
                boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
                zIndex: 200,
                padding: 6,
                color: '#e2e8f0',
              }}
            >
              {allIssues.map((it) => {
                const active = issue?.id === it.id;
                return (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => onSelectIssue(it)}
                    title={`${it.identifier ?? '—'} · ${it.title} · ${statusLabel(it.status)}`}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 10px',
                      background: active ? 'rgba(99,102,241,0.25)' : 'transparent',
                      border: active
                        ? '1px solid rgba(129,140,248,0.6)'
                        : '1px solid transparent',
                      borderRadius: 7,
                      color: '#e2e8f0',
                      cursor: 'pointer',
                      textAlign: 'start',
                      fontFamily: 'inherit',
                      marginBlockEnd: 2,
                      transition: 'background 0.12s',
                    }}
                    onMouseEnter={(e) => {
                      if (!active)
                        (e.currentTarget as HTMLButtonElement).style.background =
                          'rgba(255,255,255,0.06)';
                    }}
                    onMouseLeave={(e) => {
                      if (!active)
                        (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                    }}
                  >
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
                        fontSize: size(12),
                        fontWeight: 700,
                        background: 'rgba(255,255,255,0.08)',
                        padding: '2px 6px',
                        borderRadius: 4,
                        flexShrink: 0,
                        letterSpacing: 0.5,
                      }}
                    >
                      {it.identifier ?? '—'}
                    </span>
                    <span
                      style={{
                        fontSize: size(13),
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {it.title}
                    </span>
                    <span
                      style={{
                        fontSize: size(10),
                        opacity: 0.7,
                        flexShrink: 0,
                        padding: '1px 5px',
                        background: 'rgba(255,255,255,0.05)',
                        borderRadius: 3,
                      }}
                    >
                      {statusLabel(it.status)}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </header>

      {/* Bubbles */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {empty ? null : loading ? (
          <div
            style={{
              textAlign: 'center',
              color: '#94a3b8',
              fontSize: size(14),
              marginTop: 28,
            }}
          >
            טוען היסטוריה…
          </div>
        ) : comments.length === 0 ? (
          <div
            style={{
              textAlign: 'center',
              color: '#94a3b8',
              fontSize: size(14),
              marginTop: 28,
              lineHeight: 1.6,
            }}
          >
            {issue
              ? 'אין הודעות עדיין בשיחה הזו. שלח את הראשונה.'
              : 'אין issue פעיל. צור issue ב-Paperclip ב-:3100 והקצה אותו לסוכן.'}
          </div>
        ) : (
          comments.map((c) => {
            const author = authorFor(c, agentName);
            const isHuman = author.type === 'human';
            const isSystem = author.type === 'system';
            return (
              <div
                key={c.id}
                style={{
                  alignSelf: isHuman ? 'flex-start' : 'flex-end',
                  maxWidth: '85%',
                  background: isHuman ? '#16a34a' : isSystem ? '#475569' : '#e2e8f0',
                  color: isHuman ? '#fff' : isSystem ? '#e2e8f0' : '#0f172a',
                  padding: '10px 13px',
                  borderRadius: 12,
                  borderTopRightRadius: isHuman ? 12 : 3,
                  borderTopLeftRadius: isHuman ? 3 : 12,
                  fontSize: size(15),
                  lineHeight: 1.55,
                  boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                <div
                  style={{
                    fontSize: size(12),
                    opacity: 0.75,
                    marginBottom: 3,
                    fontWeight: 700,
                  }}
                >
                  {author.name}
                </div>
                <div>{c.body}</div>
                <div
                  style={{
                    fontSize: size(11),
                    opacity: 0.6,
                    marginTop: 6,
                    textAlign: 'start',
                  }}
                >
                  {formatTime(c.createdAt)}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Error strip */}
      {errorText ? (
        <div
          style={{
            background: '#7f1d1d',
            color: '#fecaca',
            fontSize: size(14),
            padding: '8px 14px',
          }}
        >
          {errorText}
        </div>
      ) : null}

      {/* Input */}
      <footer
        style={{
          padding: 12,
          borderBlockStart: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          gap: 10,
          alignItems: 'flex-end',
        }}
      >
        <textarea
          dir="rtl"
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            empty ? 'בחר סוכן…' : issue ? 'כתוב הודעה…' : 'אין שיחה פעילה'
          }
          disabled={empty || !issue || sending}
          style={{
            flex: 1,
            resize: 'none',
            minHeight: 44,
            maxHeight: 140,
            padding: '10px 12px',
            borderRadius: 10,
            border: '1px solid rgba(255,255,255,0.12)',
            background: 'rgba(255,255,255,0.06)',
            color: '#f1f5f9',
            fontFamily: 'inherit',
            fontSize: size(15),
            lineHeight: 1.45,
            outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={empty || !issue || sending || draft.trim().length === 0}
          style={{
            background: '#16a34a',
            color: '#fff',
            border: 'none',
            borderRadius: 10,
            padding: '10px 18px',
            fontSize: size(15),
            fontWeight: 700,
            cursor:
              empty || !issue || sending || draft.trim().length === 0
                ? 'not-allowed'
                : 'pointer',
            opacity:
              empty || !issue || sending || draft.trim().length === 0 ? 0.5 : 1,
            fontFamily: 'inherit',
          }}
        >
          {sending ? '…' : 'שלח'}
        </button>
      </footer>
    </aside>
  );
}
