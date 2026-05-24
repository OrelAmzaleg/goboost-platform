/**
 * Agent speech bridge — turns Paperclip activity/heartbeat streams into
 * transient text bubbles above each agent's head in the office canvas.
 *
 * Event sources (all global, subscribed once at boot):
 *
 *   subscribeRunStatus       — heartbeat.run.queued + heartbeat.run.status.
 *                              Earliest reliable signal that "user just
 *                              woke this agent" / "the run is running".
 *                              Drives `user_message_received` + `agent_thinking`.
 *
 *   subscribeHeartbeatEvents — heartbeat.run.event (lifecycle / adapter /
 *                              error instrumentation). Used to refresh
 *                              the rolling "thinking" line while the
 *                              agent is mid-run.
 *
 *   subscribeActivity        — activity.logged. We watch for
 *                              `issue.comment_added` events: those
 *                              authored by an agent fire `agent_replying`
 *                              IMMEDIATELY (the comment is about to land
 *                              in the chat panel), and those authored by
 *                              a user fire `user_message_received` on
 *                              the issue's assignee. Also handles
 *                              approvals + work-product creation.
 *
 * Crucial timing note: `agent_replying` is driven by `comment_added`,
 * NOT by `status: succeeded`. The terminal status event fires AFTER the
 * comment is already in the activity log — so listening for it makes
 * the bubble appear AFTER the chat has already updated, which feels
 * broken. `comment_added` is the right event because it fires when the
 * comment is created, beating the chat panel's async re-fetch.
 *
 * Out of scope in v1 (documented gaps, not bugs):
 *  • `agent_delegated_down` — requires a reverse hierarchy index
 *    (manager UUID → child UUIDs) we don't yet maintain.
 *  • `agent_using_tool` — heartbeat payloads don't yet expose tool
 *    names in a stable place. Tool runs surface as `agent_thinking`
 *    until that signal is reliable.
 */

import {
  fetchIssueById,
  numericIdForAgentUuid,
  subscribeActivity,
  subscribeHeartbeatEvents,
  subscribeRunStatus,
  uuidForNumericAgentId,
} from '../paperclipApi.js';
import type { OfficeState } from './engine/officeState.js';

/** Refresh window for rolling "thinking" bubble — too fast = flickery. */
const THINKING_REFRESH_MS = 2000;
/** Cache TTL for the issue→assignee lookup (avoids re-fetching the same issue). */
const ISSUE_CACHE_TTL_MS = 30_000;
/** Window of inactivity before an agent becomes eligible for idle pings. */
const IDLE_THRESHOLD_MS = 30_000;
/** Per-tick probability of firing an idle ping (when eligible). */
const IDLE_TICK_PROB = 0.04;
/** Idle pinger tick interval. */
const IDLE_TICK_MS = 6000;

interface CachedIssue {
  assigneeAgentId: string | null;
  cachedAt: number;
}

