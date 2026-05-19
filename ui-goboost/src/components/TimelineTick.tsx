import { getAgentName } from '../paperclipApi.js';

/**
 * TimelineTick — Stream 3 / Primitive #5 from CHAT_PANEL_DESIGN.md.
 *
 * Renders a single low-noise event from the issue's activity log: status
 * change, assignee change, workspace move, etc. NOT a dialog bubble — one
 * compact centered line with an icon, a sentence, and a timestamp.
 *
 * The chat panel synthesizes these from `activity.logged` payloads it
 * receives via subscribeActivity. We don't fetch them separately; the
 * timeline merge filters by entityType=issue and a known action vocabulary.
 */

export interface TimelineTickEvent {
  /** Stable identity in the timeline merge (e.g. `t:${activityLogId}`). */
  id: string;
  /** Action string from the backend — e.g. `issue.status_changed`. */
  action: string;
  /** ISO timestamp from the activity row. */
  createdAt: string;
  /** Optional structured payload from the activity row. */
  payload?: Record<string, unknown>;
  /** Optional actor — agent UUID or user id. */
  actorAgentId?: string | null;
  actorUserId?: string | null;
}

export interface TimelineTickProps {
  event: TimelineTickEvent;
  size: (base: number) => number;
  formatTime: (iso: string) => string;
}

// Hebrew labels for known status values (kept local — same vocabulary as
// the session-picker statuses, but the picker is the source of truth there).
function statusLabelHe(status: string): string {
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

interface TickRender {
  icon: string;
  text: string;
}

function describe(event: TimelineTickEvent): TickRender | null {
  const p = event.payload ?? {};
  const actorName =
    getAgentName(event.actorAgentId ?? null) ??
    (event.actorUserId ? 'משתמש' : 'מערכת');

  switch (event.action) {
    case 'issue.status_changed': {
      const from = typeof p.from === 'string' ? statusLabelHe(p.from) : null;
      const to = typeof p.to === 'string' ? statusLabelHe(p.to) : null;
      if (from && to) return { icon: '🔄', text: `סטטוס: ${from} ← ${to}` };
      if (to) return { icon: '🔄', text: `סטטוס: ${to}` };
      return { icon: '🔄', text: 'סטטוס עודכן' };
    }
    case 'issue.assignee_changed': {
      const to =
        getAgentName(typeof p.to === 'string' ? p.to : null) ??
        (typeof p.toName === 'string' ? (p.toName as string) : null);
      return {
        icon: '👤',
        text: to ? `הוקצה ל-${to}` : 'הוקצה לסוכן אחר',
      };
    }
    case 'issue.parent_changed':
      return { icon: '🔗', text: 'שייכות לאב עודכנה' };
    case 'issue.priority_changed': {
      const to = typeof p.to === 'string' ? (p.to as string) : null;
      return { icon: '⚑', text: to ? `עדיפות: ${to}` : 'עדיפות עודכנה' };
    }
    case 'issue.workspace_changed':
      return { icon: '🗂', text: 'הועבר ל-workspace אחר' };
    case 'issue.created':
      return { icon: '✨', text: `${actorName} פתח/ה את הנושא` };
    case 'issue.closed':
      return { icon: '🔒', text: 'הנושא נסגר' };
    case 'issue.reopened':
      return { icon: '🔓', text: 'הנושא נפתח מחדש' };
    case 'issue.locked':
      return { icon: '🔐', text: 'הנושא ננעל' };
    case 'issue.unlocked':
      return { icon: '🔓', text: 'הנעילה הוסרה' };
    default:
      // Unknown action — surface raw so we notice new variants
      return { icon: '·', text: event.action };
  }
}

export function TimelineTick({ event, size, formatTime }: TimelineTickProps) {
  const rendered = describe(event);
  if (!rendered) return null;

  return (
    <div
      style={{
        alignSelf: 'center',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 10px',
        fontSize: size(11),
        color: '#94a3b8',
        opacity: 0.85,
        lineHeight: 1.4,
      }}
    >
      <span aria-hidden style={{ fontSize: size(11) }}>
        {rendered.icon}
      </span>
      <span>{rendered.text}</span>
      <span style={{ opacity: 0.6, marginInlineStart: 4 }}>
        · {formatTime(event.createdAt)}
      </span>
    </div>
  );
}

/**
 * Action vocabulary the chat panel cares about — used by the activity
 * subscription to decide whether an `activity.logged` row should appear
 * as a TimelineTick in the merged feed.
 */
export const TIMELINE_TICK_ACTIONS = new Set<string>([
  'issue.status_changed',
  'issue.assignee_changed',
  'issue.parent_changed',
  'issue.priority_changed',
  'issue.workspace_changed',
  'issue.created',
  'issue.closed',
  'issue.reopened',
  'issue.locked',
  'issue.unlocked',
]);
