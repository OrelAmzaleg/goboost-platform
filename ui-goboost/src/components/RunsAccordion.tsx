import { useEffect, useState } from 'react';

import { LiveRunCard, type LiveRun } from './LiveRunCard.js';

/**
 * RunsAccordion — a single collapsible container that groups every
 * agent run for the active issue. Anchored below the last chat bubble.
 *
 * Why this exists:
 *   Previously each run was a row in the chat timeline, time-ordered
 *   alongside dialog bubbles. That worked for a single run but turned
 *   chatty when the agent fired off many short runs back-to-back — the
 *   conversation flow got hidden under run cards. Wrapping every run in
 *   one collapsible block keeps the message stream readable while still
 *   giving the operator one-click access to the underlying execution.
 *
 * Behaviour:
 *   • Collapsed by default. Click anywhere on the header to toggle.
 *   • Header summary: count + breakdown of statuses + the most-recent
 *     event line (auto-rotates every 2.5s while any run is in flight).
 *   • Expanded body: stacked LiveRunCards, newest first.
 */

export interface RunsAccordionProps {
  runs: LiveRun[];
  size: (base: number) => number;
  formatTime: (iso: string) => string;
}

const SPINNING = new Set<LiveRun['status']>(['queued', 'running']);

export function RunsAccordion({ runs, size, formatTime }: RunsAccordionProps) {
  const [open, setOpen] = useState(false);

  const inFlight = runs.filter((r) => SPINNING.has(r.status)).length;
  const succeeded = runs.filter((r) => r.status === 'succeeded').length;
  const failed = runs.filter(
    (r) => r.status === 'failed' || r.status === 'timed_out',
  ).length;

  // Pull the most-recent event across all in-flight runs for the rotating
  // summary line. When nothing is running, fall back to the very last
  // event we have on file so the operator still sees the final state.
  const latestEvents = runs
    .flatMap((r) => r.events.slice(-3))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const summaryPool = latestEvents.slice(-5);
  const [summaryIdx, setSummaryIdx] = useState(0);
  useEffect(() => {
    if (inFlight === 0 || summaryPool.length <= 1) return;
    const interval = setInterval(() => {
      setSummaryIdx((i) => (i + 1) % summaryPool.length);
    }, 2500);
    return () => clearInterval(interval);
  }, [inFlight, summaryPool.length]);
  useEffect(() => {
    setSummaryIdx(summaryPool.length > 0 ? summaryPool.length - 1 : 0);
  }, [summaryPool.length]);
  const summaryEvent = summaryPool[summaryIdx] ?? null;

  const headerColor =
    failed > 0 ? '#f87171' : inFlight > 0 ? '#60a5fa' : '#4ade80';

  return (
    <div
      style={{
        alignSelf: 'stretch',
        background: 'rgba(15,23,42,0.7)',
        border: `1px solid ${headerColor}55`,
        borderRadius: 10,
        overflow: 'hidden',
        // Guard against the parent flex column squeezing the accordion
        // to a sliver when content stress is high. The header alone is
        // ~40px; this minHeight makes it impossible for the accordion to
        // render as just the border line.
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
          color: '#e2e8f0',
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
            background: `${headerColor}22`,
            color: headerColor,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: size(13),
            flexShrink: 0,
            animation: inFlight > 0 ? 'pixel-pulse 1.4s ease-in-out infinite' : 'none',
          }}
        >
          ⚙
        </span>
        <span style={{ fontWeight: 700, color: '#f1f5f9', flexShrink: 0 }}>
          ריצות
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
          {runs.length}
        </span>
        {inFlight > 0 ? (
          <span
            style={{
              fontSize: size(10),
              fontWeight: 700,
              color: '#60a5fa',
              padding: '1px 6px',
              borderRadius: 999,
              background: 'rgba(59,130,246,0.18)',
              border: '1px solid rgba(96,165,250,0.4)',
              flexShrink: 0,
            }}
          >
            {inFlight} בעבודה
          </span>
        ) : null}
        {succeeded > 0 && inFlight === 0 ? (
          <span
            style={{
              fontSize: size(10),
              fontWeight: 700,
              color: '#4ade80',
              padding: '1px 6px',
              borderRadius: 999,
              background: 'rgba(34,197,94,0.15)',
              border: '1px solid rgba(74,222,128,0.4)',
              flexShrink: 0,
            }}
          >
            {succeeded} הצליחו
          </span>
        ) : null}
        {failed > 0 ? (
          <span
            style={{
              fontSize: size(10),
              fontWeight: 700,
              color: '#fca5a5',
              padding: '1px 6px',
              borderRadius: 999,
              background: 'rgba(220,38,38,0.18)',
              border: '1px solid rgba(248,113,113,0.4)',
              flexShrink: 0,
            }}
          >
            {failed} נכשלו
          </span>
        ) : null}

        {/* Rotating summary line — visible only when collapsed so it
            doesn't compete with the per-run transient lines inside. */}
        {!open && summaryEvent ? (
          <span
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: size(11),
              opacity: 0.85,
              overflow: 'hidden',
              marginInlineStart: 6,
            }}
            title={summaryEvent.message ?? summaryEvent.eventType}
          >
            <span aria-hidden style={{ flexShrink: 0 }}>💭</span>
            <span
              style={{
                fontWeight: 700,
                fontFamily:
                  'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                color: headerColor,
                flexShrink: 0,
              }}
            >
              {summaryEvent.eventType}
            </span>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: '#cbd5e1',
              }}
            >
              {summaryEvent.message ?? ''}
            </span>
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
          {/* Newest first — easier scan when many runs accumulate. */}
          {[...runs].reverse().map((run) => (
            <LiveRunCard
              key={run.runId}
              run={run}
              size={size}
              formatTime={formatTime}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
