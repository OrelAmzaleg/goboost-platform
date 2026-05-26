import { useState } from 'react';

import { issueIdFromBookmarkId, type Bookmark, type ProjectScope } from '../bookmarks.js';
import { ProjectSelector } from './ProjectSelector.js';
import type { PaperclipProject } from '../paperclipApi.js';

/**
 * BookmarksBar — the project-scope strip at the top of the screen.
 *
 * Session 9.2 redesign: the bar is now structured as
 *
 *   [ ProjectSelector chip ] [ pin1 ] [ pin2 ] ... [ separator ] [🎯] [🏢]
 *
 * Where:
 *   • The selector is always the rightmost element (RTL inline-start)
 *     and never scrolls.
 *   • The pin tabs are the *active scope's* pinned issues — switching
 *     the selector swaps the visible set.
 *   • The selector also subsumes the previous "+ project" action and
 *     the "general" tab, so the bar no longer carries a "+" button.
 *
 * Controlled — App.tsx owns the arrangement state.
 */

export interface BookmarksBarProps {
  /** Currently-selected project scope (from arrangement.activeScope). */
  activeScope: ProjectScope;
  /** All active projects in the company (for the selector dropdown). */
  projects: PaperclipProject[];
  /**
   * Pinned issues belonging to the active scope, in display order.
   * Empty when the scope has no pins.
   */
  pinnedBookmarks: Bookmark[];
  /** Active pin within the scope (null = the scope-root view). */
  activePinId: string | null;
  /** Height in px — App offsets content below by banner + this. */
  height: number;
  // ── Callbacks ───────────────────────────────────────────────────
  onSelectScope: (scope: ProjectScope) => void;
  /** Select a pin within the active scope. Pass `null` to clear back to scope-root. */
  onSelectPin: (issueId: string | null) => void;
  /** Reorder pins within the active scope. */
  onReorderPins: (orderedIssueIds: string[]) => void;
  /** Remove a pin from the active scope (auto-pin will be suppressed for it). */
  onRemovePin: (issueId: string) => void;
  /** Open the edit modal for a project — fires from the selector dropdown. */
  onEditProject: (projectId: string) => void;
  /** Open the create-project modal — fires from the selector dropdown footer. */
  onCreateProject: () => void;
  /** Open the company-goals modal (left-cluster feature button). */
  onOpenGoals: () => void;
  /** Open the organizational hierarchy modal (left-cluster feature button). */
  onOpenOrgChart: () => void;
}

