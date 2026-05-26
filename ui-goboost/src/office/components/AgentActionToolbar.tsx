import { useEffect, useMemo, useState } from 'react';

import {
  fetchAgentById,
  fetchHeartbeatRun,
  fetchIssueById,
  pauseAgent,
  resumeAgent,
  subscribeActivity,
  subscribeRunStatus,
  uuidForNumericAgentId,
  wakeupAgent,
  type PaperclipAgentDetail,
  type PaperclipIssue,
} from '../../paperclipApi.js';
import {
  CHARACTER_SITTING_OFFSET_PX,
  TOOL_OVERLAY_VERTICAL_OFFSET,
} from '../../constants.js';
import type { OfficeState } from '../engine/officeState.js';
import { CharacterState, TILE_SIZE } from '../types.js';

// ── One-shot CSS keyframes injection ─────────────────────────────
// The toolbar's spin (Run button busy state) and pulse (LIVE pip)
// animations are pure CSS keyframes. We inject the @keyframes rules
// once at module load so the styled components can reference them by
// name. Module-level guard so HMR re-evaluation doesn't duplicate.
if (typeof document !== 'undefined') {
  const STYLE_ID = 'gb-agentaction-keyframes';
  if (!document.getElementById(STYLE_ID)) {
    const styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    styleEl.textContent = `
@keyframes gb-agentaction-spin {
  to { transform: rotate(360deg); }
}
@keyframes gb-agentaction-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(34,197,94,0.55); }
  70%  { box-shadow: 0 0 0 6px rgba(34,197,94,0); }
  100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); }
}
`;
    document.head.appendChild(styleEl);
  }
}

/**
 * AgentActionToolbar — floating cluster above the currently-selected
 * agent that combines identity (name + role) and quick actions.
 *
 * Session 4 rewrite:
 *   • Sizes scale with the office zoom level (range 1–10). At zoom 1
 *     the toolbar reads as a tiny chip; at zoom 10 it's a comfortable
 *     action bar. Linear interpolation with clamps.
 *   • Name + role chip now live INSIDE the toolbar (was a separate
 *     floating tag via ToolOverlay; that one still renders the
 *     activity strip below the character).
 *   • Heartbeat + Wakeup collapsed into one "⚡ הפעל" button — the
 *     research showed they're functionally the same (both create a
 *     heartbeat run); Wakeup is the modern endpoint with richer source
 *     tracking, so we use it under the hood.
 *   • Live-run tracking via `subscribeRunStatus`: while a run is open
 *     for the agent we (a) disable + spin the Run button, (b) render a
 *     pulsing LIVE pip next to the name, (c) reveal an ℹ button.
 *   • The ℹ button opens a small popover with the run's current issue
 *     (title + identifier) and a 📌 button that pins it to bookmarks.
 *
 * Buttons in RTL render order (right→left visually):
 *   ⚙ Settings   ⚡ Run   ⏸/▶ Pause/Resume   ➕ Assign   ℹ Info   ✕ Terminate
 */

interface AgentActionToolbarProps {
  officeState: OfficeState;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  onOpenSettings: (agentUuid: string, numericId: number) => void;
  onAssignTask: (agentUuid: string, numericId: number) => void;
  /**
   * Open the per-agent routines modal (🔁 button). The button replaced
   * the old ✕ Terminate at Session 7; Terminate now lives in the
   * Configuration tab's Danger Zone.
   */
  onOpenRoutines: (agentUuid: string, numericId: number) => void;
  /** Pin an issue to the project-bookmarks bar — used by the ℹ popover. */
  onPinIssue?: (issue: PaperclipIssue) => void;
}

interface ActiveRunInfo {
  runId: string;
  issueId: string | null;
}

