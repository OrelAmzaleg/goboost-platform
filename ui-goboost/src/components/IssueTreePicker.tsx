import { useMemo, useState } from 'react';

import { getAgentName } from '../paperclipApi.js';
import type { IssueTreeNode } from '../paperclipTree.js';
import { statusColor, statusLabel } from './issuePresentation.js';

/**
 * IssueTreePicker — the dropdown body that replaces the old flat issue
 * list. Renders the focused agent's issue *forest*: each root issue with
 * its nested sub-issues.
 *
 * Visual language (from the design doc):
 *   • "lit"  node — the focused agent owns it. Indigo active-chip styling.
 *   • "off"  node — same tree, owned by someone else (or unassigned).
 *                   Dimmed (opacity), transparent — still a real button.
 *   • the active issue gets a focus ring regardless of lit/off.
 *
 * Each root is independently collapsible; the branch containing the
 * active issue is force-expanded so the current position is always
 * visible.
 */

export interface IssueTreePickerProps {
  forest: IssueTreeNode[];
  loading: boolean;
  /** Currently-open issue id — gets the focus ring + forced expansion. */
  activeIssueId: string | null;
  size: (base: number) => number;
  onSelect: (node: IssueTreeNode) => void;
}

// Collect the ids on the path from a root down to `targetId` (inclusive
// of ancestors) so we can force-expand that branch.
function pathToIssue(
  node: IssueTreeNode,
  targetId: string,
  acc: string[],
): string[] | null {
  if (node.issue.id === targetId) return acc;
  for (const child of node.children) {
    const found = pathToIssue(child, targetId, [...acc, node.issue.id]);
    if (found) return found;
  }
  return null;
}

export function IssueTreePicker({
  forest,
  loading,
  activeIssueId,
  size,
  onSelect,
}: IssueTreePickerProps) {
  // Ids of nodes the user has explicitly collapsed. Default = everything
  // expanded; collapsing is opt-in. The active branch overrides this.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // Ancestor ids of the active issue — always rendered expanded.
  const forcedOpen = useMemo(() => {
    if (!activeIssueId) return new Set<string>();
    for (const root of forest) {
      const path = pathToIssue(root, activeIssueId, []);
      if (path) return new Set(path);
    }
    return new Set<string>();
  }, [forest, activeIssueId]);

  if (loading) {
    return (
      <div style={{ padding: '12px 14px', fontSize: size(12), color: '#94a3b8' }}>
        טוען עץ משימות…
      </div>
    );
  }
  if (forest.length === 0) {
    return (
      <div
        style={{
          padding: '14px',
          fontSize: size(12),
          color: '#94a3b8',
          lineHeight: 1.6,
          textAlign: 'center',
        }}
      >
        הסוכן הזה לא מעורב באף משימה.
        <br />
        <span style={{ fontSize: size(11), opacity: 0.7 }}>
          פתח שיחה חדשה כדי להתחיל.
        </span>
      </div>
    );
  }

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: 6,
      }}
    >
      {forest.map((root) => (
        <TreeNodeRow
          key={root.issue.id}
          node={root}
          activeIssueId={activeIssueId}
          collapsed={collapsed}
          forcedOpen={forcedOpen}
          size={size}
          onSelect={onSelect}
          onToggle={toggle}
        />
      ))}
    </div>
  );
}

// ── Recursive node row ──────────────────────────────────────────────────────

function TreeNodeRow({
  node,
  activeIssueId,
  collapsed,
  forcedOpen,
  size,
  onSelect,
  onToggle,
}: {
  node: IssueTreeNode;
  activeIssueId: string | null;
  collapsed: Set<string>;
  forcedOpen: Set<string>;
  size: (base: number) => number;
  onSelect: (node: IssueTreeNode) => void;
  onToggle: (id: string) => void;
}) {
  const { issue, lit, depth, children } = node;
  const isActive = issue.id === activeIssueId;
  const hasChildren = children.length > 0;
  // Forced-open (active branch) wins over a user collapse.
  const isOpen = forcedOpen.has(issue.id) || !collapsed.has(issue.id);
  const assigneeName = getAgentName(issue.assigneeAgentId);

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'stretch',
          gap: 2,
          paddingInlineStart: depth * 16,
        }}
      >
        {/* Disclosure caret (only when there are children). */}
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(issue.id)}
            aria-label={isOpen ? 'כווץ' : 'הרחב'}
            style={{
              width: 18,
              flexShrink: 0,
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              cursor: 'pointer',
              fontSize: size(9),
              fontFamily: 'inherit',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {isOpen ? '▼' : '▶'}
          </button>
        ) : (
          <span style={{ width: 18, flexShrink: 0 }} />
        )}

        {/* The node button. Lit = indigo active styling; off = dimmed. */}
        <button
          type="button"
          onClick={() => onSelect(node)}
          title={`${issue.identifier ?? '—'} · ${issue.title}${
            assigneeName ? ` · ${assigneeName}` : ''
          }`}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '7px 9px',
            background: lit
              ? 'rgba(99,102,241,0.22)'
              : 'rgba(255,255,255,0.03)',
            border: isActive
              ? '1px solid rgba(129,140,248,0.9)'
              : lit
                ? '1px solid rgba(129,140,248,0.4)'
                : '1px solid transparent',
            borderRadius: 7,
            color: '#e2e8f0',
            cursor: 'pointer',
            textAlign: 'start',
            fontFamily: 'inherit',
            // "off" nodes are dimmed — they belong to the tree but the
            // focused agent isn't on them.
            opacity: lit ? 1 : 0.55,
            transition: 'background 0.12s, opacity 0.12s',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.opacity = '1';
            if (!lit)
              (e.currentTarget as HTMLButtonElement).style.background =
                'rgba(255,255,255,0.07)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.opacity = lit
              ? '1'
              : '0.55';
            (e.currentTarget as HTMLButtonElement).style.background = lit
              ? 'rgba(99,102,241,0.22)'
              : 'rgba(255,255,255,0.03)';
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: statusColor(issue.status),
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: size(11),
              fontWeight: 700,
              background: 'rgba(0,0,0,0.25)',
              padding: '2px 6px',
              borderRadius: 4,
              flexShrink: 0,
              letterSpacing: 0.4,
            }}
          >
            {issue.identifier ?? '—'}
          </span>
          <span
            style={{
              fontSize: size(13),
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {issue.title}
          </span>
          {assigneeName ? (
            <span
              style={{
                fontSize: size(10),
                opacity: 0.7,
                flexShrink: 0,
                maxWidth: 90,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              👤 {assigneeName}
            </span>
          ) : null}
          <span
            style={{
              fontSize: size(10),
              opacity: 0.7,
              flexShrink: 0,
              padding: '1px 5px',
              background: 'rgba(255,255,255,0.05)',
              borderRadius: 3,
            }}
          >
            {statusLabel(issue.status)}
          </span>
        </button>
      </div>

      {hasChildren && isOpen
        ? children.map((child) => (
            <TreeNodeRow
              key={child.issue.id}
              node={child}
              activeIssueId={activeIssueId}
              collapsed={collapsed}
              forcedOpen={forcedOpen}
              size={size}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))
        : null}
    </>
  );
}
