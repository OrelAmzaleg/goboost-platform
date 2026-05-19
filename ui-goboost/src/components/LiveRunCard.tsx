import { useEffect, useState } from 'react';

import type { PaperclipHeartbeatEvent } from '../paperclipApi.js';

/**
 * LiveRunCard — Stream 4 / Primitive #7 from CHAT_PANEL_DESIGN.md.
 *
 * Renders an in-progress (or recently finished) agent heartbeat run as one
 * coherent block in the chat timeline. Each card aggregates a stream of
 * `heartbeat.run.event` events for a single runId — so the user sees:
 *
 *   ⚙ ריצה #12 · בעבודה · 14 שלבים
 *   > tool: query_brain · scan customers
 *   > tool: write_to_brain · save deal
 *   > lifecycle: queued
 *
 * Once the run terminates (status event with `succeeded`/`failed`/etc),
 * the header pill switches to the terminal label.
 *
 * Implementation note: this is a *projection* — we don't store run rows
 * server-side from the client. The aggregation is done in the chat panel
 * (see LiveRunsAggregator below) and a snapshot is passed in here.
 */

// Note: this type is re-imported by RunsAccordion.tsx which renders a
// stack of LiveRunCards inside one collapsible container.
export interface LiveRun {
  /** The runId from heartbeat.run.* events. */
  runId: string;
  agentId: string;
  /** Aggregated status — last seen, or 'running' by default. */
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
  /** First event timestamp — used for ordering in the timeline. */
  startedAt: string;
  /** Last event timestamp — used to derive "still going" indicator. */
  lastEventAt: string;
  /** Recent events, oldest first, capped to ~20 for display. */
  events: PaperclipHeartbeatEvent[];
}

const STATUS_META: Record<
  LiveRun['status'],
  { label: string; color: string; spinning: boolean }
> = {
  queued: { label: 'בתור', color: '#94a3b8', spinning: true },
  running: { label: 'בעבודה', color: '#3b82f6', spinning: true },
  succeeded: { label: 'הצליח', color: '#22c55e', spinning: false },
  failed: { label: 'נכשל', color: '#dc2626', spinning: false },
  cancelled: { label: 'בוטל', color: '#64748b', spinning: false },
  timed_out: { label: 'פג זמן', color: '#f59e0b', spinning: false },
};

export interface LiveRunCardProps {
  run: LiveRun;
  size: (base: number) => number;
  formatTime: (iso: string) => string;
  /** Optional short label for the run id (last 6 chars of UUID by default). */
  shortId?: string;
}

