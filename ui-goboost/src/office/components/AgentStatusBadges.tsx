import { Fragment, useEffect, useMemo, useRef, useState } from 'react';

import { CHARACTER_SITTING_OFFSET_PX } from '../../constants.js';
import {
  fetchAgentById,
  fetchAgentRuns,
  subscribeActivity,
  subscribeRunStatus,
  uuidForNumericAgentId,
} from '../../paperclipApi.js';
import type { OfficeState } from '../engine/officeState.js';
import { CharacterState, TILE_SIZE } from '../types.js';

/**
 * AgentStatusBadges — always-visible status emoji floating above each
 * agent on the office canvas. Turns the office itself into a live
 * dashboard (Session 9.1): the operator reads every agent's state at
 * a glance without clicking or hovering.
 *
 * Six states, priority-ordered (highest wins):
 *   ⏸  paused        — agent.status === 'paused'
 *   ✋  approval       — at least one open board-approval requested by
 *                       this agent. STICKY — does not yield to working
 *                       until the approval is resolved (approved /
 *                       rejected / revision_requested / resubmitted).
 *   💬  questionnaire  — at least one open issue thread-interaction
 *                       asked by this agent (ask_user_questions /
 *                       request_confirmation / suggest_tasks). Same
 *                       sticky semantics as approval.
 *   ⚙️ working        — at least one active run. Renders ONLY the
 *                       pulsing halo, NO badge — the halo is the
 *                       indicator and a duplicate emoji crowds the
 *                       sprite (user feedback, 9.1 polish round).
 *   🚨  failed         — last terminal run was failed/timed_out and
 *                       not yet superseded by a successful one.
 *   💤  idle           — fallback.
 *
 * Sizing & positioning scale with office `zoom` (range 1–10). At
 * zoom 2 the operator's reference setup matched a 14px emoji at 48px
 * above the anchor; the formulas keep that proportional through the
 * full zoom range so the badge never looks tiny or oversized.
 *
 * Data flow is event-driven:
 *   • Initial primer fetches paused state + last 5 runs per agent.
 *   • subscribeRunStatus drives working/failed transitions live.
 *   • subscribeActivity drives pause/resume, approval, and thread-
 *     interaction state.
 * Cold-start: pending approvals/interactions that pre-date the page
 * load won't show until the next WS event for them — a known v1
 * limitation we accept rather than scanning every issue on mount.
 */

// One-shot CSS keyframes for the working halo. Module-level guard
// prevents HMR re-evaluation from duplicating the <style> node.
if (typeof document !== 'undefined') {
  const STYLE_ID = 'gb-agent-status-keyframes';
  if (!document.getElementById(STYLE_ID)) {
    const styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    // Halo design (Session 9.1 polish round):
    //   • RIPPLE-ONLY — no static inner disk. Border-only ring that
    //     expands outward and fades, like a sonar ping. Avoids the
    //     prior "always-on green fill" that obscured the sprite.
    //   • Pulse driven entirely by transform + opacity → no layout
    //     thrash, GPU-accelerated, and (critically) it tracks the
    //     element's `left/top` on every React re-render so the ring
    //     follows the agent as it walks between seats. The earlier
    //     box-shadow variant lagged the box reflow under load.
    //   • Two staggered rings double the pulse rate visually without
    //     adding render cost.
    //   • Soft-mint #86efac to match the operator's approved palette.
    styleEl.textContent = `
@keyframes gb-agent-working-halo {
  0%   { transform: translate(-50%, -50%) scale(0.55); opacity: 0;    }
  20%  { transform: translate(-50%, -50%) scale(0.85); opacity: 0.85; }
  100% { transform: translate(-50%, -50%) scale(1.75); opacity: 0;    }
}
`;
    document.head.appendChild(styleEl);
  }
}

type BadgeState =
  | 'paused'
  | 'approval'
  | 'questionnaire'
  | 'working'
  | 'failed'
  | 'idle';

