import { useState } from 'react';

import {
  resolveApproval,
  type PaperclipApproval,
} from '../paperclipApi.js';

/**
 * ApprovalCard — chat-flow rendering of an `approvals` row.
 *
 * Per design discussion (2026-05): approvals are surfaced inline in the
 * chat timeline, NOT only inside the Tasks Panel. When status is "pending"
 * the card carries Approve / Reject buttons that call:
 *   POST /api/approvals/:id/approve   (body: { decisionNote? })
 *   POST /api/approvals/:id/reject    (same)
 *
 * Resolved rows render read-only with a status pill (אושר / נדחה).
 */

export interface ApprovalCardProps {
  approval: PaperclipApproval;
  size: (base: number) => number;
  formatTime: (iso: string) => string;
  onResolved?: (next: PaperclipApproval) => void;
}

const STATUS_META: Record<
  string,
  { label: string; color: string }
> = {
  pending: { label: 'ממתין לאישור', color: '#f59e0b' },
  approved: { label: 'אושר', color: '#22c55e' },
  rejected: { label: 'נדחה', color: '#dc2626' },
};
const DEFAULT_STATUS_META = { label: 'לא ידוע', color: '#94a3b8' };

function pickStatus(s: string | null | undefined) {
  return STATUS_META[s ?? ''] ?? DEFAULT_STATUS_META;
}

export function ApprovalCard({
  approval,
  size,
  formatTime,
  onResolved,
}: ApprovalCardProps) {
  const status = pickStatus(approval.status);
  const isPending = approval.status === 'pending';
  const [busy, setBusy] = useState<null | 'approve' | 'reject'>(null);
  const [error, setError] = useState<string | null>(null);

  // Pull a readable label out of payload — Paperclip stores per-type
  // metadata there (e.g. document key, action description). We grab the
  // first string-valued field as a best-effort summary.
  const summary = (() => {
    const p = approval.payload ?? {};
    const candidates = [
      'summary',
      'description',
      'title',
      'reason',
      'documentTitle',
      'actionLabel',
    ];
    for (const key of candidates) {
      const v = (p as Record<string, unknown>)[key];
      if (typeof v === 'string' && v.trim().length > 0) return v;
    }
    return null;
  })();

  const handle = async (decision: 'approve' | 'reject') => {
    setBusy(decision);
    setError(null);
    const next = await resolveApproval(approval.id, decision);
    setBusy(null);
    if (!next) {
      setError('פעולה נכשלה. נסה שוב.');
      return;
    }
    onResolved?.(next);
  };

  return (
    <div
      style={{
        alignSelf: 'stretch',
        background: 'rgba(245,158,11,0.08)',
        border: `1px solid ${status.color}55`,
        borderRadius: 12,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        color: '#e2e8f0',
        fontSize: size(13),
        lineHeight: 1.5,
        boxShadow: `0 2px 6px rgba(0,0,0,0.2), inset 0 0 0 1px ${status.color}22`,
      }}
    >
      {/* Header strip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          aria-hidden
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            background: `${status.color}33`,
            color: status.color,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: size(14),
            flexShrink: 0,
          }}
        >
          ✋
        </span>
        <span style={{ fontWeight: 700, fontSize: size(13), color: '#f1f5f9' }}>
          בקשת אישור
        </span>
        <span
          style={{
            fontSize: size(11),
            fontWeight: 700,
            padding: '1px 7px',
            borderRadius: 4,
            background: 'rgba(0,0,0,0.25)',
            letterSpacing: 0.3,
          }}
        >
          {approval.type}
        </span>
        <span
          style={{
            marginInlineStart: 'auto',
            fontSize: size(11),
            fontWeight: 700,
            padding: '2px 8px',
            borderRadius: 999,
            background: `${status.color}33`,
            color: status.color,
            border: `1px solid ${status.color}55`,
          }}
        >
          {status.label}
        </span>
      </div>

      {/* Body */}
      {summary ? (
        <div style={{ fontSize: size(13), lineHeight: 1.55, color: '#cbd5e1' }}>
          {summary}
        </div>
      ) : null}

      {/* Action row — only for pending. */}
      {isPending ? (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={() => void handle('reject')}
            disabled={busy !== null}
            style={{
              padding: '6px 14px',
              borderRadius: 8,
              border: '1px solid rgba(248,113,113,0.5)',
              background: 'rgba(220,38,38,0.18)',
              color: '#fecaca',
              fontSize: size(12),
              fontWeight: 700,
              fontFamily: 'inherit',
              cursor: busy !== null ? 'not-allowed' : 'pointer',
              opacity: busy !== null ? 0.6 : 1,
            }}
          >
            {busy === 'reject' ? '…' : 'דחה'}
          </button>
          <button
            type="button"
            onClick={() => void handle('approve')}
            disabled={busy !== null}
            style={{
              padding: '6px 14px',
              borderRadius: 8,
              border: '1px solid rgba(74,222,128,0.5)',
              background: 'rgba(34,197,94,0.22)',
              color: '#dcfce7',
              fontSize: size(12),
              fontWeight: 700,
              fontFamily: 'inherit',
              cursor: busy !== null ? 'not-allowed' : 'pointer',
              opacity: busy !== null ? 0.6 : 1,
            }}
          >
            {busy === 'approve' ? '…' : 'אשר'}
          </button>
        </div>
      ) : null}

      {/* Footer */}
      {!isPending && approval.decidedAt ? (
        <div
          style={{
            fontSize: size(11),
            opacity: 0.7,
            paddingTop: 4,
            borderBlockStart: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          הוחלט: {formatTime(approval.decidedAt)}
        </div>
      ) : (
        <div style={{ fontSize: size(10), opacity: 0.5, textAlign: 'start' }}>
          {formatTime(approval.createdAt)}
        </div>
      )}

      {error ? (
        <div
          style={{
            fontSize: size(11),
            color: '#fecaca',
            background: 'rgba(127,29,29,0.4)',
            padding: '4px 8px',
            borderRadius: 6,
          }}
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
