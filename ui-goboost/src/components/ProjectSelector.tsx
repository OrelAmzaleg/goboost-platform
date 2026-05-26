import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import {
  projectScopeColor,
  projectScopeLabel,
  type ProjectScope,
} from '../bookmarks.js';
import type { PaperclipProject } from '../paperclipApi.js';

/**
 * ProjectSelector — the chip that replaces the old "כללי" tab in the
 * first slot of the bookmarks bar (Session 9.2). Visually compact;
 * opens a dropdown with three section types:
 *
 *   1. Dashboard mode  (📊) — show everything, no filter.
 *   2. General         (📁) — issues with no project.
 *   3. Project list    (●)  — every active project; hover reveals ⚙
 *                              to open EditProjectModal for THAT
 *                              project without leaving the dropdown.
 *
 * Footer: "+ פרויקט חדש" — fires `onCreateProject` (App opens
 * ProjectCreateModal). The bookmarks bar no longer carries an
 * "add project to bar" button — every project is automatically
 * available in this dropdown.
 *
 * Controlled — App.tsx owns the active scope.
 */

export interface ProjectSelectorProps {
  activeScope: ProjectScope;
  projects: PaperclipProject[];
  onSelectScope: (scope: ProjectScope) => void;
  onEditProject: (projectId: string) => void;
  onCreateProject: () => void;
  /** Height of the host bar — the chip sizes itself to fit. */
  hostHeight: number;
}

