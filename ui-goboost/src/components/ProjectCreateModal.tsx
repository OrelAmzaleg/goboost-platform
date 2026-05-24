import { useEffect, useState } from 'react';

import {
  createProject,
  fetchCompanyGoals,
  type PaperclipGoal,
  type PaperclipProject,
} from '../paperclipApi.js';
import {
  ColorPicker,
  DateField,
  GoalMultiSelect,
  PROJECT_COLORS,
  StatusSelect,
  TextArea,
  TextField,
} from './projectForm.js';

/**
 * ProjectCreateModal — creates a new Paperclip project.
 *
 * Covers the core fields of Paperclip's NewProjectDialog: name, status,
 * color, description, goals, target date. Repo/local-folder config is
 * deferred to the edit modal's Configuration tab (the workspace policy
 * mapping is involved enough to keep out of the create path).
 */

export interface ProjectCreateModalProps {
  onClose: () => void;
  /** Called with the created project so the bar can add + select its tab. */
  onCreated: (project: PaperclipProject) => void;
}

export function ProjectCreateModal({
  onClose,
  onCreated,
}: ProjectCreateModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState('backlog');
  const [color, setColor] = useState<string>(PROJECT_COLORS[0]!);
  const [targetDate, setTargetDate] = useState('');
  const [goals, setGoals] = useState<PaperclipGoal[]>([]);
  const [selectedGoals, setSelectedGoals] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchCompanyGoals().then((g) => {
      if (!cancelled) setGoals(g);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const canSubmit = name.trim().length > 0 && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const created = await createProject({
      name: name.trim(),
      description: description.trim() || null,
      status,
      color,
      targetDate: targetDate || null,
      goalIds: selectedGoals,
    });
    setSubmitting(false);
    if (!created) {
      setError('יצירת הפרויקט נכשלה. נסה שוב.');
      return;
    }
    onCreated(created);
  };

  return (
    <ModalShell title="פרויקט חדש" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <TextField
          label="שם הפרויקט"
          value={name}
          onChange={setName}
          placeholder="שם קצר וברור"
          disabled={submitting}
          autoFocus
        />
        <TextArea
          label="תיאור"
          value={description}
          onChange={setDescription}
          placeholder="מה הפרויקט הזה — הקשר, מטרה (אופציונלי)"
          disabled={submitting}
        />
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 140 }}>
            <StatusSelect
              value={status}
              onChange={setStatus}
              disabled={submitting}
            />
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <DateField
              label="תאריך יעד"
              value={targetDate}
              onChange={setTargetDate}
              disabled={submitting}
            />
          </div>
        </div>
        <ColorPicker value={color} onChange={setColor} disabled={submitting} />
        <GoalMultiSelect
          goals={goals}
          selected={selectedGoals}
          disabled={submitting}
          onToggle={(id) =>
            setSelectedGoals((prev) =>
              prev.includes(id)
                ? prev.filter((x) => x !== id)
                : [...prev, id],
            )
          }
        />
        {error ? (
          <div
            style={{
              fontSize: 12,
              color: '#fecaca',
              background: 'rgba(127,29,29,0.4)',
              padding: '6px 10px',
              borderRadius: 6,
            }}
          >
            {error}
          </div>
        ) : null}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            style={secondaryBtn}
          >
            ביטול
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            style={{
              ...primaryBtn,
              opacity: canSubmit ? 1 : 0.5,
              cursor: canSubmit ? 'pointer' : 'not-allowed',
            }}
          >
            {submitting ? 'יוצר…' : 'צור פרויקט'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ── Shared modal shell ───────────────────────────────────────────────────────

export function ModalShell({
  title,
  onClose,
  children,
  wide,
  xlarge,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
  /**
   * Significantly wider modal (90vw, capped at 1100px) — used by the
   * OrgChartModal so the visual tree has horizontal room. Overrides
   * `wide` when both are set.
   */
  xlarge?: boolean;
}) {
  return (
    <div
      onClick={onClose}
      dir="rtl"
      className="gb-chat-panel-scope"
      style={
        {
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.6)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: 20,
          ['--gb-chat-font' as string]:
            "'Heebo', system-ui, -apple-system, sans-serif",
        } as React.CSSProperties
      }
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: xlarge
            ? 'min(1100px, 92vw)'
            : wide
              ? 'min(640px, 100%)'
              : 'min(460px, 100%)',
          maxHeight: '88vh',
          background: '#0f172a',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 12,
          boxShadow: '0 12px 36px rgba(0,0,0,0.55)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <header
          style={{
            padding: '12px 16px',
            background: 'linear-gradient(90deg, #4f46e5 0%, #7c3aed 100%)',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ fontWeight: 700, fontSize: 15, flex: 1 }}>
            {title}
          </span>
          <button
            type="button"
            onClick={onClose}
            title="סגור"
            aria-label="סגור"
            style={{
              width: 28,
              height: 28,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(255,255,255,0.15)',
              color: '#fff',
              border: 'none',
              borderRadius: 7,
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 16,
              fontWeight: 700,
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </header>
        <div style={{ padding: 16, overflowY: 'auto' }}>{children}</div>
      </div>
    </div>
  );
}

export const primaryBtn: React.CSSProperties = {
  padding: '8px 16px',
  borderRadius: 8,
  border: '1px solid rgba(34,197,94,0.6)',
  background: 'rgba(34,197,94,0.28)',
  color: '#dcfce7',
  fontSize: 13,
  fontWeight: 700,
  fontFamily: 'inherit',
};

export const secondaryBtn: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'transparent',
  color: '#cbd5e1',
  fontSize: 13,
  fontWeight: 600,
  fontFamily: 'inherit',
  cursor: 'pointer',
};
