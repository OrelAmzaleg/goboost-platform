import { useEffect, useState } from 'react';

import {
  archiveProject,
  fetchCompanyGoals,
  fetchProjectById,
  setProjectBudget,
  updateProject,
  type PaperclipGoal,
  type PaperclipProject,
} from '../paperclipApi.js';
import { ModalShell } from './ProjectCreateModal.js';
import {
  ColorPicker,
  DateField,
  GoalMultiSelect,
  projectStatusLabel,
  StatusSelect,
  TextArea,
  TextField,
} from './projectForm.js';

/**
 * ProjectEditModal — edit an existing project, mirroring Paperclip's
 * project settings: Overview / Configuration / Budget tabs.
 *
 *   • Overview      — read-mostly snapshot of the project.
 *   • Configuration — editable name/description/status/color/date/goals,
 *                     plus a Danger Zone with a two-step Archive.
 *   • Budget        — set a lifetime budget cap (writes a budget policy).
 *
 * Out of scope (flagged in the plan): repo/local-folder workspace policy,
 * and reading live budget spend (lives in Paperclip's cost dashboard).
 */

export interface ProjectEditModalProps {
  projectId: string;
  onClose: () => void;
  /** Called after a save/archive so App can refetch + reconcile the bar. */
  onChanged: () => void;
  /** Called after archive so App can drop the project's tab. */
  onArchived: (projectId: string) => void;
}

type Tab = 'overview' | 'configuration' | 'budget';

