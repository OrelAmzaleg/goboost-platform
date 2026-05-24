import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  createRoutine,
  createRoutineTrigger,
  cronToParts,
  deleteRoutine,
  deleteRoutineTrigger,
  describeCron,
  fetchAgentById,
  fetchCompanyRoutines,
  fetchRoutine,
  fetchRoutineRevisions,
  fetchRoutineRuns,
  partsToCron,
  restoreRoutineRevision,
  runRoutineNow,
  subscribeActivity,
  updateRoutine,
  updateRoutineTrigger,
  type PaperclipAgentDetail,
  type PaperclipRoutine,
  type PaperclipRoutineRevision,
  type PaperclipRoutineRun,
  type PaperclipRoutineTrigger,
  type PaperclipRoutineStatus,
  type SchedulePreset,
  type ScheduleParts,
} from '../paperclipApi.js';
import { ModalShell, primaryBtn, secondaryBtn } from './ProjectCreateModal.js';
import { TextArea, TextField } from './projectForm.js';

/**
 * RoutinesModal — per-agent routines manager.
 *
 * Two screens, internal navigation:
 *   • List view (default) — routines whose `assigneeAgentId` === this
 *     agent. Card per routine + a "+ routine חדשה" CTA.
 *   • Detail view — clicked routine. Header row with title, status
 *     toggle (active/paused), Run Now, Save. Below: 4 sub-tabs:
 *       Triggers / Runs / Activity / History.
 *
 * Triggers tab supports schedule kind only (webhook + api visible
 * read-only; their editing UI is captured in TECH_DEBT for a later
 * session). Schedule uses a preset → cron translator so the operator
 * sees "Every day at 09:00" instead of raw `0 9 * * *`.
 *
 * Activity tab is intentionally a placeholder — Paperclip's data is
 * an activity-log stream that needs cross-cutting infra to surface
 * here; deferred. History tab uses the routine-revisions endpoint.
 */

// ── Styles + helpers ────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  opacity: 0.85,
  color: '#cbd5e1',
};

const fieldStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.12)',
  background: '#1e293b',
  color: '#f1f5f9',
  fontFamily: 'inherit',
  fontSize: 13,
  outline: 'none',
  colorScheme: 'dark',
};

const STATUS_COLOR: Record<PaperclipRoutineStatus, { bg: string; fg: string }> = {
  active: { bg: 'rgba(34,197,94,0.22)', fg: '#bbf7d0' },
  paused: { bg: 'rgba(245,158,11,0.22)', fg: '#fde68a' },
  archived: { bg: 'rgba(100,116,139,0.22)', fg: '#cbd5e1' },
};

const STATUS_LABEL: Record<PaperclipRoutineStatus, string> = {
  active: 'פעילה',
  paused: 'מושהית',
  archived: 'בארכיון',
};

const RUN_STATUS_COLOR: Record<string, string> = {
  received: '#94a3b8',
  coalesced: '#a855f7',
  skipped: '#64748b',
  issue_created: '#0ea5e9',
  completed: '#22c55e',
};

const TRIGGER_KIND_LABEL: Record<string, string> = {
  schedule: 'תזמון',
  webhook: 'Webhook',
  api: 'API ידני',
};

const SCHEDULE_PRESET_LABEL: Record<SchedulePreset, string> = {
  minutely: 'כל דקה',
  hourly: 'כל שעה',
  daily: 'כל יום',
  weekly: 'כל שבוע',
  custom: 'מותאם (cron)',
};

const DAY_OF_WEEK_LABEL: Record<number, string> = {
  0: 'ראשון',
  1: 'שני',
  2: 'שלישי',
  3: 'רביעי',
  4: 'חמישי',
  5: 'שישי',
  6: 'שבת',
};

// ── Component ───────────────────────────────────────────────────

export interface RoutinesModalProps {
  agentUuid: string;
  onClose: () => void;
}

type View = 'list' | 'detail';