export function LiveRunCard({ run, size, formatTime, shortId }: LiveRunCardProps) {
  const meta = STATUS_META[run.status];
  const display = shortId ?? run.runId.slice(-6);
  const [expanded, setExpanded] = useState(meta.spinning);
  // Auto-collapse once a run finishes (after first render reveals the change).
  useEffect(() => {
    if (!meta.spinning) {
      const t = setTimeout(() => setExpanded(false), 1500);
      return () => clearTimeout(t);
    }
    return;
  }, [meta.spinning]);

  const visibleEvents = run.events.slice(-8);

  // Transient "thinking" line — rotates through the latest 5 events while
  // the run is still running. One line, swaps in place every 2.5s, mimics
  // the existing global thinking strip but scoped inside the card so the
  // operator always sees what the agent is doing right now without having
  // to expand the events list.
  const transientPool = run.events.slice(-5);
  const [transientIdx, setTransientIdx] = useState(0);
  useEffect(() => {
    if (!meta.spinning || transientPool.length <= 1) return;
    const interval = setInterval(() => {
      setTransientIdx((i) => (i + 1) % transientPool.length);
    }, 2500);
    return () => clearInterval(interval);
  }, [meta.spinning, transientPool.length]);
  // Always show the most-recent on new events (don't get stuck on an old idx).
  useEffect(() => {
    setTransientIdx(transientPool.length > 0 ? transientPool.length - 1 : 0);
  }, [run.events.length, transientPool.length]);
  const transientEvent = transientPool[transientIdx] ?? null;

  return (
    <div
      style={{
        alignSelf: 'stretch',
        background: 'rgba(15,23,42,0.7)',
        border: `1px solid ${meta.color}55`,
        borderRadius: 10,
        padding: '8px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        color: '#cbd5e1',
        fontSize: size(12),
        lineHeight: 1.5,
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          fontFamily: 'inherit',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            borderRadius: 6,
            background: `${meta.color}22`,
            color: meta.color,
            fontSize: size(13),
            animation: meta.spinning ? 'pixel-pulse 1.3s ease-in-out infinite' : 'none',
          }}
        >
          ⚙
        </span>
        <span style={{ fontWeight: 700, color: '#f1f5f9' }}>ריצה</span>
        <span
          style={{
            fontSize: size(10),
            fontWeight: 700,
            padding: '1px 6px',
            borderRadius: 4,
            background: 'rgba(0,0,0,0.25)',
            letterSpacing: 0.5,
          }}
        >
          {display}
        </span>
        <span
          style={{
            fontSize: size(11),
            fontWeight: 700,
            padding: '1px 8px',
            borderRadius: 999,
            background: `${meta.color}33`,
            color: meta.color,
            border: `1px solid ${meta.color}55`,
          }}
        >
          {meta.label}
        </span>
        <span style={{ marginInlineStart: 'auto', fontSize: size(10), opacity: 0.6 }}>
          {run.events.length} שלבים · {formatTime(run.lastEventAt)}
        </span>
        <span style={{ fontSize: size(10), opacity: 0.55 }}>{expanded ? '▲' : '▼'}</span>
      </button>

      {/* Transient "thinking" line — shown while the run is in flight, even
          when the events list is collapsed. Swaps through the last few
          events every 2.5s so the operator sees movement, not silence. */}
      {meta.spinning && transientEvent ? (
        <div
          key={`${transientEvent.runId}:${transientEvent.seq}`}
          title={transientEvent.message ?? transientEvent.eventType}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '2px 8px',
            background: `${meta.color}11`,
            border: `1px dashed ${meta.color}44`,
            borderRadius: 6,
            fontSize: size(11),
            color: meta.color,
            lineHeight: 1.4,
            animation: 'pixel-pulse 1.5s ease-in-out infinite',
          }}
        >
          <span aria-hidden style={{ flexShrink: 0 }}>💭</span>
          <span
            style={{
              fontWeight: 700,
              flexShrink: 0,
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            }}
          >
            {transientEvent.eventType}
            {transientEvent.level ? `·${transientEvent.level}` : ''}
          </span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              opacity: 0.95,
              color: '#e2e8f0',
            }}
          >
            {transientEvent.message ?? '—'}
          </span>
        </div>
      ) : null}

      {expanded && visibleEvents.length > 0 ? (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: size(11),
          }}
        >
          {visibleEvents.map((ev, i) => (
            <li
              key={`${ev.runId}:${ev.seq}:${i}`}
              style={{
                display: 'flex',
                gap: 6,
                opacity: 0.85,
                borderInlineStart: `2px solid ${meta.color}55`,
                paddingInlineStart: 8,
              }}
            >
              <span style={{ color: meta.color, fontWeight: 700, flexShrink: 0 }}>
                {ev.eventType}
                {ev.level ? `·${ev.level}` : ''}
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {ev.message ?? '—'}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ── Aggregator ─────────────────────────────────────────────────────────────
//
// Given a flat stream of PaperclipHeartbeatEvent, fold them into a Map<runId, LiveRun>.
// The chat panel feeds its `heartbeatEvents` state here whenever it
// rebuilds the timeline projection.

const TERMINAL_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

function deriveStatus(event: PaperclipHeartbeatEvent, prev: LiveRun['status']): LiveRun['status'] {
  // Status events carry the new status in `message` or `payload.status`.
  // Be defensive — different backends format this differently.
  const candidate =
    (event.payload && typeof event.payload === 'object'
      ? (event.payload as { status?: string }).status
      : null) ??
    (event.message && /^(queued|running|succeeded|failed|cancelled|timed_out)$/i.test(event.message)
      ? event.message
      : null);
  if (candidate && (TERMINAL_STATUSES.has(candidate) || candidate === 'queued' || candidate === 'running')) {
    return candidate as LiveRun['status'];
  }
  return prev;
}

export function aggregateRuns(events: PaperclipHeartbeatEvent[]): LiveRun[] {
  const byRun = new Map<string, LiveRun>();
  for (const ev of events) {
    if (!ev.runId) continue;
    const existing = byRun.get(ev.runId);
    if (existing) {
      existing.events.push(ev);
      existing.lastEventAt = ev.createdAt;
      existing.status = deriveStatus(ev, existing.status);
      if (existing.events.length > 30) {
        existing.events = existing.events.slice(existing.events.length - 30);
      }
    } else {
      byRun.set(ev.runId, {
        runId: ev.runId,
        agentId: ev.agentId,
        status: deriveStatus(ev, 'running'),
        startedAt: ev.createdAt,
        lastEventAt: ev.createdAt,
        events: [ev],
      });
    }
  }
  return Array.from(byRun.values()).sort((a, b) =>
    a.startedAt < b.startedAt ? -1 : 1,
  );
}
