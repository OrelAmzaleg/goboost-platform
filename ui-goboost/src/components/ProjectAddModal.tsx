import {
  projectStatusLabel,
} from './projectForm.js';
import { ModalShell } from './ProjectCreateModal.js';
import type { PaperclipProject } from '../paperclipApi.js';

/**
 * ProjectAddModal — the "+" flow from the bookmarks bar, presented as a
 * proper centered modal (not a cramped in-bar popover).
 *
 * Two actions:
 *   • create a brand-new project  → hands off to ProjectCreateModal
 *   • add an existing project tab → the project is loaded into the bar
 */

export interface ProjectAddModalProps {
  /** Projects not currently in the bar. */
  availableProjects: PaperclipProject[];
  onClose: () => void;
  /** Add an existing project's tab to the bar. */
  onAddProject: (projectId: string) => void;
  /** Switch to the create-project flow. */
  onCreateNew: () => void;
}

export function ProjectAddModal({
  availableProjects,
  onClose,
  onAddProject,
  onCreateNew,
}: ProjectAddModalProps) {
  return (
    <ModalShell title="הוספת פרויקט לבּאר" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Create-new — the primary action. */}
        <button
          type="button"
          onClick={onCreateNew}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 14px',
            borderRadius: 10,
            border: '1px solid rgba(34,197,94,0.5)',
            background: 'rgba(34,197,94,0.16)',
            color: '#dcfce7',
            cursor: 'pointer',
            fontFamily: 'inherit',
            textAlign: 'start',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background =
              'rgba(34,197,94,0.26)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background =
              'rgba(34,197,94,0.16)';
          }}
        >
          <span aria-hidden style={{ fontSize: 20 }}>➕</span>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>
              צור פרויקט חדש
            </span>
            <span style={{ fontSize: 11, opacity: 0.8 }}>
              הגדרת פרויקט חדש — שם, סטטוס, מטרות, תאריך יעד
            </span>
          </span>
        </button>

        {/* Existing projects not yet in the bar. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              opacity: 0.7,
              color: '#cbd5e1',
            }}
          >
            פרויקטים קיימים
          </div>
          {availableProjects.length === 0 ? (
            <div
              style={{
                fontSize: 12,
                opacity: 0.55,
                fontStyle: 'italic',
                padding: '10px 12px',
                border: '1px dashed rgba(255,255,255,0.1)',
                borderRadius: 8,
              }}
            >
              כל הפרויקטים כבר בבּאר.
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                maxHeight: 320,
                overflowY: 'auto',
              }}
            >
              {availableProjects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onAddProject(p.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '9px 12px',
                    borderRadius: 8,
                    border: '1px solid rgba(255,255,255,0.08)',
                    background: 'rgba(255,255,255,0.04)',
                    color: '#e2e8f0',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    textAlign: 'start',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      'rgba(255,255,255,0.09)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      'rgba(255,255,255,0.04)';
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: '50%',
                      background: p.color ?? '#94a3b8',
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontWeight: 600,
                      fontSize: 13,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {p.name}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      opacity: 0.6,
                      flexShrink: 0,
                      padding: '1px 6px',
                      background: 'rgba(255,255,255,0.06)',
                      borderRadius: 4,
                    }}
                  >
                    {projectStatusLabel(p.status)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