export function RoutinesModal({ agentUuid, onClose }: RoutinesModalProps) {
  const [view, setView] = useState<View>('list');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [routines, setRoutines] = useState<PaperclipRoutine[]>([]);
  const [agent, setAgent] = useState<PaperclipAgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Independent fetch of the agent record so the modal can be opened
  // from anywhere with just the UUID (App.tsx doesn't carry the full
  // record around). Caller doesn't need to know about agent shape.
  useEffect(() => {
    let cancelled = false;
    void fetchAgentById(agentUuid).then((a) => {
      if (!cancelled) setAgent(a);
    });
    return () => {
      cancelled = true;
    };
  }, [agentUuid]);

  const reload = useCallback(async () => {
    setLoading(true);
    const all = await fetchCompanyRoutines();
    // Server filter is by projectId only; we narrow by assignee here.
    const mine = all.filter((r) => r.assigneeAgentId === agentUuid);
    setRoutines(mine);
    setLoading(false);
  }, [agentUuid]);

  useEffect(() => {
    void reload();
    // Refresh on any routine.* activity so a routine created elsewhere
    // shows up here too.
    const unsub = subscribeActivity((payload) => {
      const et = String(payload.entityType ?? '');
      if (et !== 'routine' && et !== 'routine_trigger' && et !== 'routine_run') {
        return;
      }
      void reload();
    });
    return () => unsub();
  }, [reload]);

  const onCreate = async (title: string, description: string) => {
    if (!title.trim()) return;
    setCreating(true);
    setError(null);
    const created = await createRoutine({
      title: title.trim(),
      description: description.trim() || null,
      assigneeAgentId: agentUuid,
      status: 'paused', // draft routines stay paused until a trigger exists
    });
    setCreating(false);
    if (!created) {
      setError('יצירת הרוטינה נכשלה.');
      return;
    }
    await reload();
    setSelectedId(created.id);
    setView('detail');
  };

  const onDelete = async (routineId: string) => {
    if (
      !window.confirm(
        'למחוק את הרוטינה הזו? כל הטריגרים שלה ייעצרו. פעולה זו אינה הפיכה.',
      )
    ) {
      return;
    }
    const ok = await deleteRoutine(routineId);
    if (!ok) {
      window.alert('מחיקת הרוטינה נכשלה.');
      return;
    }
    await reload();
    if (selectedId === routineId) {
      setSelectedId(null);
      setView('list');
    }
  };

  // Agent name may still be loading on the very first paint; show "…"
  // so the modal opens immediately instead of waiting on the fetch.
  const agentName = agent?.name ?? '…';
  const headerTitle =
    view === 'detail' && selectedId
      ? `רוטינות · ${agentName}`
      : `רוטינות של ${agentName}`;

  return (
    <ModalShell title={headerTitle} onClose={onClose} xlarge>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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

        {view === 'list' ? (
          <RoutinesListView
            routines={routines}
            loading={loading}
            creating={creating}
            onOpen={(id) => {
              setSelectedId(id);
              setView('detail');
            }}
            onCreate={(t, d) => void onCreate(t, d)}
            onDelete={(id) => void onDelete(id)}
          />
        ) : selectedId ? (
          <RoutineDetailView
            routineId={selectedId}
            agentName={agentName}
            onBack={() => {
              setSelectedId(null);
              setView('list');
              void reload();
            }}
          />
        ) : null}
      </div>
    </ModalShell>
  );
}

// ── List view ───────────────────────────────────────────────────

