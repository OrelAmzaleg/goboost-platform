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
 * GoBoost WhatsApp Chat Panel (Iteration 2.B.1).
 *
 * Right-side floating panel: a single conversation with the agent currently
 * selected in the office canvas. Shows comments on that agent's most
 * recently updated issue. Sending writes a comment back through Paperclip.
 *
 * Layered in 2.B.2/.3 (separate iterations):
 *   - Task panel (issue tree + success criteria) — triggered by the
 *     "View plan" link in the header strip.
 *   - Office speech bubbles for Layer 3 (per-action narration) — purely
 *     office overlay, not in this panel.
 */
export interface WhatsAppPanelProps {
  /** Pixel-agents numeric id of the selected agent, or null when none. */
  selectedAgentId: number | null;
  /** Display name of the selected agent (from useExtensionMessages). */
  selectedAgentName?: string | null;
}

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

export function WhatsAppPanel({ selectedAgentId, selectedAgentName }: WhatsAppPanelProps) {
  const [issue, setIssue] = useState<PaperclipIssue | null>(null);
  const [allIssues, setAllIssues] = useState<PaperclipIssue[]>([]);
  const [comments, setComments] = useState<PaperclipComment[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const agentName = selectedAgentName ?? 'סוכן';
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

  // Initial load: fetch agent's issues, pick the most-recent one, load its comments
  useEffect(() => {
    if (!agentUuid) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const issues = await fetchAgentIssues(agentUuid);
      if (cancelled) return;
      setAllIssues(issues);
      const top = issues[0] ?? null;
      setIssue(top);
      if (top) {
        const c = await fetchIssueComments(top.id);
        if (cancelled) return;
        setComments(c);
      } else {
        setComments([]);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [agentUuid]);

  // Refresh comments when activity fires for our current issue
  useEffect(() => {
    if (!issue) return;
    const unsubscribe = subscribeActivity((payload) => {
      const entityType = String(payload.entityType ?? '');
      const entityId = String(payload.entityId ?? '');
      const action = String(payload.action ?? '');
      // We want any comment-related activity on the current issue. The
      // payload usually carries the issue id either as entityId (when
      // entity=issue) or under issueId. Match both.
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

  // Auto-scroll to bottom when new comments arrive
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
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
    // Optimistic: append immediately (the WS event will reconcile via fetch)
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

  // ── Render ────────────────────────────────────────────────────────────────

  const empty = !selectedAgentId || !agentUuid;

  return (
    <aside
      dir="rtl"
      style={{
        position: 'fixed',
        top: 32, // sit below the bootstrap banner
        right: 0,
        bottom: 0,
        width: 420,
        background: 'rgba(15, 23, 42, 0.92)',
        backdropFilter: 'blur(8px)',
        borderInlineStart: '1px solid rgba(255,255,255,0.08)',
        display: 'flex',
        flexDirection: 'column',
        color: '#e2e8f0',
        fontFamily: "'Heebo', 'Assistant', 'Rubik', system-ui, sans-serif",
        fontSize: 15,
        zIndex: 100,
        boxShadow: '-2px 0 12px rgba(0,0,0,0.35)',
      }}
    >
      {/* Header */}
      <header
        style={{
          padding: '16px 18px',
          background: 'linear-gradient(90deg, #4f46e5 0%, #7c3aed 100%)',
          color: '#fff',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 18 }}>
          {empty ? 'בחר סוכן במשרד' : agentName}
        </div>
        <div style={{ fontSize: 13, opacity: 0.9 }}>
          {empty
            ? 'לחץ על דמות במשרד כדי לפתוח שיחה'
            : issue
              ? `שיחה על: ${issue.title}`
              : loading
                ? 'טוען…'
                : allIssues.length === 0
                  ? 'אין issues פעילים לסוכן הזה'
                  : '—'}
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
          <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 14, marginTop: 28 }}>
            טוען היסטוריה…
          </div>
        ) : comments.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 14, marginTop: 28, lineHeight: 1.6 }}>
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
                  fontSize: 15,
                  lineHeight: 1.55,
                  boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 3, fontWeight: 700 }}>
                  {author.name}
                </div>
                <div>{c.body}</div>
                <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6, textAlign: 'start' }}>
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
            fontSize: 14,
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
            empty
              ? 'בחר סוכן…'
              : issue
                ? 'כתוב הודעה…'
                : 'אין שיחה פעילה'
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
            fontSize: 15,
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
            fontSize: 15,
            fontWeight: 700,
            cursor:
              empty || !issue || sending || draft.trim().length === 0
                ? 'not-allowed'
                : 'pointer',
            opacity: empty || !issue || sending || draft.trim().length === 0 ? 0.5 : 1,
            fontFamily: 'inherit',
          }}
        >
          {sending ? '…' : 'שלח'}
        </button>
      </footer>
    </aside>
  );
}