export function AgentActionToolbar({
  officeState,
  containerRef,
  zoom,
  panRef,
  onOpenSettings,
  onAssignTask,
  onOpenRoutines,
  onPinIssue,
}: AgentActionToolbarProps) {
  // RAF tick so we track the agent's world-coords every frame (pan,
  // zoom, walk animation all move the character).
  const [, setTick] = useState(0);
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // The cluster renders for the selected agent OR for the currently
  // hovered one. When only hovered we show the identity row alone
  // (replaces pixel-agents' legacy hover container). When selected we
  // show identity + action buttons.
  const selectedId = officeState.selectedAgentId;
  const hoveredId = officeState.hoveredAgentId;
  const targetId = selectedId ?? hoveredId;
  const isSelected = selectedId != null && targetId === selectedId;
  const ch = targetId != null ? officeState.characters.get(targetId) : null;
  const agentUuid = targetId != null ? uuidForNumericAgentId(targetId) : null;

  // Agent record (status, name, role) — fetched + refreshed on agent.*.
  const [agent, setAgent] = useState<PaperclipAgentDetail | null>(null);
  const [actionInFlight, setActionInFlight] = useState<string | null>(null);
  // ⚡ Run button is multi-state: idle → fires Wakeup; live → second
  // click opens the run-info popover (which used to live on the 👁
  // button — now folded into ⚡ so the relationship is implicit).
  const [runInfoOpen, setRunInfoOpen] = useState(false);
  const [runInfoIssue, setRunInfoIssue] = useState<PaperclipIssue | null>(null);
  const [runInfoLoading, setRunInfoLoading] = useState(false);
  useEffect(() => {
    if (!agentUuid) {
      setAgent(null);
      return;
    }
    let cancelled = false;
    void fetchAgentById(agentUuid).then((a) => {
      if (!cancelled) setAgent(a);
    });
    const unsub = subscribeActivity((payload) => {
      const et = String(payload.entityType ?? '');
      const eid = String(payload.entityId ?? '');
      if (et !== 'agent' || eid !== agentUuid) return;
      void fetchAgentById(agentUuid).then((a) => {
        if (!cancelled) setAgent(a);
      });
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [agentUuid]);

  // Live-run tracker for THIS agent. We listen to `subscribeRunStatus`
  // (queued/running → add; terminal → remove). When a run becomes
  // active we also fetch the run record once to learn its `issueId` —
  // that's what the ℹ popover needs to surface the current task.
  const [activeRuns, setActiveRuns] = useState<Map<string, ActiveRunInfo>>(
    () => new Map(),
  );
  useEffect(() => {
    if (!agentUuid) {
      setActiveRuns(new Map());
      return;
    }
    const unsub = subscribeRunStatus((event) => {
      if (event.agentId !== agentUuid || !event.runId) return;
      const terminal = ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(
        event.kind,
      );
      if (terminal) {
        setActiveRuns((prev) => {
          if (!prev.has(event.runId)) return prev;
          const next = new Map(prev);
          next.delete(event.runId);
          return next;
        });
        return;
      }
      // queued or running — fold in. Fetch the run info once to learn
      // which issue it's working on.
      setActiveRuns((prev) => {
        if (prev.has(event.runId)) return prev;
        const next = new Map(prev);
        next.set(event.runId, { runId: event.runId, issueId: null });
        return next;
      });
      void fetchHeartbeatRun(event.runId).then((run) => {
        if (!run) return;
        setActiveRuns((prev) => {
          const cur = prev.get(event.runId);
          if (!cur) return prev; // already terminal — don't add back
          const next = new Map(prev);
          next.set(event.runId, {
            runId: event.runId,
            issueId: run.issueId ?? null,
          });
          return next;
        });
      });
    });
    return () => unsub();
  }, [agentUuid]);

  const isLive = activeRuns.size > 0;
  // Most recent active run — used to drive the run-info popover. (We
  // don't track ordering yet so "most recent" = first map entry which
  // is typically insertion-order.)
  const currentRun = useMemo<ActiveRunInfo | null>(() => {
    if (activeRuns.size === 0) return null;
    // Prefer a run with a known issueId for the popover.
    for (const r of activeRuns.values()) {
      if (r.issueId) return r;
    }
    return activeRuns.values().next().value ?? null;
  }, [activeRuns]);

  // Auto-close the run-info popover the moment the run finishes
  // (otherwise it'd linger with stale data after Wakeup returns).
  useEffect(() => {
    if (!isLive && runInfoOpen) {
      setRunInfoOpen(false);
      setRunInfoIssue(null);
    }
  }, [isLive, runInfoOpen]);

  // Lazy-fetch the issue when the popover opens. Skipped if the run
  // hasn't surfaced an issueId yet (the user just gets a "loading…"
  // line until the heartbeat-run record comes back).
  useEffect(() => {
    if (!runInfoOpen) return;
    if (!currentRun?.issueId) {
      setRunInfoIssue(null);
      return;
    }
    let cancelled = false;
    setRunInfoLoading(true);
    void fetchIssueById(currentRun.issueId).then((iss) => {
      if (cancelled) return;
      setRunInfoIssue(iss);
      setRunInfoLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [runInfoOpen, currentRun?.issueId]);

  // ── Zoom-responsive sizing ───────────────────────────────────────
  // Office zoom ranges 1..10. We linearly interpolate sizes within
  // sensible clamps so the cluster never disappears at zoom 1 nor
  // dwarfs the character at zoom 10.
  const clamp = (n: number, lo: number, hi: number) =>
    Math.round(Math.max(lo, Math.min(hi, n)));
  const buttonSize = clamp(14 + zoom * 1.8, 18, 32);
  const iconFontSize = clamp(9 + zoom * 0.8, 10, 17);
  // Identity row typography (round 2): pushed higher so the name is
  // comfortably readable even at zoom 1. Range 14-19, weight 500.
  const nameFontSize = clamp(12 + zoom * 0.8, 14, 19);
  const padBlock = clamp(3 + zoom * 0.4, 4, 8);
  const padInline = clamp(5 + zoom * 0.6, 6, 11);
  const gap = clamp(2 + zoom * 0.2, 3, 5);
  const radius = clamp(8 + zoom * 0.5, 10, 16);

  // Identity row geometry — derived so the row scales with the name.
  const statusDotSize = clamp(Math.round(nameFontSize * 0.65), 8, 13);
  const dotGap = clamp(Math.round(nameFontSize * 0.5), 6, 10);
  const identityPadBlock = clamp(Math.round(padBlock + 1), 5, 9);
  const identityPadInline = clamp(Math.round(padInline + 3), 9, 14);

  // ── Early-out guards (after hooks, to keep hook order stable) ────
  if (targetId == null || !ch || !agentUuid) return null;
  if (ch.isSubagent) return null;
  if (ch.matrixEffect === 'despawn') return null;
  // Session 9.3: scope filter faded this agent out — no toolbar.
  // Threshold matches the sprite-drop cutoff in renderer.ts.
  if (ch.displayAlpha <= 0.02) return null;

  const el = containerRef.current;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const canvasW = Math.round(rect.width * dpr);
  const canvasH = Math.round(rect.height * dpr);
  const layout = officeState.getLayout();
  const mapW = layout.cols * TILE_SIZE * zoom;
  const mapH = layout.rows * TILE_SIZE * zoom;
  const deviceOffsetX = Math.floor((canvasW - mapW) / 2) + Math.round(panRef.current.x);
  const deviceOffsetY = Math.floor((canvasH - mapH) / 2) + Math.round(panRef.current.y);

  const sittingOffset =
    ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
  const screenX = (deviceOffsetX + ch.x * zoom) / dpr;
  // Anchor above the ToolOverlay's vertical offset so the two layers
  // stack cleanly without overlap.
  const verticalAnchor =
    (deviceOffsetY +
      (ch.y + sittingOffset - TOOL_OVERLAY_VERTICAL_OFFSET) * zoom) /
    dpr -
    clamp(20 + zoom * 1.5, 22, 36);

  const isPaused = agent?.status === 'paused';

  const runAction = async (
    key: string,
    fn: () => Promise<boolean>,
    successHint?: string,
  ) => {
    if (actionInFlight) return;
    setActionInFlight(key);
    const ok = await fn();
    setActionInFlight(null);
    if (!ok && successHint) {
      window.alert(`הפעולה "${successHint}" נכשלה. בדוק את החיבור.`);
    }
  };

  // Session 7: ✕ Terminate moved to AgentManagementModal → Configuration
  // → Danger Zone. The destructive action sat too close to the
  // everyday buttons (Run, Pause, Assign) and an accidental click was
  // too easy. The toolbar now has 🔁 Routines in its place.

  const displayName = agent?.name ?? '…';

  return (
    <div
      dir="rtl"
      style={{
        position: 'absolute',
        left: screenX,
        top: verticalAnchor,
        transform: 'translate(-50%, -100%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 3,
        pointerEvents: 'auto',
        zIndex: 50,
        fontFamily: "'Heebo', system-ui, sans-serif",
        minWidth: 0,
      }}
    >
      {/* Identity row — [status dot] | [agent name].
          Role chip removed (operator review): it's already visible in
          the AgentManagementModal and was adding visual weight here.
          The status dot doubles as the LIVE indicator — green & pulsing
          when a run is open, color reflects Paperclip's agent status
          enum otherwise. */}
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: dotGap,
          padding: `${identityPadBlock}px ${identityPadInline}px`,
          background: 'rgba(15, 23, 42, 0.92)',
          border: '1px solid rgba(255, 255, 255, 0.18)',
          borderRadius: radius,
          color: '#fff',
          alignSelf: 'center',
          maxWidth: 340,
        }}
      >
        <StatusDot
          status={agent?.status}
          live={isLive}
          size={statusDotSize}
        />
        {/* Thin separator between dot and name — same color family as
            the container border. */}
        <span
          aria-hidden
          style={{
            width: 1,
            height: Math.round(nameFontSize * 0.9),
            background: 'rgba(255,255,255,0.22)',
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: nameFontSize,
            // 500 (medium) so Heebo doesn't muddy small sizes.
            fontWeight: 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            letterSpacing: 0.1,
          }}
          title={displayName}
        >
          {displayName}
        </span>
      </div>

      {/* Action row — selected only. Hover keeps just the identity. */}
      {isSelected ? (
        <div
          style={{
            display: 'inline-flex',
            gap,
            padding: `${padBlock}px ${padInline}px`,
            background: 'rgba(15, 23, 42, 0.92)',
            border: '1px solid rgba(255, 255, 255, 0.18)',
            borderRadius: 999,
            boxShadow: '0 4px 14px rgba(0,0,0,0.4)',
            alignSelf: 'center',
            alignItems: 'center',
          }}
        >
          <ToolbarButton
            title="הגדרות"
            icon="⚙"
            size={buttonSize}
            iconSize={iconFontSize}
            disabled={actionInFlight === 'settings'}
            onClick={() => onOpenSettings(agentUuid, targetId)}
          />
          {/* ⚡ Run — multi-state button.
                idle: single click fires Wakeup.
                live: spinning ring + `?` cursor hint on hover;
                      single click toggles the run-info popover.
              No separate 👁 button — the affordance is on ⚡ itself,
              so the "child" relationship is intrinsic. */}
          <div style={{ position: 'relative', display: 'inline-flex' }}>
            <ToolbarButton
              title={
                isLive
                  ? 'הסוכן עובד עכשיו — לחץ לראות על מה'
                  : 'הפעל סוכן (Run)'
              }
              icon="⚡"
              size={buttonSize}
              iconSize={iconFontSize}
              accent="green"
              // Only disabled while the Wakeup REST call is mid-flight
              // (so we don't double-fire) or the agent is paused. Live
              // doesn't disable — that's the whole point of the second
              // click semantics.
              disabled={isPaused || actionInFlight === 'wakeup'}
              spinning={isLive || actionInFlight === 'wakeup'}
              helpCursor={isLive}
              onClick={() => {
                if (isLive) {
                  setRunInfoOpen((o) => !o);
                  return;
                }
                void runAction(
                  'wakeup',
                  () => wakeupAgent(agentUuid),
                  'הפעלת סוכן',
                );
              }}
            />
            {isLive && runInfoOpen ? (
              <RunInfoPopover
                run={currentRun}
                issue={runInfoIssue}
                loading={runInfoLoading}
                onPinIssue={onPinIssue}
                onClose={() => setRunInfoOpen(false)}
              />
            ) : null}
          </div>
          <ToolbarButton
            title={isPaused ? 'המשך פעילות' : 'השהה'}
            icon={isPaused ? '▶' : '⏸'}
            size={buttonSize}
            iconSize={iconFontSize}
            accent={isPaused ? 'green' : 'amber'}
            disabled={actionInFlight === 'pause' || actionInFlight === 'resume'}
            onClick={() =>
              isPaused
                ? runAction('resume', () => resumeAgent(agentUuid), 'המשך פעילות')
                : runAction('pause', () => pauseAgent(agentUuid), 'השהיה')
            }
          />
          <ToolbarButton
            title="הקצה משימה חדשה"
            icon="➕"
            size={buttonSize}
            iconSize={iconFontSize}
            accent="green"
            onClick={() => onAssignTask(agentUuid, targetId)}
          />
          {/* 🔁 Routines — opens the per-agent RoutinesModal. Replaces
              the ✕ Terminate that used to sit here (now relocated to
              Configuration → Danger Zone). */}
          <ToolbarButton
            title="רוטינות"
            icon="🔁"
            size={buttonSize}
            iconSize={iconFontSize}
            onClick={() => onOpenRoutines(agentUuid, targetId)}
          />
        </div>
      ) : null}
    </div>
  );
}

// ── Single toolbar button ────────────────────────────────────────

function ToolbarButton({
  title,
  icon,
  size,
  iconSize,
  onClick,
  disabled,
  accent,
  spinning,
  helpCursor,
}: {
  title: string;
  icon: string;
  size: number;
  iconSize: number;
  onClick: () => void;
  disabled?: boolean;
  accent?: 'green' | 'amber' | 'red';
  /** Show a rotating ring overlay (used by ⚡ while a run is open). */
  spinning?: boolean;
  /**
   * Render with the native `?` cursor on hover — used by the ⚡ button
   * once it transitions into "live" mode, hinting "click again to see
   * what I'm doing".
   */
  helpCursor?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const accentColors: Record<NonNullable<typeof accent>, string> = {
    green: 'rgba(34,197,94,0.32)',
    amber: 'rgba(245,158,11,0.32)',
    red: 'rgba(239,68,68,0.32)',
  };
  const baseBg = accent ? accentColors[accent] : 'rgba(255,255,255,0.08)';
  const hoverBg = accent ? accentColors[accent] : 'rgba(255,255,255,0.18)';
  const cursor = disabled ? 'not-allowed' : helpCursor ? 'help' : 'pointer';
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        width: size,
        height: size,
        borderRadius: 999,
        border: '1px solid rgba(255,255,255,0.18)',
        background: hover && !disabled ? hoverBg : baseBg,
        color: '#fff',
        cursor,
        opacity: disabled && !spinning ? 0.5 : 1,
        fontSize: iconSize,
        lineHeight: 1,
        padding: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'inherit',
        overflow: 'hidden',
      }}
    >
      {icon}
      {spinning ? <SpinningRing size={size} /> : null}
    </button>
  );
}

// ── Spinning ring (CSS-only, no SVG, no dependencies) ────────────

function SpinningRing({ size }: { size: number }) {
  return (
    <span
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        borderRadius: 999,
        border: `2px solid transparent`,
        borderTopColor: 'rgba(255,255,255,0.95)',
        borderInlineEndColor: 'rgba(255,255,255,0.55)',
        animation: 'gb-agentaction-spin 1.2s linear infinite',
        width: size,
        height: size,
        boxSizing: 'border-box',
      }}
    />
  );
}