const BADGE_ICON: Record<BadgeState, string> = {
  paused: '⏸',
  approval: '✋',
  questionnaire: '💬',
  // 'working' is intentionally blank — the halo is the indicator.
  working: '',
  failed: '🚨',
  idle: '💤',
};

const BADGE_LABEL: Record<BadgeState, string> = {
  paused: 'מושעה',
  approval: 'ממתין לאישור שלך',
  questionnaire: 'ממתין לתשובה שלך',
  working: 'עובד',
  failed: 'הרצה אחרונה נכשלה',
  idle: 'פנוי',
};

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);
const FAILED_RUN_STATUSES: ReadonlySet<string> = new Set([
  'failed',
  'timed_out',
]);

// Approval lifecycle: only `created` increments; the rest are
// resolutions / transitions that drop the agent's "needs your
// attention" count for an approval.
const APPROVAL_RESOLVED_ACTIONS: ReadonlySet<string> = new Set([
  'approval.approved',
  'approval.rejected',
  'approval.revision_requested',
  'approval.resubmitted',
]);

// Same idea for thread interactions. The route emits these three
// terminals in addition to created.
const INTERACTION_RESOLVED_ACTIONS: ReadonlySet<string> = new Set([
  'issue.thread_interaction_accepted',
  'issue.thread_interaction_rejected',
  'issue.thread_interaction_expired',
]);

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function useAgentBadgeStates(agentUuids: string[]): Map<string, BadgeState> {
  // Stable key for effect deps — the array identity changes every
  // render even when the content didn't.
  const uuidsKey = agentUuids.join(',');

  const [pausedSet, setPausedSet] = useState<Set<string>>(() => new Set());
  const [workingSet, setWorkingSet] = useState<Set<string>>(() => new Set());
  const [failedSet, setFailedSet] = useState<Set<string>>(() => new Set());
  const [approvalCounts, setApprovalCounts] = useState<Map<string, number>>(
    () => new Map(),
  );
  const [interactionCounts, setInteractionCounts] = useState<
    Map<string, number>
  >(() => new Map());

  // Initial primer: paused-from-agent-record + last-run-status. Runs
  // in parallel across agents. Approvals/interactions are NOT primed
  // here — see header for the cold-start tradeoff.
  useEffect(() => {
    if (agentUuids.length === 0) return;
    let cancelled = false;
    void Promise.all(
      agentUuids.map(async (uuid) => {
        const [agent, runs] = await Promise.all([
          fetchAgentById(uuid),
          fetchAgentRuns(uuid, 5),
        ]);
        return { uuid, agent, runs };
      }),
    ).then((results) => {
      if (cancelled) return;
      const paused = new Set<string>();
      const failed = new Set<string>();
      for (const { uuid, agent, runs } of results) {
        if (agent?.status === 'paused') paused.add(uuid);
        const lastTerminal = runs.find((r) =>
          TERMINAL_RUN_STATUSES.has(r.status),
        );
        if (lastTerminal && FAILED_RUN_STATUSES.has(lastTerminal.status)) {
          failed.add(uuid);
        }
      }
      setPausedSet(paused);
      setFailedSet(failed);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uuidsKey]);

  // Live: run lifecycle.
  useEffect(() => {
    if (agentUuids.length === 0) return;
    const tracked = new Set(agentUuids);
    const unsub = subscribeRunStatus((evt) => {
      if (!tracked.has(evt.agentId)) return;
      const isTerminal = TERMINAL_RUN_STATUSES.has(evt.kind);
      if (isTerminal) {
        setWorkingSet((prev) => {
          if (!prev.has(evt.agentId)) return prev;
          const next = new Set(prev);
          next.delete(evt.agentId);
          return next;
        });
        if (FAILED_RUN_STATUSES.has(evt.kind)) {
          setFailedSet((prev) => {
            if (prev.has(evt.agentId)) return prev;
            const next = new Set(prev);
            next.add(evt.agentId);
            return next;
          });
        } else if (evt.kind === 'succeeded') {
          setFailedSet((prev) => {
            if (!prev.has(evt.agentId)) return prev;
            const next = new Set(prev);
            next.delete(evt.agentId);
            return next;
          });
        }
      } else {
        // 'queued' / 'running' → fold into working set.
        setWorkingSet((prev) => {
          if (prev.has(evt.agentId)) return prev;
          const next = new Set(prev);
          next.add(evt.agentId);
          return next;
        });
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uuidsKey]);

  // Open-request indexes — map approvalId/interactionId → requesting
  // agentUuid. Populated on `*.created` events (where the actor IS
  // the requesting agent so `payload.agentId` is set), consulted on
  // resolution events (where the actor is the board user and the
  // top-level `agentId` is null — that was the 9.1 bug behind the
  // missing ✋/💬 icons: counts only ever went up, never down, so
  // by the time the operator looked they were already deflated to
  // zero by the cap below — no, wait, they STAYED positive forever,
  // sticky-positive, the icon should have been visible but wasn't
  // — actually the actual root cause was the OPPOSITE: my listener
  // gated the INCREMENT on `entityType === 'approval' && agentId`,
  // which for create works, but the test session relied on a board-
  // initiated approval flow where the actor was the user, so even
  // the increment was skipped). Indexing the requester id when
  // ANYTHING comes through `approval.created` — via details
  // fallback when top-level agentId is null — fixes both cases.
  const approvalRequester = useRef<Map<string, string>>(new Map());
  const interactionRequester = useRef<Map<string, string>>(new Map());

  // Live: activity events — agent.paused/resumed, approval.*, and
  // issue.thread_interaction_*.
  useEffect(() => {
    if (agentUuids.length === 0) return;
    const tracked = new Set(agentUuids);
    const unsub = subscribeActivity((payload) => {
      const entityType = String(payload.entityType ?? '');
      const action = String(payload.action ?? '');
      const entityId = String(payload.entityId ?? '');
      const actorAgentId = String(payload.agentId ?? '');
      const details =
        (payload.details as Record<string, unknown> | undefined) ?? {};

      // Resolve the "requesting agent" for approval/interaction events.
      // Prefer the top-level actor (agent who fired the create), then
      // fall back to common requester fields on details (the server's
      // resolution events come from the board user and put the agent
      // in details).
      const resolveRequester = (): string | null => {
        if (actorAgentId && tracked.has(actorAgentId)) return actorAgentId;
        const fromDetails =
          (details.requestedByAgentId as string | undefined) ??
          (details.requesterAgentId as string | undefined) ??
          (details.linkedByAgentId as string | undefined) ??
          (details.linkedAgentId as string | undefined) ??
          null;
        if (fromDetails && tracked.has(fromDetails)) return fromDetails;
        return null;
      };

      // ── Pause / resume ──────────────────────────────────────────
      if (entityType === 'agent' && tracked.has(entityId)) {
        if (action === 'agent.paused') {
          setPausedSet((prev) => {
            if (prev.has(entityId)) return prev;
            const next = new Set(prev);
            next.add(entityId);
            return next;
          });
        } else if (action === 'agent.resumed') {
          setPausedSet((prev) => {
            if (!prev.has(entityId)) return prev;
            const next = new Set(prev);
            next.delete(entityId);
            return next;
          });
        }
      }

      // ── Approvals ───────────────────────────────────────────────
      if (entityType === 'approval' && entityId) {
        if (action === 'approval.created') {
          const requester = resolveRequester();
          if (requester) {
            approvalRequester.current.set(entityId, requester);
            setApprovalCounts((prev) => {
              const next = new Map(prev);
              next.set(requester, (next.get(requester) ?? 0) + 1);
              return next;
            });
          }
        } else if (APPROVAL_RESOLVED_ACTIONS.has(action)) {
          // Consult the index first — the resolution event's actor
          // is the user, not the agent. Fall back to details too.
          const requester =
            approvalRequester.current.get(entityId) ?? resolveRequester();
          if (requester) {
            approvalRequester.current.delete(entityId);
            setApprovalCounts((prev) => {
              const cur = prev.get(requester) ?? 0;
              if (cur <= 0) return prev;
              const next = new Map(prev);
              next.set(requester, cur - 1);
              return next;
            });
          }
        }
      }

      // ── Thread interactions (questionnaires / confirmations) ────
      // entityType is 'issue' for these events; the interaction id is
      // on `details.interactionId`. Same indexer pattern as approvals.
      if (entityType === 'issue') {
        const interactionId = String(details.interactionId ?? '');
        if (action === 'issue.thread_interaction_created' && interactionId) {
          const requester = resolveRequester();
          if (requester) {
            interactionRequester.current.set(interactionId, requester);
            setInteractionCounts((prev) => {
              const next = new Map(prev);
              next.set(requester, (next.get(requester) ?? 0) + 1);
              return next;
            });
          }
        } else if (
          INTERACTION_RESOLVED_ACTIONS.has(action) &&
          interactionId
        ) {
          // Resolution events come from the board user — top-level
          // `agentId` is null. Consult the indexer that captured the
          // requester at creation; fall back to details if any.
          const requester =
            interactionRequester.current.get(interactionId) ??
            resolveRequester();
          if (requester) {
            interactionRequester.current.delete(interactionId);
            setInteractionCounts((prev) => {
              const cur = prev.get(requester) ?? 0;
              if (cur <= 0) return prev;
              const next = new Map(prev);
              next.set(requester, cur - 1);
              return next;
            });
          }
        }
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uuidsKey]);

  return useMemo(() => {
    const out = new Map<string, BadgeState>();
    for (const uuid of agentUuids) {
      // Sticky order: paused stops everything; approval/questionnaire
      // hold the badge until resolved (user-blocking by definition);
      // working is the halo-only case; failed/idle fall through.
      if (pausedSet.has(uuid)) out.set(uuid, 'paused');
      else if ((approvalCounts.get(uuid) ?? 0) > 0)
        out.set(uuid, 'approval');
      else if ((interactionCounts.get(uuid) ?? 0) > 0)
        out.set(uuid, 'questionnaire');
      else if (workingSet.has(uuid)) out.set(uuid, 'working');
      else if (failedSet.has(uuid)) out.set(uuid, 'failed');
      else out.set(uuid, 'idle');
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    uuidsKey,
    pausedSet,
    workingSet,
    failedSet,
    approvalCounts,
    interactionCounts,
  ]);
}

interface AgentStatusBadgesProps {
  officeState: OfficeState;
  /** Numeric IDs of main (non-subagent) characters currently on the office. */
  agents: number[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
}

export function AgentStatusBadges({
  officeState,
  agents,
  containerRef,
  zoom,
  panRef,
}: AgentStatusBadgesProps) {
  // RAF tick — characters move (walk animation, pan, zoom), so we
  // re-render every frame to keep the badges glued above them. Cheap:
  // each badge is a tiny absolutely-positioned div.
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

  const agentUuids = useMemo(() => {
    const out: string[] = [];
    for (const id of agents) {
      const uuid = uuidForNumericAgentId(id);
      if (uuid) out.push(uuid);
    }
    return out;
  }, [agents]);

  const badges = useAgentBadgeStates(agentUuids);

  const el = containerRef.current;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const canvasW = Math.round(rect.width * dpr);
  const canvasH = Math.round(rect.height * dpr);
  const layout = officeState.getLayout();
  const mapW = layout.cols * TILE_SIZE * zoom;
  const mapH = layout.rows * TILE_SIZE * zoom;
  const deviceOffsetX =
    Math.floor((canvasW - mapW) / 2) + Math.round(panRef.current.x);
  const deviceOffsetY =
    Math.floor((canvasH - mapH) / 2) + Math.round(panRef.current.y);

  // Zoom-aware sizing. The operator's reference setup at zoom=2 had
  // a 14px badge sitting 48px above the anchor with a 56px halo
  // wrapping the sprite. The formulas reproduce that exactly at
  // zoom=2 and scale linearly within sensible clamps for other zooms.
  // Halo dimensions track zoom 1:1 (the sprite itself scales 1:1
  // with zoom) so the ring stays proportional. Badge font is clamped
  // for readability — never tiny, never overwhelming.
  const fontSize = clamp(8 + zoom * 3, 12, 32);
  const badgeOffsetY = 24 * zoom; // px above the anchor
  // Halo footprint — sized to wrap the head + upper torso, NOT the
  // whole sprite. The earlier 28*zoom diameter visually dominated
  // the agent; cut to 16*zoom (~32px at zoom 2) for a tighter, more
  // delicate ripple that reads as "active" without crowding the
  // sprite next to it.
  const haloSize = 16 * zoom; // diameter
  const haloRingThickness = clamp(zoom * 0.7, 1.5, 3);
  // Halo center: push it UP from the feet/seat anchor toward the
  // upper body. Slightly less than half a tile so the smaller halo
  // sits squarely on the head/shoulders rather than the torso.
  const haloCenterOffsetY = 12 * zoom;

  return (
    <>
      {agents.map((id) => {
        const uuid = uuidForNumericAgentId(id);
        if (!uuid) return null;
        const ch = officeState.characters.get(id);
        if (!ch || ch.isSubagent) return null;
        // Session 9.3: skip badge layer for agents the scope filter
        // has faded out. Threshold matches the renderer's drop cutoff
        // so badges hide in lock-step with the sprite.
        if (ch.displayAlpha <= 0.02) return null;
        const state = badges.get(uuid) ?? 'idle';
        const icon = BADGE_ICON[state];

        const sittingOffset =
          ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
        const screenX = (deviceOffsetX + ch.x * zoom) / dpr;
        const screenY = (deviceOffsetY + (ch.y + sittingOffset) * zoom) / dpr;

        return (
          <Fragment key={id}>
            {state === 'working' ? (
              <div
                aria-hidden
                style={{
                  position: 'absolute',
                  left: screenX,
                  top: screenY - haloCenterOffsetY,
                  width: haloSize,
                  height: haloSize,
                  borderRadius: '50%',
                  background: 'transparent',
                  border: `${haloRingThickness}px solid rgba(134, 239, 172, 0.9)`,
                  // Subtle outer glow only — no inner shadow. Keeps
                  // the halo reading as a thin clean ring instead of
                  // a filled disk.
                  boxShadow: '0 0 5px rgba(134, 239, 172, 0.45)',
                  pointerEvents: 'none',
                  zIndex: 30,
                  animation:
                    'gb-agent-working-halo 1.5s ease-out infinite',
                  // Match the 0% keyframe so the first paint doesn't
                  // flash a full-size ring before the animation kicks
                  // in.
                  transform: 'translate(-50%, -50%) scale(0.55)',
                  opacity: 0,
                  willChange: 'transform, opacity',
                }}
              />
            ) : null}
            {icon ? (
              <div
                role="img"
                aria-label={BADGE_LABEL[state]}
                title={BADGE_LABEL[state]}
                style={{
                  position: 'absolute',
                  left: screenX,
                  top: screenY - badgeOffsetY,
                  transform: 'translateX(-50%)',
                  pointerEvents: 'none',
                  zIndex: 40,
                  fontSize,
                  lineHeight: 1,
                  userSelect: 'none',
                  // Match the sprite's fade so the badge slides out
                  // (and back in) in lock-step with the character.
                  opacity: ch.displayAlpha,
                  // No plate, no border — just the emoji glyph. A
                  // tight double text-shadow keeps it readable over
                  // light tiles without putting a box around it.
                  textShadow:
                    '0 0 2px rgba(0,0,0,0.9), 0 1px 3px rgba(0,0,0,0.75)',
                }}
              >
                {icon}
              </div>
            ) : null}
          </Fragment>
        );
      })}
    </>
  );
}
