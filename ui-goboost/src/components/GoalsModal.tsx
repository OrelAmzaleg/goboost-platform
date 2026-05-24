import { useEffect, useMemo, useRef, useState } from 'react';

import {
  createGoal,
  deleteGoal,
  fetchCompanyGoals,
  GOAL_LEVELS,
  GOAL_STATUSES,
  subscribeActivity,
  updateGoal,
  type GoalLevel,
  type GoalStatus,
  type PaperclipGoal,
} from '../paperclipApi.js';
import { ModalShell, primaryBtn, secondaryBtn } from './ProjectCreateModal.js';
import { TextArea, TextField } from './projectForm.js';

/**
 * GoalsModal — manage the company's goals (CRUD).
 *
 * Session 1.4 reshape: flat list (no `level` grouping). Each row
 * carries a small `level` badge inline. This is a prerequisite for
 * Session 2's sub-goal display, where children render nested under
 * their parent regardless of level.
 *
 * Session 1.3 decision: ownerAgentId is NOT editable here — Paperclip
 * dashboard doesn't expose it as a form input either (write-only via
 * API). The field stays in the type for backend round-trips but the UI
 * neither sets nor displays it.
 */

export interface GoalsModalProps {
  onClose: () => void;
}

type Tab = 'list' | 'edit';

const LEVEL_LABELS: Record<GoalLevel, string> = {
  company: 'חברה',
  team: 'צוות',
  agent: 'סוכן',
  task: 'משימה',
};

const STATUS_LABELS: Record<GoalStatus, string> = {
  planned: 'מתוכנן',
  active: 'בעבודה',
  achieved: 'הושג',
  cancelled: 'בוטל',
};

const STATUS_COLOR: Record<GoalStatus, { bg: string; fg: string }> = {
  planned: { bg: 'rgba(148,163,184,0.22)', fg: '#cbd5e1' },
  active: { bg: 'rgba(34,197,94,0.22)', fg: '#bbf7d0' },
  achieved: { bg: 'rgba(56,189,248,0.22)', fg: '#bae6fd' },
  cancelled: { bg: 'rgba(248,113,113,0.22)', fg: '#fecaca' },
};