// ── Status dot — color reflects Paperclip agent status ──────────
//
// Mapping mirrors the enum from the backend: active/running → green,
// idle → slate, paused → amber, error → red, pending_approval → purple,
// terminated → dark slate. When the agent has an open run we pulse the
// dot (same keyframe as the old LIVE pip).

const STATUS_DOT_COLOR: Record<string, string> = {
  active: '#22c55e',
  running: '#22c55e',
  idle: '#94a3b8',
  paused: '#f59e0b',
  error: '#ef4444',
  pending_approval: '#a855f7',
  terminated: '#475569',
};

function statusDotColor(status: string | null | undefined): string {
  if (!status) return '#64748b';
  return STATUS_DOT_COLOR[status] ?? '#64748b';
}

function StatusDot({ status, live, size }: { status: string | null | undefined; live: boolean; size: number }) {
  const color = statusDotColor(status);
  return (
    <span
      aria-label={status ?? 'unknown'}
      title={status ?? ''}
      style={{
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        boxShadow: live ? '0 0 0 0 rgba(34,197,94,0.55)' : 'none',
        animation: live ? 'gb-agentaction-pulse 1.4s ease-out infinite' : 'none',
      }}
    />
  );
}

// ── Run-info popover — pure presentation under the ⚡ button ─────
//
// State (open/closed, issue, loading) is owned by the parent toolbar
// so a single source of truth controls "is the popover visible". The
// popover itself just renders what it's handed and emits the pin /
// close intents.