export function startAgentSpeechBridge(
  getOffice: () => OfficeState,
): () => void {
  const lastThinkingRefreshByAgent = new Map<string, number>();
  const lastEventAtByAgent = new Map<string, number>();
  const issueCache = new Map<string, CachedIssue>();

  // ── Helpers ──────────────────────────────────────────────────────

  function getAssigneeFor(issueId: string): Promise<string | null> {
    const cached = issueCache.get(issueId);
    if (cached && Date.now() - cached.cachedAt < ISSUE_CACHE_TTL_MS) {
      return Promise.resolve(cached.assigneeAgentId);
    }
    return fetchIssueById(issueId)
      .then((iss) => {
        const assignee = iss?.assigneeAgentId ?? null;
        issueCache.set(issueId, { assigneeAgentId: assignee, cachedAt: Date.now() });
        return assignee;
      })
      .catch(() => null);
  }

  function fireForAgent(
    agentUuid: string,
    category: Parameters<OfficeState['setSpeechBubble']>[1],
  ): void {
    const numId = numericIdForAgentUuid(agentUuid);
    if (numId == null) return;
    const office = getOffice();
    if (!office.characters.has(numId)) return;
    office.setSpeechBubble(numId, category);
    lastEventAtByAgent.set(agentUuid, Date.now());
  }

  // ── Run lifecycle (EARLIEST signal — queued / running / terminal) ──

  const unsubRunStatus = subscribeRunStatus((event) => {
    if (!event.agentId || !event.runId) return;
    if (event.kind === 'queued') {
      // The very moment the agent enters the queue → user just sent
      // a message. Show the brief "got it, on it" line.
      fireForAgent(event.agentId, 'user_message_received');
      lastThinkingRefreshByAgent.set(event.agentId, Date.now());
      return;
    }
    if (event.kind === 'running') {
      // Run is now actively executing → switch to "thinking".
      fireForAgent(event.agentId, 'agent_thinking');
      lastThinkingRefreshByAgent.set(event.agentId, Date.now());
      return;
    }
    // Terminal kinds: 'succeeded' | 'failed' | 'cancelled' | 'timed_out'.
    // We intentionally do NOT fire `agent_replying` here — that's the
    // job of the comment_added activity event, which fires earlier. If
    // a run fails without a comment, the bubble simply expires on its
    // own timer.
  });

  // ── Heartbeat events: rolling refresh of "thinking" while run is live ──

  const unsubHeartbeat = subscribeHeartbeatEvents((event) => {
    if (!event.agentId || !event.runId) return;
    const lastRefresh = lastThinkingRefreshByAgent.get(event.agentId) ?? 0;
    if (Date.now() - lastRefresh >= THINKING_REFRESH_MS) {
      fireForAgent(event.agentId, 'agent_thinking');
      lastThinkingRefreshByAgent.set(event.agentId, Date.now());
    } else {
      // Touch last-event so the agent doesn't slide into idle mid-run.
      lastEventAtByAgent.set(event.agentId, Date.now());
    }
  });

  // ── Activity events: user / agent comments, approvals, work products ──

  const unsubActivity = subscribeActivity((payload) => {
    const entityType = String(payload.entityType ?? '');
    const action = String(payload.action ?? '');
    const issueIdInPayload = String(payload.issueId ?? '') || null;
    const actorUserId = String(payload.actorUserId ?? '') || null;
    const actorAgentId = String(payload.actorAgentId ?? '') || null;

    // ── Comment added ──
    // The most important timing fix: when an AGENT posts a comment,
    // fire `agent_replying` immediately. This beats the chat panel's
    // async refetch, so the bubble appears just before the chat row.
    const isCommentAction = /comment|reply|message/i.test(action);
    if (isCommentAction) {
      if (actorAgentId) {
        fireForAgent(actorAgentId, 'agent_replying');
        return;
      }
      // User comment from any surface (our chat panel, Paperclip
      // dashboard, etc.). Need the issue's assignee. The first call per
      // issue is a cold fetch — we accept the latency once, then 30s
      // of cache covers subsequent messages on the same issue.
      if (actorUserId && issueIdInPayload) {
        void getAssigneeFor(issueIdInPayload).then((agentUuid) => {
          if (agentUuid) fireForAgent(agentUuid, 'user_message_received');
        });
        return;
      }
    }

    // ── Approval pending / resolved ──
    if (entityType === 'approval') {
      const details = (payload.details ?? {}) as {
        linkedIssueIds?: unknown;
      };
      const linked = Array.isArray(details.linkedIssueIds)
        ? (details.linkedIssueIds as unknown[]).filter(
            (x): x is string => typeof x === 'string',
          )
        : issueIdInPayload
          ? [issueIdInPayload]
          : [];
      const isOpen = /request|created|pending/i.test(action);
      const isResolved = /approve|reject|cancel|deny|resolve/i.test(action);
      for (const iid of linked) {
        void getAssigneeFor(iid).then((agentUuid) => {
          if (!agentUuid) return;
          if (isOpen) {
            fireForAgent(agentUuid, 'approval_pending');
          } else if (isResolved) {
            const numId = numericIdForAgentUuid(agentUuid);
            if (numId != null) getOffice().clearSpeechBubble(numId, 'approval_pending');
          }
        });
      }
      return;
    }

    // ── Work product / attachment created by an agent ──
    if (
      (entityType === 'attachment' || entityType === 'work_product') &&
      /create|upload|generate/i.test(action) &&
      actorAgentId
    ) {
      fireForAgent(actorAgentId, 'work_product_created');
      return;
    }
  });

  // ── Idle pinger ────────────────────────────────────────────────
  const idleTimer = setInterval(() => {
    const office = getOffice();
    const now = Date.now();
    for (const [numericId, ch] of office.characters) {
      if (numericId <= 0 || ch.isSubagent) continue;
      if (ch.matrixEffect) continue;
      if (ch.speechBubble) continue;
      const uuid = uuidForNumericAgentId(numericId);
      if (!uuid) continue;
      const lastEvent = lastEventAtByAgent.get(uuid) ?? 0;
      if (now - lastEvent < IDLE_THRESHOLD_MS) continue;
      if (Math.random() < IDLE_TICK_PROB) {
        office.setSpeechBubble(numericId, 'idle_resting');
      }
    }
  }, IDLE_TICK_MS);

  return () => {
    unsubRunStatus();
    unsubHeartbeat();
    unsubActivity();
    clearInterval(idleTimer);
    lastThinkingRefreshByAgent.clear();
    lastEventAtByAgent.clear();
    issueCache.clear();
  };
}