// Level badge — same family as status pill but cool-grey so the two
// can sit side-by-side without color clash.
const LEVEL_BADGE: Record<GoalLevel, { bg: string; fg: string }> = {
  company: { bg: 'rgba(99,102,241,0.22)', fg: '#c7d2fe' },
  team: { bg: 'rgba(168,85,247,0.22)', fg: '#e9d5ff' },
  agent: { bg: 'rgba(14,165,233,0.22)', fg: '#bae6fd' },
  task: { bg: 'rgba(100,116,139,0.22)', fg: '#cbd5e1' },
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  opacity: 0.8,
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

// When creating a sub-goal, suggest the next level down the hierarchy
// (operator can still override). `task` doesn't deepen further.
const NEXT_LEVEL_DOWN: Record<GoalLevel, GoalLevel> = {
  company: 'team',
  team: 'agent',
  agent: 'task',
  task: 'task',
};

export function GoalsModal({ onClose }: GoalsModalProps) {
  const [tab, setTab] = useState<Tab>('list');
  const [editingId, setEditingId] = useState<string | null>(null);
  // When the user clicks "+ sub-goal" on a row, the new goal needs to
  // open with `parentId` pre-filled. Tracked separately from the form
  // state itself so the hydration effect can see "is this a sub-goal
  // create?" and pick the right defaults.
  const [pendingParentId, setPendingParentId] = useState<string | null>(null);

  const [goals, setGoals] = useState<PaperclipGoal[]>([]);
  const [loading, setLoading] = useState(true);

  // Edit-tab form state.
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [level, setLevel] = useState<GoalLevel>('company');
  const [status, setStatus] = useState<GoalStatus>('planned');
  const [parentId, setParentId] = useState<string>('');

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchCompanyGoals().then((g) => {
      if (cancelled) return;
      setGoals(g);
      setLoading(false);
    });
    const unsub = subscribeActivity((payload) => {
      const entityType = String(payload.entityType ?? '');
      const action = String(payload.action ?? '');
      if (entityType !== 'goal' && !action.startsWith('goal.')) return;
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => {
        void fetchCompanyGoals().then((g) => {
          if (!cancelled) setGoals(g);
        });
      }, 400);
    });
    return () => {
      cancelled = true;
      unsub();
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, []);

  // Hydrate the form when entering the Edit tab for an existing goal.
  // For "new goal" (editingId === null) reset to a sane default.
  // When `pendingParentId` is set, we're creating a SUB-goal — pre-fill
  // the parent picker and suggest the next level down from the parent's
  // own level (operator can still override).
  useEffect(() => {
    if (tab !== 'edit') return;
    setError(null);
    if (editingId == null) {
      setTitle('');
      setDescription('');
      setStatus('planned');
      if (pendingParentId) {
        setParentId(pendingParentId);
        const parent = goals.find((x) => x.id === pendingParentId);
        setLevel(parent ? NEXT_LEVEL_DOWN[parent.level] : 'company');
      } else {
        setParentId('');
        setLevel('company');
      }
      return;
    }
    const g = goals.find((x) => x.id === editingId);
    if (!g) return;
    setTitle(g.title);
    setDescription(g.description ?? '');
    setLevel(g.level);
    setStatus(g.status);
    setParentId(g.parentId ?? '');
  }, [tab, editingId, pendingParentId, goals]);

  // Parent picker excludes self (cycle) and cancelled goals (clean tree).
  const parentOptions = useMemo(
    () =>
      goals.filter((g) => g.id !== editingId && g.status !== 'cancelled'),
    [goals, editingId],
  );

  // ── Tree build (Session 2) ───────────────────────────────────────
  //
  // Group goals by `parentId`. Roots are goals whose `parentId` is null
  // OR points to a goal not in our set (orphan = treat as root so it
  // doesn't vanish from the list). Within each level (roots OR a single
  // parent's children) we keep the previous sort: most-recently-touched
  // first.
  const goalById = useMemo(() => {
    const m = new Map<string, PaperclipGoal>();
    for (const g of goals) m.set(g.id, g);
    return m;
  }, [goals]);

  const childrenByParent = useMemo(() => {
    const m = new Map<string, PaperclipGoal[]>();
    const sortDesc = (a: PaperclipGoal, b: PaperclipGoal) =>
      (b.updatedAt ?? b.createdAt ?? '').localeCompare(
        a.updatedAt ?? a.createdAt ?? '',
      );
    for (const g of goals) {
      const pid = g.parentId;
      if (!pid || !goalById.has(pid)) continue;
      const bucket = m.get(pid);
      if (bucket) bucket.push(g);
      else m.set(pid, [g]);
    }
    for (const arr of m.values()) arr.sort(sortDesc);
    return m;
  }, [goals, goalById]);

  const rootGoals = useMemo(
    () =>
      [...goals]
        .filter((g) => !g.parentId || !goalById.has(g.parentId))
        .sort((a, b) =>
          (b.updatedAt ?? b.createdAt ?? '').localeCompare(
            a.updatedAt ?? a.createdAt ?? '',
          ),
        ),
    [goals, goalById],
  );

  // Breadcrumb to root, e.g. "Brand revamp › Q4 plan ›" for a deep goal.
  // Excludes the goal itself; returns null when there's no ancestor.
  const breadcrumbFor = (g: PaperclipGoal): string | null => {
    const chain: string[] = [];
    let cur = g.parentId ? goalById.get(g.parentId) : null;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.unshift(cur.title);
      cur = cur.parentId ? goalById.get(cur.parentId) : null;
    }
    return chain.length > 0 ? chain.join(' › ') : null;
  };

  const canSubmit = title.trim().length > 0 && !saving;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    // ownerAgentId is intentionally NOT sent — Paperclip dashboard
    // doesn't expose it as a UI control either (Session 1.3 decision).
    const body = {
      title: title.trim(),
      description: description.trim() || null,
      level,
      status,
      parentId: parentId || null,
    };
    const result =
      editingId == null
        ? await createGoal(body)
        : await updateGoal(editingId, body);
    setSaving(false);
    if (!result) {
      setError('שמירת המטרה נכשלה. נסה שוב.');
      return;
    }
    const fresh = await fetchCompanyGoals();
    setGoals(fresh);
    setTab('list');
    setEditingId(null);
    setPendingParentId(null);
  };

  const onDelete = async (goalId: string) => {
    if (!window.confirm('למחוק את המטרה הזו? פעולה זו אינה הפיכה.')) return;
    setDeleting(goalId);
    const ok = await deleteGoal(goalId);
    setDeleting(null);
    if (!ok) {
      setError('מחיקת המטרה נכשלה.');
      return;
    }
    const fresh = await fetchCompanyGoals();
    setGoals(fresh);
  };

  return (
    <ModalShell title="מטרות החברה" onClose={onClose} wide>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Tab strip — same visual language as ProjectEditModal */}
        <div
          style={{
            display: 'flex',
            gap: 4,
            borderBlockEnd: '1px solid rgba(255,255,255,0.1)',
            paddingBlockEnd: 8,
            alignItems: 'center',
          }}
        >
          {(
            [
              ['list', 'רשימה'],
              ['edit', editingId == null ? 'מטרה חדשה' : 'עריכת מטרה'],
            ] as [Tab, string][]
          ).map(([id, lbl]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              style={{
                padding: '5px 12px',
                borderRadius: 7,
                border: 'none',
                background: tab === id ? 'rgba(99,102,241,0.3)' : 'transparent',
                color: tab === id ? '#e0e7ff' : '#94a3b8',
                fontWeight: 700,
                fontSize: 12,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              {lbl}
            </button>
          ))}
          {tab === 'list' ? (
            <button
              type="button"
              onClick={() => {
                setEditingId(null);
                setPendingParentId(null);
                setTab('edit');
              }}
              style={{
                ...primaryBtn,
                padding: '5px 12px',
                fontSize: 12,
                marginInlineStart: 'auto',
              }}
            >
              + מטרה חדשה
            </button>
          ) : null}
        </div>

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

        {tab === 'list' ? (
          loading ? (
            <div style={{ fontSize: 13, color: '#94a3b8', padding: '20px 0' }}>
              טוען מטרות…
            </div>
          ) : goals.length === 0 ? (
            <div style={{ fontSize: 13, color: '#94a3b8', padding: '20px 0' }}>
              אין מטרות עדיין. הוסף את הראשונה.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {rootGoals.map((root) => (
                // Visual container per ROOT goal — wraps the parent row
                // and all descendants in one bordered card so the eye
                // reads "everything inside belongs to the same family".
                // Intermediate parents stay inline (only top-level roots
                // get the wrapper) to avoid nested-box-soup at depth.
                <div
                  key={root.id}
                  style={{
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: 10,
                    padding: 6,
                    background: 'rgba(255,255,255,0.02)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  <GoalSubtree
                    goal={root}
                    depth={0}
                    childrenByParent={childrenByParent}
                    breadcrumbFor={breadcrumbFor}
                    deletingId={deleting}
                    onEdit={(g) => {
                      setEditingId(g.id);
                      setPendingParentId(null);
                      setTab('edit');
                    }}
                    onCreateChild={(g) => {
                      setEditingId(null);
                      setPendingParentId(g.id);
                      setTab('edit');
                    }}
                    onDelete={(g) => void onDelete(g.id)}
                  />
                </div>
              ))}
            </div>
          )
        ) : (
          // ── Edit / Create tab ─────────────────────────────────────────
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <TextField
              label="כותרת"
              value={title}
              onChange={setTitle}
              placeholder="מה הסוכן/הצוות/החברה אמורים להשיג"
              disabled={saving}
              autoFocus
            />
            <TextArea
              label="תיאור"
              value={description}
              onChange={setDescription}
              placeholder="הקשר, מדדים, חומר רקע (אופציונלי)"
              disabled={saving}
            />
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 140 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={labelStyle}>רמה</span>
                  <select
                    value={level}
                    onChange={(e) => setLevel(e.target.value as GoalLevel)}
                    disabled={saving}
                    style={fieldStyle}
                  >
                    {GOAL_LEVELS.map((lvl) => (
                      <option
                        key={lvl}
                        value={lvl}
                        style={{ background: '#1e293b', color: '#f1f5f9' }}
                      >
                        {LEVEL_LABELS[lvl]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div style={{ flex: 1, minWidth: 140 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={labelStyle}>סטטוס</span>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value as GoalStatus)}
                    disabled={saving}
                    style={fieldStyle}
                  >
                    {GOAL_STATUSES.map((s) => (
                      <option
                        key={s}
                        value={s}
                        style={{ background: '#1e293b', color: '#f1f5f9' }}
                      >
                        {STATUS_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={labelStyle}>מטרת אב</span>
              <select
                value={parentId}
                onChange={(e) => setParentId(e.target.value)}
                disabled={saving}
                style={fieldStyle}
              >
                <option value="" style={{ background: '#1e293b', color: '#f1f5f9' }}>
                  ללא (מטרת שורש)
                </option>
                {parentOptions.map((g) => (
                  <option
                    key={g.id}
                    value={g.id}
                    style={{ background: '#1e293b', color: '#f1f5f9' }}
                  >
                    {LEVEL_LABELS[g.level]} · {g.title}
                  </option>
                ))}
              </select>
            </label>

            <div
              style={{
                display: 'flex',
                gap: 8,
                justifyContent: 'flex-end',
                marginBlockStart: 4,
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setTab('list');
                  setEditingId(null);
                  setPendingParentId(null);
                }}
                disabled={saving}
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
                {saving
                  ? 'שומר…'
                  : editingId == null
                    ? 'צור מטרה'
                    : 'שמור שינויים'}
              </button>
            </div>
          </div>
        )}
      </div>
    </ModalShell>
  );
}

// ── Recursive subtree ────────────────────────────────────────────
//
// Renders a goal row + all descendants with progressive indent. Sort
// order within each level was set by the caller (`childrenByParent`).
// Keeping the row component below shallow + passing only the handlers
// it needs means depth doesn't blow up renders.

function GoalSubtree({
  goal,
  depth,
  childrenByParent,
  breadcrumbFor,
  deletingId,
  onEdit,
  onCreateChild,
  onDelete,
}: {
  goal: PaperclipGoal;
  depth: number;
  childrenByParent: Map<string, PaperclipGoal[]>;
  breadcrumbFor: (g: PaperclipGoal) => string | null;
  deletingId: string | null;
  onEdit: (g: PaperclipGoal) => void;
  onCreateChild: (g: PaperclipGoal) => void;
  onDelete: (g: PaperclipGoal) => void;
}) {
  const children = childrenByParent.get(goal.id) ?? [];
  return (
    <>
      <GoalRow
        goal={goal}
        depth={depth}
        breadcrumb={breadcrumbFor(goal)}
        deleting={deletingId === goal.id}
        onEdit={() => onEdit(goal)}
        onCreateChild={() => onCreateChild(goal)}
        onDelete={() => onDelete(goal)}
      />
      {children.map((c) => (
        <GoalSubtree
          key={c.id}
          goal={c}
          depth={depth + 1}
          childrenByParent={childrenByParent}
          breadcrumbFor={breadcrumbFor}
          deletingId={deletingId}
          onEdit={onEdit}
          onCreateChild={onCreateChild}
          onDelete={onDelete}
        />
      ))}
    </>
  );
}

// ── List row ─────────────────────────────────────────────────────────

function GoalRow({
  goal,
  depth,
  breadcrumb,
  deleting,
  onEdit,
  onCreateChild,
  onDelete,
}: {
  goal: PaperclipGoal;
  depth: number;
  /** Ancestor chain joined with " › " — null for root goals. */
  breadcrumb: string | null;
  deleting: boolean;
  onEdit: () => void;
  onCreateChild: () => void;
  onDelete: () => void;
}) {
  const [hover, setHover] = useState(false);
  const statusColor = STATUS_COLOR[goal.status];
  const levelColor = LEVEL_BADGE[goal.level];
  // Cap depth indent so deeply nested goals stay readable in the modal.
  const indentPx = Math.min(depth, 6) * 18;
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onEdit}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
        paddingInlineStart: 10 + indentPx,
        background: hover ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 8,
        cursor: 'pointer',
        opacity: deleting ? 0.5 : 1,
      }}
    >
      {/* Tree-line glyph for non-root rows — keeps the eye anchored to
          the parent without drawing actual SVG connectors. */}
      {depth > 0 ? (
        <span
          aria-hidden
          style={{
            fontSize: 11,
            color: '#475569',
            flexShrink: 0,
            marginInlineEnd: -2,
          }}
        >
          ↳
        </span>
      ) : null}
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          padding: '2px 8px',
          borderRadius: 999,
          background: statusColor.bg,
          color: statusColor.fg,
          flexShrink: 0,
        }}
      >
        {STATUS_LABELS[goal.status]}
      </span>
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          padding: '2px 8px',
          borderRadius: 999,
          background: levelColor.bg,
          color: levelColor.fg,
          flexShrink: 0,
        }}
      >
        {LEVEL_LABELS[goal.level]}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: '#e2e8f0',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={goal.title}
        >
          {goal.title}
        </div>
        {breadcrumb ? (
          <div
            style={{
              fontSize: 11,
              color: '#94a3b8',
              marginBlockStart: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={breadcrumb}
          >
            {breadcrumb}
          </div>
        ) : null}
      </div>
      {/* + sub-goal — hover-reveal, opens edit form with parentId pre-filled */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onCreateChild();
        }}
        title="הוסף מטרת-משנה"
        aria-label="הוסף מטרת-משנה"
        style={{
          width: 26,
          height: 26,
          background: 'transparent',
          border: 'none',
          color: hover ? '#86efac' : 'transparent',
          fontSize: 16,
          cursor: 'pointer',
          padding: 0,
          flexShrink: 0,
          lineHeight: 1,
        }}
      >
        +
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        disabled={deleting}
        title="מחק מטרה"
        aria-label="מחק מטרה"
        style={{
          width: 26,
          height: 26,
          background: 'transparent',
          border: 'none',
          color: hover ? '#fca5a5' : 'transparent',
          fontSize: 14,
          cursor: deleting ? 'not-allowed' : 'pointer',
          padding: 0,
          flexShrink: 0,
        }}
      >
        🗑
      </button>
    </div>
  );
}
