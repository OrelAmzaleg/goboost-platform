import { useState } from 'react';

import { GENERAL_BOOKMARK_ID, type Bookmark } from '../bookmarks.js';

/**
 * BookmarksBar — full-width strip of project-scope tabs at the top of the
 * screen. Each tab is a bookmark (general / project / issue-pin); the
 * active tab decides which scope filters every agent's issue forest.
 *
 * The bar is curated:
 *   • click a tab           → select that scope
 *   • drag a tab            → reorder
 *   • × on a project/issue  → remove from the bar (NOT delete the project)
 *   • ⚙ on a project        → open the project edit modal
 *   • + (end of the row)    → opens the add-project modal (App-level)
 *
 * Controlled component — App.tsx owns the state and persists it.
 */

export interface BookmarksBarProps {
  bookmarks: Bookmark[];
  activeId: string;
  /** Height in px — App offsets content below by banner + this. */
  height: number;
  onSelect: (id: string) => void;
  /** Receives the full id list in its new order. */
  onReorder: (orderedIds: string[]) => void;
  /** Remove a bookmark from the bar (project tab or issue-pin). */
  onRemove: (id: string) => void;
  /** Open the edit modal for a project. */
  onEditProject: (projectId: string) => void;
  /** Open the add-project modal. */
  onOpenAddMenu: () => void;
  /** Open the company-goals modal (feature-level button, not a bookmark). */
  onOpenGoals: () => void;
  /** Open the organizational hierarchy modal. */
  onOpenOrgChart: () => void;
}

export function BookmarksBar({
  bookmarks,
  activeId,
  height,
  onSelect,
  onReorder,
  onRemove,
  onEditProject,
  onOpenAddMenu,
  onOpenGoals,
  onOpenOrgChart,
}: BookmarksBarProps) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const commitReorder = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const without = bookmarks.map((b) => b.id).filter((x) => x !== fromId);
    const insertAt = without.indexOf(toId);
    if (insertAt < 0) return;
    without.splice(insertAt, 0, fromId);
    // General always leads — never let a drop push anything before it.
    const gi = without.indexOf(GENERAL_BOOKMARK_ID);
    if (gi > 0) {
      without.splice(gi, 1);
      without.unshift(GENERAL_BOOKMARK_ID);
    }
    onReorder(without);
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
          gap: 4,
          padding: '0 8px',
          overflowX: 'auto',
          overflowY: 'visible',
          zIndex: 101, // above the chat panel (z=100)
          ['--gb-chat-font' as string]:
            "'Heebo', system-ui, -apple-system, sans-serif",
        } as React.CSSProperties
      }
    >
      {bookmarks.map((bm) => {
        const active = bm.id === activeId;
        const isGeneral = bm.id === GENERAL_BOOKMARK_ID;
        const draggable = !isGeneral;
        const isDragTarget = overId === bm.id && dragId !== bm.id;
        return (
          <div
            key={bm.id}
            draggable={draggable}
            onDragStart={(e) => {
              if (!draggable) {
                e.preventDefault();
                return;
              }
              setDragId(bm.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              if (dragId && dragId !== bm.id && !isGeneral) {
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
            onClick={() => onSelect(bm.id)}
            title={bm.label}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              alignSelf: 'center',
              height: 30,
              paddingInline: 10,
              borderRadius: 8,
              cursor: draggable ? 'grab' : 'pointer',
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
            {/* Leading marker — folder for general, color dot for a
                project, bookmark glyph for an issue-pin. */}
            {isGeneral ? (
              <span aria-hidden style={{ fontSize: 13 }}>📁</span>
            ) : bm.scope.kind === 'project' ? (
              <span
                aria-hidden
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: '50%',
                  background: bm.color ?? '#94a3b8',
                  flexShrink: 0,
                }}
              />
            ) : (
              <span aria-hidden style={{ fontSize: 12 }}>🔖</span>
            )}

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

            {/* Edit (projects only) — pencil, on hover. */}
            {bm.isProject &&
            hoverId === bm.id &&
            bm.scope.kind === 'project' ? (
              <button
                type="button"
                title="ערוך פרויקט"
                aria-label="ערוך פרויקט"
                onClick={(e) => {
                  e.stopPropagation();
                  if (bm.scope.kind === 'project') {
                    onEditProject(bm.scope.projectId);
                  }
                }}
                style={iconBtnStyle('#cbd5e1')}
              >
                ⚙
              </button>
            ) : null}

            {/* Remove from bar — projects + issue-pins, on hover. */}
            {bm.removable && hoverId === bm.id ? (
              <button
                type="button"
                title="הסר מהבאר"
                aria-label="הסר מהבאר"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(bm.id);
                }}
                style={iconBtnStyle('#fca5a5')}
              >
                ×
              </button>
            ) : null}
          </div>
        );
      })}

      {/* + add — opens the add-project modal (App-level). */}
      <button
        type="button"
        title="הוסף פרויקט לבּאר"
        aria-label="הוסף פרויקט לבּאר"
        onClick={onOpenAddMenu}
        style={{
          alignSelf: 'center',
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
          fontSize: 18,
          fontWeight: 700,
          lineHeight: 1,
        }}
      >
        +
      </button>

      {/* 🎯 Goals — feature-level button (not a bookmark tab).
          Set apart from the "+" button with a margin so it reads as
          a separate action, not "another bookmark to add". */}
      <button
        type="button"
        title="מטרות החברה"
        aria-label="מטרות החברה"
        onClick={onOpenGoals}
        style={{
          alignSelf: 'center',
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
          marginInlineStart: 8,
        }}
      >
        🎯
      </button>

      {/* 🏢 Org chart — same visual family as Goals; another feature-level
          button. Both live to the left of the "+" in RTL terms. */}
      <button
        type="button"
        title="מבנה ארגוני"
        aria-label="מבנה ארגוני"
        onClick={onOpenOrgChart}
        style={{
          alignSelf: 'center',
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
          marginInlineStart: 4,
        }}
      >
        🏢
      </button>
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