function RoutinesListView({
  routines,
  loading,
  creating,
  onOpen,
  onCreate,
  onDelete,
}: {
  routines: PaperclipRoutine[];
  loading: boolean;
  creating: boolean;
  onOpen: (id: string) => void;
  onCreate: (title: string, description: string) => void;
  onDelete: (id: string) => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  if (loading) {
    return (
      <div style={{ fontSize: 13, color: '#94a3b8', padding: '20px 0' }}>
        טוען רוטינות…
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          borderBlockEnd: '1px solid rgba(255,255,255,0.1)',
          paddingBlockEnd: 10,
        }}
      >
        <button
          type="button"
          onClick={() => setShowForm((s) => !s)}
          style={{
            ...primaryBtn,
            padding: '6px 14px',
            fontSize: 12,
          }}
        >
          {showForm ? 'בטל' : '+ רוטינה חדשה'}
        </button>
        <span style={{ fontSize: 11, color: '#94a3b8', opacity: 0.8 }}>
          {routines.length} רוטינות שמוקצות לסוכן זה
        </span>
      </div>

      {/* Inline create form */}
      {showForm ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            padding: 12,
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.10)',
            borderRadius: 10,
          }}
        >
          <TextField
            label="כותרת"
            value={title}
            onChange={setTitle}
            placeholder="לדוגמה: סיכום יומי, סנכרון לקוחות"
            disabled={creating}
            autoFocus
          />
          <TextArea
            label="הוראות (אופציונלי)"
            value={description}
            onChange={setDescription}
            placeholder="מה הסוכן צריך לעשות כשהטריגר נורה"
            disabled={creating}
          />
          <div style={{ fontSize: 11, color: '#94a3b8' }}>
            רוטינה חדשה נוצרת במצב <strong>מושהית</strong>; הפעל אותה אחרי
            שתוסיף לפחות טריגר אחד.
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                setTitle('');
                setDescription('');
              }}
              disabled={creating}
              style={secondaryBtn}
            >
              ביטול
            </button>
            <button
              type="button"
              onClick={() => {
                onCreate(title, description);
                setShowForm(false);
                setTitle('');
                setDescription('');
              }}
              disabled={creating || !title.trim()}
              style={{
                ...primaryBtn,
                opacity: creating || !title.trim() ? 0.5 : 1,
                cursor:
                  creating || !title.trim() ? 'not-allowed' : 'pointer',
              }}
            >
              {creating ? 'יוצר…' : 'צור רוטינה'}
            </button>
          </div>
        </div>
      ) : null}

      {/* Routine list */}
      {routines.length === 0 ? (
        <div
          style={{
            fontSize: 13,
            color: '#94a3b8',
            padding: '24px 16px',
            background: 'rgba(255,255,255,0.03)',
            border: '1px dashed rgba(255,255,255,0.12)',
            borderRadius: 10,
            textAlign: 'center',
          }}
        >
          אין רוטינות לסוכן הזה עדיין.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {routines.map((r) => (
            <RoutineRow
              key={r.id}
              routine={r}
              onOpen={() => onOpen(r.id)}
              onDelete={() => onDelete(r.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RoutineRow({
  routine,
  onOpen,
  onDelete,
}: {
  routine: PaperclipRoutine;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [hover, setHover] = useState(false);
  const sc = STATUS_COLOR[routine.status] ?? STATUS_COLOR.paused;
  const firstSchedule = routine.triggers?.find((t) => t.kind === 'schedule');
  const triggerSummary = firstSchedule
    ? describeCron(firstSchedule.cronExpression ?? null)
    : routine.triggers && routine.triggers.length > 0
      ? `${routine.triggers.length} טריגרים`
      : 'ללא טריגרים';

  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
        background: hover
          ? 'rgba(255,255,255,0.06)'
          : 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 10,
        cursor: 'pointer',
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          padding: '2px 8px',
          borderRadius: 999,
          background: sc.bg,
          color: sc.fg,
          flexShrink: 0,
        }}
      >
        {STATUS_LABEL[routine.status] ?? routine.status}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: '#e2e8f0',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={routine.title}
        >
          {routine.title}
        </div>
        <div
          style={{
            fontSize: 11,
            color: '#94a3b8',
            marginBlockStart: 2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {triggerSummary}
          {routine.lastTriggeredAt
            ? ` · רץ לאחרונה ${new Date(routine.lastTriggeredAt).toLocaleString('he-IL')}`
            : ''}
        </div>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title="מחק רוטינה"
        aria-label="מחק רוטינה"
        style={{
          width: 26,
          height: 26,
          background: 'transparent',
          border: 'none',
          color: hover ? '#fca5a5' : 'transparent',
          fontSize: 14,
          cursor: 'pointer',
          padding: 0,
          flexShrink: 0,
        }}
      >
        🗑
      </button>
    </div>
  );
}

// ── Detail view ─────────────────────────────────────────────────

type DetailTab = 'triggers' | 'runs' | 'activity' | 'history';

const DETAIL_TAB_LABEL: Record<DetailTab, string> = {
  triggers: 'טריגרים',
  runs: 'הרצות',
  activity: 'פעילות',
  history: 'היסטוריה',
};

function RoutineDetailView({
  routineId,
  agentName,
  onBack,
}: {
  routineId: string;
  agentName: string;
  onBack: () => void;
}) {
  const [routine, setRoutine] = useState<PaperclipRoutine | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState<DetailTab>('triggers');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const r = await fetchRoutine(routineId);
    if (r) {
      setRoutine(r);
      setTitle(r.title);
      setDescription(r.description ?? '');
    }
    setLoading(false);
  }, [routineId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const dirty =
    routine != null &&
    (title.trim() !== routine.title.trim() ||
      (description.trim() || null) !== (routine.description?.trim() || null));

  const toggleStatus = async () => {
    if (!routine || saving) return;
    setSaving(true);
    const next: PaperclipRoutineStatus =
      routine.status === 'active' ? 'paused' : 'active';
    const updated = await updateRoutine(routineId, { status: next });
    setSaving(false);
    if (updated) setRoutine(updated);
  };

  const onSave = async () => {
    if (!routine) return;
    setSaving(true);
    setError(null);
    const updated = await updateRoutine(routineId, {
      title: title.trim(),
      description: description.trim() || null,
    });
    setSaving(false);
    if (!updated) {
      setError('שמירה נכשלה.');
      return;
    }
    setRoutine(updated);
    setSavedAt(Date.now());
  };

  const onRunNow = async () => {
    setRunning(true);
    const run = await runRoutineNow(routineId);
    setRunning(false);
    if (!run) {
      window.alert('הפעלה ידנית נכשלה.');
    }
    void reload();
  };

  if (loading || !routine) {
    return (
      <div style={{ fontSize: 13, color: '#94a3b8', padding: '20px 0' }}>
        טוען רוטינה…
      </div>
    );
  }

  const sc = STATUS_COLOR[routine.status] ?? STATUS_COLOR.paused;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Breadcrumb back */}
      <button
        type="button"
        onClick={onBack}
        style={{
          alignSelf: 'flex-start',
          padding: '4px 8px',
          fontSize: 11,
          borderRadius: 6,
          border: 'none',
          background: 'transparent',
          color: '#94a3b8',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        ← חזרה לרשימת הרוטינות
      </button>

      {/* Header: title + status toggle + run-now + save */}
      <div
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={saving}
          style={{
            ...fieldStyle,
            flex: 1,
            minWidth: 200,
            fontSize: 16,
            fontWeight: 700,
          }}
        />
        <button
          type="button"
          onClick={() => void toggleStatus()}
          disabled={saving || routine.status === 'archived'}
          title={routine.status === 'active' ? 'השהה' : 'הפעל'}
          style={{
            padding: '6px 14px',
            borderRadius: 999,
            border: `1px solid ${sc.fg}55`,
            background: sc.bg,
            color: sc.fg,
            cursor:
              saving || routine.status === 'archived'
                ? 'not-allowed'
                : 'pointer',
            fontWeight: 700,
            fontSize: 12,
            fontFamily: 'inherit',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            opacity: saving || routine.status === 'archived' ? 0.5 : 1,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: sc.fg,
            }}
          />
          {STATUS_LABEL[routine.status]}
        </button>
        <button
          type="button"
          onClick={() => void onRunNow()}
          disabled={running}
          style={{
            padding: '6px 12px',
            borderRadius: 7,
            border: '1px solid rgba(255,255,255,0.18)',
            background: 'rgba(255,255,255,0.06)',
            color: '#e2e8f0',
            cursor: running ? 'not-allowed' : 'pointer',
            fontWeight: 700,
            fontSize: 12,
            fontFamily: 'inherit',
            opacity: running ? 0.5 : 1,
          }}
        >
          {running ? 'מפעיל…' : '▶ הפעל עכשיו'}
        </button>
      </div>

      <div style={{ fontSize: 11, color: '#94a3b8' }}>
        מוקצה ל: <strong style={{ color: '#cbd5e1' }}>{agentName}</strong>
        {routine.lastTriggeredAt
          ? ` · נורה לאחרונה ${new Date(routine.lastTriggeredAt).toLocaleString('he-IL')}`
          : ' · עוד לא נורה'}
      </div>

      {/* Description editor */}
      <TextArea
        label="הוראות"
        value={description}
        onChange={setDescription}
        placeholder="מה הסוכן צריך לעשות כשהטריגר נורה"
        disabled={saving}
        rows={5}
      />

      {/* Save row */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          justifyContent: 'flex-end',
        }}
      >
        {error ? (
          <span style={{ fontSize: 11, color: '#fecaca' }}>{error}</span>
        ) : null}
        {savedAt && Date.now() - savedAt < 4000 ? (
          <span style={{ fontSize: 11, color: '#86efac' }}>נשמר ✓</span>
        ) : null}
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={saving || !dirty}
          style={{
            ...primaryBtn,
            opacity: saving || !dirty ? 0.5 : 1,
            cursor: saving || !dirty ? 'not-allowed' : 'pointer',
          }}
        >
          {saving ? 'שומר…' : 'שמור רוטינה'}
        </button>
      </div>

      {/* Sub-tabs */}
      <div
        style={{
          display: 'flex',
          gap: 4,
          borderBlockEnd: '1px solid rgba(255,255,255,0.1)',
          paddingBlockEnd: 6,
          marginBlockStart: 6,
        }}
      >
        {(['triggers', 'runs', 'activity', 'history'] as DetailTab[]).map(
          (id) => (
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
              {DETAIL_TAB_LABEL[id]}
            </button>
          ),
        )}
      </div>

      {tab === 'triggers' ? (
        <TriggersTab
          routineId={routineId}
          triggers={routine.triggers ?? []}
          onChanged={reload}
        />
      ) : tab === 'runs' ? (
        <RunsTabSubpanel routineId={routineId} />
      ) : tab === 'activity' ? (
        <ActivityPlaceholder />
      ) : (
        <HistoryTab routineId={routineId} onRestored={reload} />
      )}
    </div>
  );
}

// ── Triggers tab ────────────────────────────────────────────────

function TriggersTab({
  routineId,
  triggers,
  onChanged,
}: {
  routineId: string;
  triggers: PaperclipRoutineTrigger[];
  onChanged: () => Promise<void> | void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <AddScheduleTrigger
        routineId={routineId}
        onAdded={async () => {
          await onChanged();
        }}
      />
      {triggers.length === 0 ? (
        <div
          style={{
            fontSize: 12,
            color: '#94a3b8',
            padding: '12px 0',
            textAlign: 'center',
          }}
        >
          לא הוגדרו טריגרים. הוסף לפחות אחד כדי שהרוטינה תפעל.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {triggers.map((t) => (
            <TriggerRow
              key={t.id}
              trigger={t}
              onChanged={async () => {
                await onChanged();
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AddScheduleTrigger({
  routineId,
  onAdded,
}: {
  routineId: string;
  onAdded: () => Promise<void> | void;
}) {
  const [parts, setParts] = useState<ScheduleParts>({
    preset: 'daily',
    hour: 9,
    minute: 0,
  });
  const [label, setLabel] = useState('schedule');
  const [submitting, setSubmitting] = useState(false);

  const cron = useMemo(() => partsToCron(parts), [parts]);
  const canSubmit = cron.trim().length > 0 && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    await createRoutineTrigger(routineId, {
      kind: 'schedule',
      cronExpression: cron,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      label: label.trim() || undefined,
      enabled: true,
    });
    setSubmitting(false);
    await onAdded();
    // Reset for next add
    setLabel('schedule');
  };

  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: 10,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ ...labelStyle, marginBlockEnd: 2 }}>הוסף טריגר תזמון</div>
      <SchedulePartsEditor parts={parts} onChange={setParts} disabled={submitting} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}>
          <TextField
            label="תווית"
            value={label}
            onChange={setLabel}
            placeholder="schedule"
            disabled={submitting}
          />
        </div>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          style={{
            ...primaryBtn,
            opacity: canSubmit ? 1 : 0.5,
            cursor: canSubmit ? 'pointer' : 'not-allowed',
            flexShrink: 0,
          }}
        >
          {submitting ? 'מוסיף…' : '+ טריגר'}
        </button>
      </div>
      <div style={{ fontSize: 10, color: '#64748b' }}>
        cron: <code style={{ color: '#cbd5e1' }}>{cron}</code> ·{' '}
        {describeCron(cron)}
      </div>
    </div>
  );
}

function SchedulePartsEditor({
  parts,
  onChange,
  disabled,
}: {
  parts: ScheduleParts;
  onChange: (next: ScheduleParts) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <div style={{ minWidth: 140 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>תדירות</span>
          <select
            value={parts.preset}
            onChange={(e) =>
              onChange({ ...parts, preset: e.target.value as SchedulePreset })
            }
            disabled={disabled}
            style={fieldStyle}
          >
            {(['minutely', 'hourly', 'daily', 'weekly', 'custom'] as SchedulePreset[]).map(
              (p) => (
                <option
                  key={p}
                  value={p}
                  style={{ background: '#1e293b', color: '#f1f5f9' }}
                >
                  {SCHEDULE_PRESET_LABEL[p]}
                </option>
              ),
            )}
          </select>
        </label>
      </div>
      {parts.preset === 'weekly' ? (
        <div style={{ minWidth: 120 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={labelStyle}>יום</span>
            <select
              value={parts.dayOfWeek ?? 0}
              onChange={(e) =>
                onChange({ ...parts, dayOfWeek: Number(e.target.value) })
              }
              disabled={disabled}
              style={fieldStyle}
            >
              {Object.entries(DAY_OF_WEEK_LABEL).map(([k, v]) => (
                <option
                  key={k}
                  value={k}
                  style={{ background: '#1e293b', color: '#f1f5f9' }}
                >
                  {v}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      {parts.preset === 'daily' || parts.preset === 'weekly' ? (
        <div style={{ minWidth: 100 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={labelStyle}>שעה</span>
            <input
              type="number"
              min={0}
              max={23}
              value={parts.hour ?? 0}
              onChange={(e) =>
                onChange({ ...parts, hour: Math.max(0, Math.min(23, Number(e.target.value))) })
              }
              disabled={disabled}
              style={fieldStyle}
            />
          </label>
        </div>
      ) : null}
      {parts.preset === 'hourly' || parts.preset === 'daily' || parts.preset === 'weekly' ? (
        <div style={{ minWidth: 100 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={labelStyle}>דקה</span>
            <input
              type="number"
              min={0}
              max={59}
              value={parts.minute ?? 0}
              onChange={(e) =>
                onChange({
                  ...parts,
                  minute: Math.max(0, Math.min(59, Number(e.target.value))),
                })
              }
              disabled={disabled}
              style={fieldStyle}
            />
          </label>
        </div>
      ) : null}
      {parts.preset === 'custom' ? (
        <div style={{ flex: 1, minWidth: 200 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={labelStyle}>cron expression</span>
            <input
              type="text"
              value={parts.customCron ?? ''}
              onChange={(e) =>
                onChange({ ...parts, customCron: e.target.value })
              }
              disabled={disabled}
              placeholder="0 9 * * *"
              style={{
                ...fieldStyle,
                fontFamily:
                  "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
              }}
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}

function TriggerRow({
  trigger,
  onChanged,
}: {
  trigger: PaperclipRoutineTrigger;
  onChanged: () => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [parts, setParts] = useState<ScheduleParts>(() =>
    cronToParts(trigger.cronExpression ?? null),
  );
  const [label, setLabel] = useState(trigger.label ?? '');
  const [enabled, setEnabled] = useState(trigger.enabled);
  const [saving, setSaving] = useState(false);

  const isSchedule = trigger.kind === 'schedule';

  const onSave = async () => {
    if (!isSchedule) return;
    setSaving(true);
    await updateRoutineTrigger(trigger.id, {
      cronExpression: partsToCron(parts),
      timezone: trigger.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      label: label.trim() || undefined,
      enabled,
    });
    setSaving(false);
    setEditing(false);
    await onChanged();
  };

  const onDelete = async () => {
    if (!window.confirm('למחוק טריגר זה?')) return;
    await deleteRoutineTrigger(trigger.id);
    await onChanged();
  };

  const onToggleEnabled = async () => {
    setSaving(true);
    await updateRoutineTrigger(trigger.id, { enabled: !trigger.enabled });
    setSaving(false);
    await onChanged();
  };

  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 10,
        padding: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            padding: '2px 8px',
            borderRadius: 999,
            background: 'rgba(99,102,241,0.22)',
            color: '#c7d2fe',
            flexShrink: 0,
          }}
        >
          {TRIGGER_KIND_LABEL[trigger.kind] ?? trigger.kind}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>
          {trigger.label ?? 'ללא תווית'}
        </span>
        <span style={{ flex: 1, fontSize: 11, color: '#94a3b8' }}>
          {isSchedule ? describeCron(trigger.cronExpression ?? null) : ''}
        </span>
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11,
            color: '#cbd5e1',
            cursor: saving ? 'not-allowed' : 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={trigger.enabled}
            disabled={saving}
            onChange={() => void onToggleEnabled()}
            style={{
              width: 14,
              height: 14,
              accentColor: '#6366f1',
            }}
          />
          פעיל
        </label>
        {isSchedule ? (
          <button
            type="button"
            onClick={() => setEditing((e) => !e)}
            style={{
              padding: '4px 8px',
              fontSize: 11,
              borderRadius: 6,
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(255,255,255,0.06)',
              color: '#cbd5e1',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {editing ? 'סגור' : 'ערוך'}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void onDelete()}
          title="מחק טריגר"
          aria-label="מחק טריגר"
          style={{
            padding: '4px 8px',
            fontSize: 12,
            borderRadius: 6,
            border: '1px solid rgba(239,68,68,0.4)',
            background: 'rgba(239,68,68,0.12)',
            color: '#fecaca',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          🗑
        </button>
      </div>
      {!isSchedule ? (
        <div style={{ fontSize: 11, color: '#94a3b8' }}>
          טריגרים מסוג <strong>{TRIGGER_KIND_LABEL[trigger.kind]}</strong>{' '}
          זמינים לקריאה בלבד מהממשק הזה. ניתן לערוך אותם בדשבורד Paperclip.
        </div>
      ) : null}
      {editing && isSchedule ? (
        <>
          <SchedulePartsEditor parts={parts} onChange={setParts} disabled={saving} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <TextField
                label="תווית"
                value={label}
                onChange={setLabel}
                placeholder="schedule"
                disabled={saving}
              />
            </div>
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11,
                color: '#cbd5e1',
                paddingBlockEnd: 8,
              }}
            >
              <input
                type="checkbox"
                checked={enabled}
                disabled={saving}
                onChange={(e) => setEnabled(e.target.checked)}
                style={{ width: 14, height: 14, accentColor: '#6366f1' }}
              />
              enabled
            </label>
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={saving}
              style={{
                ...primaryBtn,
                padding: '6px 12px',
                fontSize: 12,
                opacity: saving ? 0.5 : 1,
                cursor: saving ? 'not-allowed' : 'pointer',
                flexShrink: 0,
              }}
            >
              {saving ? 'שומר…' : 'שמור'}
            </button>
          </div>
        </>
      ) : null}
      {trigger.nextRunAt ? (
        <div style={{ fontSize: 10, color: '#64748b' }}>
          הרצה הבאה: {new Date(trigger.nextRunAt).toLocaleString('he-IL')}
        </div>
      ) : null}
    </div>
  );
}

// ── Runs tab ────────────────────────────────────────────────────

function RunsTabSubpanel({ routineId }: { routineId: string }) {
  const [runs, setRuns] = useState<PaperclipRoutineRun[] | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const r = await fetchRoutineRuns(routineId);
    setRuns(r);
    setLoading(false);
  }, [routineId]);

  useEffect(() => {
    void reload();
    const unsub = subscribeActivity((payload) => {
      if (String(payload.entityType ?? '') !== 'routine_run') return;
      void reload();
    });
    return () => unsub();
  }, [reload]);

  if (loading) {
    return (
      <div style={{ fontSize: 12, color: '#94a3b8', padding: '12px 0' }}>
        טוען הרצות…
      </div>
    );
  }
  if (!runs || runs.length === 0) {
    return (
      <div style={{ fontSize: 12, color: '#94a3b8', padding: '12px 0' }}>
        עדיין לא היו הרצות.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {runs.map((r) => (
        <RunRowSmall key={r.id} run={r} />
      ))}
    </div>
  );
}

function RunRowSmall({ run }: { run: PaperclipRoutineRun }) {
  const color = RUN_STATUS_COLOR[run.status] ?? '#64748b';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 6,
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: color,
          flexShrink: 0,
        }}
        title={String(run.status)}
      />
      <span
        style={{
          fontSize: 10,
          fontFamily:
            "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
          background: 'rgba(0,0,0,0.35)',
          padding: '1px 6px',
          borderRadius: 3,
          color: '#cbd5e1',
          flexShrink: 0,
        }}
      >
        {run.id.slice(0, 8)}
      </span>
      <span style={{ fontSize: 11, color: '#cbd5e1', flexShrink: 0 }}>
        {String(run.source)}
      </span>
      <span style={{ fontSize: 11, color: '#94a3b8', flex: 1, minWidth: 0 }}>
        {run.linkedIssueId
          ? `issue: ${run.linkedIssueId.slice(0, 8)}`
          : run.failureReason
            ? `שגיאה: ${run.failureReason}`
            : ''}
      </span>
      <span style={{ fontSize: 11, color: '#94a3b8', flexShrink: 0 }}>
        {String(run.status)}
      </span>
      <span style={{ fontSize: 10, color: '#64748b', flexShrink: 0 }}>
        {new Date(run.triggeredAt).toLocaleString('he-IL')}
      </span>
    </div>
  );
}

// ── Activity tab (placeholder) ──────────────────────────────────

function ActivityPlaceholder() {
  return (
    <div
      style={{
        fontSize: 12,
        color: '#94a3b8',
        padding: '20px 16px',
        textAlign: 'center',
        background: 'rgba(255,255,255,0.03)',
        border: '1px dashed rgba(255,255,255,0.10)',
        borderRadius: 8,
      }}
    >
      <div style={{ fontSize: 22, marginBlockEnd: 6 }}>🚧</div>
      פעילות מפורטת (activity_log) — תוצג בסשן הבא; כרגע ה-Runs טאב מציג את
      ההיסטוריה הרלוונטית.
    </div>
  );
}

// ── History (revisions) tab ─────────────────────────────────────

function HistoryTab({
  routineId,
  onRestored,
}: {
  routineId: string;
  onRestored: () => Promise<void> | void;
}) {
  const [revisions, setRevisions] = useState<PaperclipRoutineRevision[] | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const r = await fetchRoutineRevisions(routineId);
    setRevisions(r);
    setLoading(false);
  }, [routineId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onRestore = async (revId: string) => {
    if (!window.confirm('לשחזר את הרוטינה לגרסה זו?')) return;
    setRestoring(revId);
    const ok = await restoreRoutineRevision(routineId, revId);
    setRestoring(null);
    if (!ok) {
      window.alert('שחזור נכשל.');
      return;
    }
    await reload();
    await onRestored();
  };

  if (loading) {
    return (
      <div style={{ fontSize: 12, color: '#94a3b8', padding: '12px 0' }}>
        טוען היסטוריה…
      </div>
    );
  }
  if (!revisions || revisions.length === 0) {
    return (
      <div style={{ fontSize: 12, color: '#94a3b8', padding: '12px 0' }}>
        אין גרסאות שמורות.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {revisions.map((rev) => (
        <div
          key={rev.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 10px',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: 6,
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: '1px 6px',
              borderRadius: 999,
              background: 'rgba(99,102,241,0.22)',
              color: '#c7d2fe',
              flexShrink: 0,
            }}
          >
            v{rev.revisionNumber}
          </span>
          <span
            style={{
              fontSize: 11,
              color: '#cbd5e1',
              flex: 1,
              minWidth: 0,
            }}
          >
            {rev.changedKeys && rev.changedKeys.length > 0
              ? `שינויים: ${rev.changedKeys.join(', ')}`
              : ''}
          </span>
          <span style={{ fontSize: 10, color: '#64748b' }}>
            {new Date(rev.createdAt).toLocaleString('he-IL')}
          </span>
          <button
            type="button"
            onClick={() => void onRestore(rev.id)}
            disabled={restoring === rev.id}
            title="שחזר גרסה"
            style={{
              padding: '4px 10px',
              fontSize: 11,
              borderRadius: 6,
              border: '1px solid rgba(99,102,241,0.55)',
              background: 'rgba(99,102,241,0.18)',
              color: '#e0e7ff',
              cursor: restoring === rev.id ? 'not-allowed' : 'pointer',
              opacity: restoring === rev.id ? 0.5 : 1,
              fontFamily: 'inherit',
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            {restoring === rev.id ? 'משחזר…' : 'שחזר'}
          </button>
        </div>
      ))}
    </div>
  );
}