export function ProjectEditModal({
  projectId,
  onClose,
  onChanged,
  onArchived,
}: ProjectEditModalProps) {
  const [tab, setTab] = useState<Tab>('overview');
  const [project, setProject] = useState<PaperclipProject | null>(null);
  const [goals, setGoals] = useState<PaperclipGoal[]>([]);
  const [loading, setLoading] = useState(true);

  // Editable form state — seeded from the project once it loads.
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState('backlog');
  const [color, setColor] = useState<string | null>(null);
  const [targetDate, setTargetDate] = useState('');
  const [selectedGoals, setSelectedGoals] = useState<string[]>([]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([fetchProjectById(projectId), fetchCompanyGoals()]).then(
      ([p, g]) => {
        if (cancelled) return;
        setGoals(g);
        if (p) {
          setProject(p);
          setName(p.name);
          setDescription(p.description ?? '');
          setStatus(p.status);
          setColor(p.color);
          setTargetDate(p.targetDate ? p.targetDate.slice(0, 10) : '');
          setSelectedGoals(p.goalIds ?? []);
        }
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const save = async () => {
    if (!name.trim()) {
      setSaveError('שם הפרויקט לא יכול להיות ריק.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    const updated = await updateProject(projectId, {
      name: name.trim(),
      description: description.trim() || null,
      status,
      color,
      targetDate: targetDate || null,
      goalIds: selectedGoals,
    });
    setSaving(false);
    if (!updated) {
      setSaveError('שמירת הפרויקט נכשלה. נסה שוב.');
      return;
    }
    setProject(updated);
    setSavedAt(Date.now());
    onChanged();
  };

  return (
    <ModalShell
      title={`עריכת פרויקט${project ? ` · ${project.name}` : ''}`}
      onClose={onClose}
      wide
    >
      {loading ? (
        <div style={{ fontSize: 13, color: '#94a3b8', padding: '20px 0' }}>
          טוען פרטי פרויקט…
        </div>
      ) : !project ? (
        <div style={{ fontSize: 13, color: '#fecaca', padding: '20px 0' }}>
          לא ניתן לטעון את הפרויקט.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Tab strip */}
          <div
            style={{
              display: 'flex',
              gap: 4,
              borderBlockEnd: '1px solid rgba(255,255,255,0.1)',
              paddingBlockEnd: 8,
            }}
          >
            {(
              [
                ['overview', 'סקירה'],
                ['configuration', 'הגדרות'],
                ['budget', 'תקציב'],
              ] as [Tab, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                style={{
                  padding: '5px 12px',
                  borderRadius: 7,
                  border: 'none',
                  background:
                    tab === id ? 'rgba(99,102,241,0.3)' : 'transparent',
                  color: tab === id ? '#e0e7ff' : '#94a3b8',
                  fontWeight: 700,
                  fontSize: 12,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'overview' ? (
            <OverviewTab project={project} goals={goals} />
          ) : tab === 'configuration' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <TextField
                label="שם הפרויקט"
                value={name}
                onChange={setName}
                disabled={saving}
              />
              <TextArea
                label="תיאור"
                value={description}
                onChange={setDescription}
                disabled={saving}
              />
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 140 }}>
                  <StatusSelect
                    value={status}
                    onChange={setStatus}
                    disabled={saving}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 140 }}>
                  <DateField
                    label="תאריך יעד"
                    value={targetDate}
                    onChange={setTargetDate}
                    disabled={saving}
                  />
                </div>
              </div>
              <ColorPicker
                value={color}
                onChange={setColor}
                disabled={saving}
              />
              <GoalMultiSelect
                goals={goals}
                selected={selectedGoals}
                disabled={saving}
                onToggle={(id) =>
                  setSelectedGoals((prev) =>
                    prev.includes(id)
                      ? prev.filter((x) => x !== id)
                      : [...prev, id],
                  )
                }
              />
              {saveError ? (
                <div style={errorBoxStyle}>{saveError}</div>
              ) : null}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  justifyContent: 'flex-end',
                }}
              >
                {savedAt ? (
                  <span style={{ fontSize: 11, color: '#4ade80' }}>
                    נשמר ✓
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={saving}
                  style={{
                    ...primaryBtnStyle,
                    opacity: saving ? 0.6 : 1,
                    cursor: saving ? 'not-allowed' : 'pointer',
                  }}
                >
                  {saving ? 'שומר…' : 'שמור שינויים'}
                </button>
              </div>

              {/* Danger Zone — Archive. */}
              <DangerZone
                project={project}
                onArchived={() => {
                  onArchived(projectId);
                  onClose();
                }}
              />
            </div>
          ) : (
            <BudgetTab projectId={projectId} />
          )}
        </div>
      )}
    </ModalShell>
  );
}

// ── Overview tab ─────────────────────────────────────────────────────────────

function OverviewTab({
  project,
  goals,
}: {
  project: PaperclipProject;
  goals: PaperclipGoal[];
}) {
  const linkedGoals = goals.filter((g) =>
    (project.goalIds ?? []).includes(g.id),
  );
  const fmt = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString('he-IL', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      });
    } catch {
      return iso;
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Row label="סטטוס">
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            padding: '2px 8px',
            borderRadius: 999,
            background: 'rgba(99,102,241,0.25)',
            color: '#e0e7ff',
          }}
        >
          {projectStatusLabel(project.status)}
        </span>
      </Row>
      {project.description ? (
        <Row label="תיאור">
          <span style={{ whiteSpace: 'pre-wrap' }}>{project.description}</span>
        </Row>
      ) : null}
      {project.targetDate ? (
        <Row label="תאריך יעד">{fmt(project.targetDate)}</Row>
      ) : null}
      {linkedGoals.length > 0 ? (
        <Row label="מטרות">
          {linkedGoals.map((g) => g.title).join(' · ')}
        </Row>
      ) : null}
      <Row label="נוצר">{fmt(project.createdAt)}</Row>
      <Row label="עודכן">{fmt(project.updatedAt)}</Row>
      {project.archivedAt ? (
        <Row label="ארכיון">{fmt(project.archivedAt)}</Row>
      ) : null}
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', gap: 10, fontSize: 13 }}>
      <span
        style={{
          width: 84,
          flexShrink: 0,
          opacity: 0.6,
          fontWeight: 700,
          fontSize: 11,
        }}
      >
        {label}
      </span>
      <span style={{ flex: 1, minWidth: 0, color: '#e2e8f0' }}>
        {children}
      </span>
    </div>
  );
}

// ── Danger Zone (archive) ────────────────────────────────────────────────────