export function ProjectSelector({
  activeScope,
  projects,
  onSelectScope,
  onEditProject,
  onCreateProject,
  hostHeight,
}: ProjectSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Click-outside closes the dropdown.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Projects sorted: active project first (when one is selected),
  // then by name. Archived projects sink to the bottom if Paperclip
  // includes them.
  const sortedProjects = useMemo(() => {
    const activeProjectId =
      activeScope.kind === 'project' ? activeScope.projectId : null;
    return [...projects].sort((a, b) => {
      if (a.id === activeProjectId) return -1;
      if (b.id === activeProjectId) return 1;
      return a.name.localeCompare(b.name, 'he');
    });
  }, [projects, activeScope]);

  const label = projectScopeLabel(activeScope, projects);
  const color = projectScopeColor(activeScope, projects);
  const icon = leadingIcon(activeScope, color);

  return (
    <div
      ref={ref}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        flexShrink: 0,
        height: hostHeight,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="בחר פרויקט / מצב תצוגה"
        aria-label="בחר פרויקט / מצב תצוגה"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 30,
          paddingInline: 12,
          borderRadius: 8,
          background: open
            ? 'rgba(99,102,241,0.30)'
            : 'rgba(99,102,241,0.18)',
          border: '1px solid rgba(129,140,248,0.6)',
          color: '#e0e7ff',
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: 12,
          fontWeight: 700,
          maxWidth: 220,
          flexShrink: 0,
        }}
      >
        {icon}
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
        <span style={{ opacity: 0.7, fontSize: 10 }}>▾</span>
      </button>

      {open ? (
        <div
          dir="rtl"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            insetInlineStart: 0,
            zIndex: 10001,
            minWidth: 280,
            maxWidth: 360,
            maxHeight: '70vh',
            overflowY: 'auto',
            background: '#0f172a',
            border: '1px solid rgba(255,255,255,0.18)',
            borderRadius: 10,
            boxShadow: '0 12px 28px rgba(0,0,0,0.55)',
            padding: 6,
            fontFamily: 'inherit',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Built-in scopes */}
          <SelectorRow
            active={activeScope.kind === 'dashboard'}
            icon={<span aria-hidden style={{ fontSize: 14 }}>📊</span>}
            label="דשבורד"
            sub="הצג את כל הפרויקטים והסוכנים"
            onClick={() => {
              setOpen(false);
              onSelectScope({ kind: 'dashboard' });
            }}
          />
          <SelectorRow
            active={activeScope.kind === 'general'}
            icon={<span aria-hidden style={{ fontSize: 13 }}>📁</span>}
            label="כללי"
            sub="משימות שלא משויכות לפרויקט"
            onClick={() => {
              setOpen(false);
              onSelectScope({ kind: 'general' });
            }}
          />

          <Divider />

          {sortedProjects.length === 0 ? (
            <div
              style={{
                fontSize: 12,
                color: '#94a3b8',
                padding: '10px 12px',
                textAlign: 'center',
              }}
            >
              אין עדיין פרויקטים. צור את הראשון.
            </div>
          ) : (
            sortedProjects.map((p) => {
              const isActive =
                activeScope.kind === 'project' &&
                activeScope.projectId === p.id;
              const projScope: ProjectScope = {
                kind: 'project',
                projectId: p.id,
              };
              return (
                <SelectorRow
                  key={p.id}
                  active={isActive}
                  icon={
                    <span
                      aria-hidden
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        background: p.color ?? '#94a3b8',
                        flexShrink: 0,
                      }}
                    />
                  }
                  label={p.name}
                  sub={null}
                  onClick={() => {
                    setOpen(false);
                    onSelectScope(projScope);
                  }}
                  trailing={
                    <button
                      type="button"
                      title="ערוך פרויקט"
                      aria-label="ערוך פרויקט"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpen(false);
                        onEditProject(p.id);
                      }}
                      style={trailingBtnStyle}
                    >
                      ⚙
                    </button>
                  }
                />
              );
            })
          )}

          <Divider />

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onCreateProject();
            }}
            style={{
              width: '100%',
              padding: '8px 10px',
              fontSize: 12,
              fontWeight: 700,
              borderRadius: 7,
              border: '1px solid rgba(34,197,94,0.55)',
              background: 'rgba(34,197,94,0.18)',
              color: '#dcfce7',
              cursor: 'pointer',
              fontFamily: 'inherit',
              textAlign: 'inherit',
            }}
          >
            + פרויקט חדש
          </button>

          {/* Tiny hint — keeps the operator oriented after the
              redesign. The selector replaces the old "general" tab
              and the "+" add-project button at once. */}
          {scopesEqualToHint(activeScope) ? null : (
            <div
              style={{
                marginBlockStart: 6,
                paddingInline: 10,
                fontSize: 10,
                color: '#64748b',
                lineHeight: 1.5,
              }}
            >
              כרטיסיות המשימות מימין נשמרות נפרד לכל פרויקט — מעבר בין
              פרויקטים מחליף את הסט.
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ── Internals ───────────────────────────────────────────────────────────────

function leadingIcon(
  scope: ProjectScope,
  color: string | null,
): ReactElement {
  if (scope.kind === 'dashboard') {
    return <span aria-hidden style={{ fontSize: 13 }}>📊</span>;
  }
  if (scope.kind === 'general') {
    return <span aria-hidden style={{ fontSize: 12 }}>📁</span>;
  }
  return (
    <span
      aria-hidden
      style={{
        width: 9,
        height: 9,
        borderRadius: '50%',
        background: color ?? '#94a3b8',
        flexShrink: 0,
      }}
    />
  );
}

// Only show the "pins are per-project" hint when the active scope is
// dashboard/general — pristine setups where the operator is most
// likely to be unsure why their pins shifted.
function scopesEqualToHint(scope: ProjectScope): boolean {
  return scope.kind === 'project';
}

function SelectorRow({
  active,
  icon,
  label,
  sub,
  trailing,
  onClick,
}: {
  active: boolean;
  icon: ReactElement;
  label: string;
  sub: string | null;
  trailing?: ReactElement;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px',
        background: active
          ? 'rgba(99,102,241,0.22)'
          : hover
            ? 'rgba(255,255,255,0.06)'
            : 'transparent',
        border: `1px solid ${active ? 'rgba(99,102,241,0.55)' : 'transparent'}`,
        borderRadius: 7,
        cursor: 'pointer',
        color: '#e2e8f0',
        userSelect: 'none',
        marginBlock: 1,
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: active ? 700 : 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </div>
        {sub ? (
          <div
            style={{
              fontSize: 10,
              color: '#94a3b8',
              marginBlockStart: 2,
              lineHeight: 1.4,
            }}
          >
            {sub}
          </div>
        ) : null}
      </div>
      {trailing && hover ? trailing : null}
    </div>
  );
}

function Divider() {
  return (
    <div
      aria-hidden
      style={{
        height: 1,
        background: 'rgba(255,255,255,0.08)',
        marginBlock: 6,
      }}
    />
  );
}

const trailingBtnStyle: React.CSSProperties = {
  width: 24,
  height: 24,
  padding: 0,
  borderRadius: 6,
  border: '1px solid rgba(255,255,255,0.18)',
  background: 'rgba(255,255,255,0.08)',
  color: '#cbd5e1',
  cursor: 'pointer',
  fontSize: 12,
  lineHeight: 1,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'inherit',
  flexShrink: 0,
};
