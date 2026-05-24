/**
 * issuePresentation — shared status vocabulary for issues.
 *
 * `statusColor` and `statusLabel` were duplicated in WhatsAppPanel and
 * TasksPanel; the issue-tree picker needs them too. One module keeps the
 * status dot colors and Hebrew labels consistent everywhere.
 *
 * Paperclip status enum:
 *   backlog | todo | in_progress | in_review | blocked | done | cancelled
 */

export function statusColor(status: string): string {
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

export function statusLabel(status: string): string {
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