function DangerZone({
  project,
  onArchived,
}: {
  project: PaperclipProject;
  onArchived: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doArchive = async () => {
    setBusy(true);
    setError(null);
    const ok = await archiveProject(project.id);
    setBusy(false);
    if (!ok) {
      setError('הארכוב נכשל. נסה שוב.');
      return;
    }
    onArchived();
  };

  return (
    <div
      style={{
        marginBlockStart: 6,
        padding: 12,
        border: '1px solid rgba(248,113,113,0.4)',
        borderRadius: 8,
        background: 'rgba(220,38,38,0.08)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 700, color: '#fca5a5' }}>
        אזור מסוכן
      </div>
      <div style={{ fontSize: 12, color: '#fecaca', opacity: 0.85 }}>
        ארכוב הפרויקט מסתיר אותו מהבּאר וממסנני הפרויקטים. ניתן לשחזר אותו
        מאוחר יותר ב-Paperclip.
      </div>
      {error ? <div style={errorBoxStyle}>{error}</div> : null}
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          style={{
            alignSelf: 'flex-start',
            padding: '6px 14px',
            borderRadius: 8,
            border: '1px solid rgba(248,113,113,0.6)',
            background: 'rgba(220,38,38,0.2)',
            color: '#fecaca',
            fontSize: 12,
            fontWeight: 700,
            fontFamily: 'inherit',
            cursor: 'pointer',
          }}
        >
          ארכב פרויקט
        </button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#fecaca' }}>
            לארכב את "{project.name}"?
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy}
              style={{
                padding: '6px 12px',
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'transparent',
                color: '#cbd5e1',
                fontSize: 12,
                fontWeight: 600,
                fontFamily: 'inherit',
                cursor: busy ? 'not-allowed' : 'pointer',
              }}
            >
              ביטול
            </button>
            <button
              type="button"
              onClick={() => void doArchive()}
              disabled={busy}
              style={{
                padding: '6px 14px',
                borderRadius: 8,
                border: '1px solid rgba(248,113,113,0.7)',
                background: 'rgba(220,38,38,0.45)',
                color: '#fff',
                fontSize: 12,
                fontWeight: 700,
                fontFamily: 'inherit',
                cursor: busy ? 'not-allowed' : 'pointer',
              }}
            >
              {busy ? 'מארכב…' : 'כן, ארכב'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Budget tab ───────────────────────────────────────────────────────────────

function BudgetTab({ projectId }: { projectId: string }) {
  // The cap is entered in dollars for readability; sent in cents.
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<'ok' | 'fail' | null>(null);

  const save = async () => {
    const dollars = Number.parseFloat(amount);
    if (!Number.isFinite(dollars) || dollars < 0) {
      setResult('fail');
      return;
    }
    setBusy(true);
    setResult(null);
    const ok = await setProjectBudget(projectId, Math.round(dollars * 100));
    setBusy(false);
    setResult(ok ? 'ok' : 'fail');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 12, color: '#cbd5e1', opacity: 0.85 }}>
        הגדר תקרת תקציב (lifetime) לפרויקט. צריכת התקציב החיה והדוחות
        המלאים נמצאים בלוח העלויות של Paperclip.
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 11, fontWeight: 700, opacity: 0.8, color: '#cbd5e1' }}>
          תקרת תקציב ($)
        </span>
        <input
          type="number"
          min={0}
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="לדוגמה: 250"
          disabled={busy}
          style={{
            padding: '8px 10px',
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.12)',
            background: 'rgba(255,255,255,0.06)',
            color: '#f1f5f9',
            fontFamily: 'inherit',
            fontSize: 13,
            outline: 'none',
          }}
        />
      </label>
      {result === 'ok' ? (
        <div style={{ fontSize: 12, color: '#4ade80' }}>תקרת התקציב נשמרה ✓</div>
      ) : result === 'fail' ? (
        <div style={errorBoxStyle}>שמירת התקציב נכשלה. בדוק את הסכום ונסה שוב.</div>
      ) : null}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || amount.trim() === ''}
          style={{
            ...primaryBtnStyle,
            opacity: busy || amount.trim() === '' ? 0.5 : 1,
            cursor: busy || amount.trim() === '' ? 'not-allowed' : 'pointer',
          }}
        >
          {busy ? 'שומר…' : 'שמור תקציב'}
        </button>
      </div>
    </div>
  );
}

// ── Shared styles ────────────────────────────────────────────────────────────

const primaryBtnStyle: React.CSSProperties = {
  padding: '8px 16px',
  borderRadius: 8,
  border: '1px solid rgba(34,197,94,0.6)',
  background: 'rgba(34,197,94,0.28)',
  color: '#dcfce7',
  fontSize: 13,
  fontWeight: 700,
  fontFamily: 'inherit',
};

const errorBoxStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#fecaca',
  background: 'rgba(127,29,29,0.4)',
  padding: '6px 10px',
  borderRadius: 6,
};
