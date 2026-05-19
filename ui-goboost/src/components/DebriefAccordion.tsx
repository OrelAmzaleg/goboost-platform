import { useState } from 'react';

import type { PaperclipComment } from '../paperclipApi.js';
import { MarkdownText } from './MarkdownText.js';

/**
 * DebriefAccordion — collapsible container for the agent's
 * "self-reflection" comments that Paperclip's heartbeat loop generates.
 *
 * Why a separate stream:
 *   Each heartbeat run emits one or more internal-monologue comments —
 *   "Self-echo guard", "Disposition", "Exiting cleanly", "No new human
 *   input", etc. They're operationally useful (you can audit why the
 *   agent didn't act) but they overwhelm the chat when stacked. We
 *   collapse them into one block so the dialogue line stays readable.
 *
 * Detection (see DEBRIEF_PATTERNS): the comment carries a `createdByRunId`
 * (i.e. came from a heartbeat run) AND its body matches one of a small
 * set of canonical phrases that the heartbeat self-echo guard emits.
 * Conservative on purpose — false negatives just keep a comment in the
 * main flow, which is harmless; false positives would hide real agent
 * speech, which is bad.
 */

export interface DebriefAccordionProps {
  comments: PaperclipComment[];
  size: (base: number) => number;
  formatTime: (iso: string) => string;
  agentName: string;
}

// Canonical phrases produced by the heartbeat self-echo / disposition
// guards. Matched case-insensitively against the comment body.
// Keep this list tight — broaden only when we observe a new pattern.
const DEBRIEF_PATTERNS = [
  /\bself[- ]echo\b/i,
  /^\s*disposition\s*:/i,
  /^\s*summary\s*:\s*wake\b/i,
  /^\s*latest comment\s*\(/i,
  /\bexiting cleanly\b/i,
  /\bno further action\b/i,
  /\bno new (human|user) input\b/i,
  /\bno new user comment to act on\b/i,
];

/**
 * Returns true if the comment looks like a heartbeat self-debrief.
 * Exported so the chat panel can filter it out of the main timeline.
 */
export function isDebriefComment(comment: PaperclipComment): boolean {
  if (!comment.createdByRunId) return false;
  if (comment.presentation?.kind === 'system_notice') return false;
  const body = comment.body ?? '';
  return DEBRIEF_PATTERNS.some((rx) => rx.test(body));
}

export function DebriefAccordion({
  comments,
  size,
  formatTime,
  agentName,
}: DebriefAccordionProps) {
  const [open, setOpen] = useState(false);

  const sorted = [...comments].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : 1,
  );
  const latest = sorted[sorted.length - 1];

  return (
    <div
      style={{
        alignSelf: 'stretch',
        background: 'rgba(15,23,42,0.6)',
        border: '1px solid rgba(148,163,184,0.35)',
        borderRadius: 10,
        overflow: 'hidden',
        flexShrink: 0,
        minHeight: 42,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%',
          minHeight: 40,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          background: 'transparent',
          border: 'none',
          color: '#cbd5e1',
          fontFamily: 'inherit',
          fontSize: size(12),
          cursor: 'pointer',
          textAlign: 'start',
        }}
      >
        <span
          aria-hidden
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            background: 'rgba(148,163,184,0.18)',
            color: '#cbd5e1',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: size(13),
            flexShrink: 0,
          }}
        >
          🗒
        </span>
        <span style={{ fontWeight: 700, color: '#e2e8f0', flexShrink: 0 }}>
          סיכומי הסוכן
        </span>
        <span
          style={{
            fontSize: size(11),
            fontWeight: 700,
            padding: '1px 7px',
            borderRadius: 999,
            background: 'rgba(0,0,0,0.25)',
            flexShrink: 0,
          }}
        >
          {comments.length}
        </span>

        {!open && latest ? (
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: size(11),
              opacity: 0.7,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              marginInlineStart: 6,
            }}
            title={latest.body}
          >
            {latest.body}
          </span>
        ) : (
          <span style={{ flex: 1 }} />
        )}

        <span style={{ fontSize: size(10), opacity: 0.55, flexShrink: 0 }}>
          {open ? '▲' : '▼'}
        </span>
      </button>

      {open ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '4px 10px 10px',
            borderBlockStart: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          {/* Newest first so the most recent reasoning is at the top. */}
          {[...sorted].reverse().map((c) => (
            <div
              key={c.id}
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: 8,
                padding: '8px 10px',
                fontSize: size(12),
                lineHeight: 1.55,
                color: '#cbd5e1',
              }}
            >
              <div
                style={{
                  fontSize: size(10),
                  opacity: 0.65,
                  fontWeight: 700,
                  marginBlockEnd: 4,
                  display: 'flex',
                  gap: 6,
                  alignItems: 'baseline',
                }}
              >
                <span>{agentName}</span>
                <span>·</span>
                <span>{formatTime(c.createdAt)}</span>
                {c.createdByRunId ? (
                  <span
                    style={{
                      background: 'rgba(0,0,0,0.25)',
                      padding: '0 5px',
                      borderRadius: 3,
                      letterSpacing: 0.3,
                      fontFamily:
                        'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                    }}
                  >
                    run {c.createdByRunId.slice(-6)}
                  </span>
                ) : null}
              </div>
              <MarkdownText text={c.body} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