export function BookmarksBar({
  activeScope,
  projects,
  pinnedBookmarks,
  activePinId,
  height,
  onSelectScope,
  onSelectPin,
  onReorderPins,
  onRemovePin,
  onEditProject,
  onCreateProject,
  onOpenGoals,
  onOpenOrgChart,
}: BookmarksBarProps) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const commitReorder = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const fromIssueId = issueIdFromBookmarkId(fromId);
    const toIssueId = issueIdFromBookmarkId(toId);
    if (!fromIssueId || !toIssueId) return;
    const ids = pinnedBookmarks
      .map((b) => issueIdFromBookmarkId(b.id))
      .filter((x): x is string => !!x);
    const without = ids.filter((id) => id !== fromIssueId);
    const insertAt = without.indexOf(toIssueId);
    if (insertAt < 0) return;
    without.splice(insertAt, 0, fromIssueId);
    onReorderPins(without);
  };

  return (
    <div
      dir="rtl"
      className="gb-chat-panel-scope"
      style={
        {
          position: 'fixed',
          top: 38, // sits directly below the connection banner
          insetInlineStart: 0,
          insetInlineEnd: 0,
          height,
          background: 'rgba(15, 23, 42, 0.97)',
          borderBlockEnd: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          alignItems: 'stretch',
          gap: 0,
          padding: '0 8px',
          // Outer container does NOT scroll — only the pinned-bookmarks
          // strip in the middle scrolls. Otherwise the selector and the
          // left feature cluster would scroll off the screen.
          overflowX: 'visible',
          overflowY: 'visible',
          zIndex: 101,
          ['--gb-chat-font' as string]:
            "'Heebo', system-ui, -apple-system, sans-serif",
        } as React.CSSProperties
      }
    >
      {/* Right-edge: project selector (fixed, never scrolls). */}
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          paddingInlineEnd: 6,
        }}
      >
        <ProjectSelector
          activeScope={activeScope}
          projects={projects}
          onSelectScope={onSelectScope}
          onEditProject={onEditProject}
          onCreateProject={onCreateProject}
          hostHeight={height}
        />
      </div>

      {/* Middle: scrollable pin tabs (active scope only). */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'stretch',
          gap: 4,
          overflowX: 'auto',
          overflowY: 'visible',
          paddingInline: 4,
        }}
      >
        {pinnedBookmarks.length === 0 ? (
          <div
            style={{
              alignSelf: 'center',
              fontSize: 11,
              color: '#64748b',
              paddingInline: 8,
              fontStyle: 'italic',
            }}
          >
            אין משימות נעוצות ב-{labelForScope(activeScope, projects)} —
            משימות אב חדשות יתויגו אוטומטית.
          </div>
        ) : (
          pinnedBookmarks.map((bm) => {
            const issueId = issueIdFromBookmarkId(bm.id);
            if (!issueId) return null;
            const active = issueId === activePinId;
            const isDragTarget = overId === bm.id && dragId !== bm.id;
            return (
              <div
                key={bm.id}
                draggable
                onDragStart={(e) => {
                  setDragId(bm.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  if (dragId && dragId !== bm.id) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    setOverId(bm.id);
                  }
                }}
                onDragLeave={() => {
                  setOverId((cur) => (cur === bm.id ? null : cur));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragId) commitReorder(dragId, bm.id);
                  setDragId(null);
                  setOverId(null);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setOverId(null);
                }}
                onMouseEnter={() => setHoverId(bm.id)}
                onMouseLeave={() =>
                  setHoverId((cur) => (cur === bm.id ? null : cur))
                }
                onClick={() => onSelectPin(active ? null : issueId)}
                title={bm.label}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  alignSelf: 'center',
                  height: 30,
                  paddingInline: 10,
                  borderRadius: 8,
                  cursor: 'grab',
                  flexShrink: 0,
                  maxWidth: 220,
                  background: active
                    ? 'rgba(99,102,241,0.3)'
                    : 'rgba(255,255,255,0.05)',
                  border: active
                    ? '1px solid rgba(129,140,248,0.7)'
                    : isDragTarget
                      ? '1px dashed rgba(129,140,248,0.8)'
                      : '1px solid rgba(255,255,255,0.08)',
                  color: active ? '#e0e7ff' : '#cbd5e1',
                  opacity: dragId === bm.id ? 0.4 : 1,
                  transition: 'background 0.12s, opacity 0.12s',
                }}
              >
                <span aria-hidden style={{ fontSize: 12 }}>🔖</span>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: active ? 700 : 600,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {bm.label}
                </span>
                {hoverId === bm.id ? (
                  <button
                    type="button"
                    title="הסר נעיצה"
                    aria-label="הסר נעיצה"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemovePin(issueId);
                    }}
                    style={iconBtnStyle('#fca5a5')}
                  >
                    ×
                  </button>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      {/* Visual separator between the scrollable pin row (right) and
          the left feature cluster. */}
      <div
        aria-hidden
        style={{
          flexShrink: 0,
          alignSelf: 'center',
          width: 1,
          height: 22,
          background: 'rgba(255,255,255,0.15)',
          marginInline: 8,
        }}
      />

      {/* Left cluster — feature actions, fixed at the physical-left
          edge, stacking under the WorkspaceSwitcher dropdown above. */}
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        <button
          type="button"
          title="מטרות החברה"
          aria-label="מטרות החברה"
          onClick={onOpenGoals}
          style={featureBtnStyle}
        >
          🎯
        </button>
        <button
          type="button"
          title="מבנה ארגוני"
          aria-label="מבנה ארגוני"
          onClick={onOpenOrgChart}
          style={featureBtnStyle}
        >
          🏢
        </button>
      </div>
    </div>
  );
}

// ── Shared inline styles ────────────────────────────────────────────────────

function iconBtnStyle(color: string): React.CSSProperties {
  return {
    width: 16,
    height: 16,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    color,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700,
    padding: 0,
    flexShrink: 0,
    lineHeight: 1,
  };
}

const featureBtnStyle: React.CSSProperties = {
  flexShrink: 0,
  width: 30,
  height: 30,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 8,
  color: '#cbd5e1',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 14,
  lineHeight: 1,
};

function labelForScope(
  scope: ProjectScope,
  projects: PaperclipProject[],
): string {
  if (scope.kind === 'dashboard') return 'דשבורד';
  if (scope.kind === 'general') return 'כללי';
  return (
    projects.find((p) => p.id === scope.projectId)?.name ?? 'פרויקט'
  );
}