function RunInfoPopover({
  run,
  issue,
  loading,
  onPinIssue,
  onClose,
}: {
  run: ActiveRunInfo | null;
  issue: PaperclipIssue | null;
  loading: boolean;
  onPinIssue?: (issue: PaperclipIssue) => void;
  onClose: () => void;
}) {
  return (
    <div
      // Stop the canvas click handler from un-selecting the agent
      // when the operator interacts with the popover body.
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        top: '100%',
        // Align under ⚡; small overhang on the inline-end gives the
        // popover room to breathe over neighboring buttons.
        insetInlineEnd: -8,
        marginBlockStart: 8,
        minWidth: 280,
        maxWidth: 360,
        padding: 14,
        background: '#1e293b',
        border: '1px solid rgba(255,255,255,0.18)',
        borderRadius: 12,
        boxShadow: '0 10px 26px rgba(0,0,0,0.6)',
        zIndex: 60,
        color: '#e2e8f0',
        fontFamily: 'inherit',
        fontSize: 13,
        lineHeight: 1.45,
      }}
    >
      {!run ? (
        <div style={{ color: '#94a3b8' }}>אין ריצה פעילה.</div>
      ) : loading ? (
        <div style={{ color: '#94a3b8' }}>טוען פרטי משימה…</div>
      ) : !issue ? (
        <div style={{ color: '#94a3b8' }}>
          ריצה {run.runId.slice(0, 8)}… (אין משימה מקושרת)
        </div>
      ) : (
        <>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: '#94a3b8',
              marginBlockEnd: 6,
              display: 'flex',
              gap: 6,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <span
              style={{
                background: 'rgba(0,0,0,0.4)',
                padding: '2px 8px',
                borderRadius: 4,
                fontFamily:
                  "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
                color: '#cbd5e1',
              }}
            >
              {issue.identifier ?? '—'}
            </span>
            <span style={{ opacity: 0.75 }}>· עובד עכשיו</span>
          </div>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: '#f1f5f9',
              marginBlockEnd: 12,
              lineHeight: 1.4,
            }}
          >
            {issue.title}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            {onPinIssue ? (
              <button
                type="button"
                onClick={() => {
                  onPinIssue(issue);
                  onClose();
                }}
                title="נעץ את המשימה לסרגל הסימניות"
                style={{
                  padding: '6px 12px',
                  borderRadius: 7,
                  border: '1px solid rgba(99,102,241,0.55)',
                  background: 'rgba(99,102,241,0.28)',
                  color: '#e0e7ff',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                📌 נעץ
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
