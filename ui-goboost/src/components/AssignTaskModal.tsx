import { useEffect, useState } from 'react';

import {
  createIssue,
  fetchAgentById,
  fetchCompanyGoals,
  fetchCompanyProjects,
  numericIdForAgentUuid,
  type PaperclipAgentDetail,
  type PaperclipGoal,
  type PaperclipProject,
} from '../paperclipApi.js';
import { ModalShell, primaryBtn, secondaryBtn } from './ProjectCreateModal.js';
import { TextArea, TextField } from './projectForm.js';

/**
 * AssignTaskModal — create a new issue assigned to a specific agent.
 *
 * Triggered by the ➕ button in `AgentActionToolbar`. Mirrors the
 * inline "new conversation" flow in WhatsAppPanel but as a standalone
 * dialog (the toolbar isn't tied to the chat panel — it lives over
 * the office canvas regardless of which chat thread is active).
 *
 * On submit:
 *   1. POST /companies/:id/issues with assigneeAgentId set.
 *   2. Dispatch `agentSelected` so the office re-homes onto this agent.
 *   3. The chat panel's existing forest subscription picks up the new
 *      issue and the operator sees it appear under the agent.
 */

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

export interface AssignTaskModalProps {
  agentUuid: string;
  onClose: () => void;
  /** Called with the created issue id so the caller can navigate to it. */
  onCreated?: (issueId: string) => void;
  /**
   * Pre-populated title — used by the "Ask CEO" path of NewAgentDialog,
   * which now reuses AssignTaskModal instead of carrying its own draft
   * UI. Operator can still edit before submitting.
   */
  initialTitle?: string;
  /** Pre-populated description; see `initialTitle`. */
  initialDescription?: string;
  /**
   * Header line shown above the form, used to clarify intent when the
   * modal is opened from a non-default flow (e.g. "Creating an agent
   * request — assigned to {CEO}").
   */
  contextHint?: string;
}

export function AssignTaskModal({
  agentUuid,
  onClose,
  onCreated,
  initialTitle,
  initialDescription,
  contextHint,
}: AssignTaskModalProps) {
  const [agent, setAgent] = useState<PaperclipAgentDetail | null>(null);
  const [projects, setProjects] = useState<PaperclipProject[]>([]);
  const [goals, setGoals] = useState<PaperclipGoal[]>([]);

  const [title, setTitle] = useState(initialTitle ?? '');
  const [description, setDescription] = useState(initialDescription ?? '');
  const [status, setStatus] = useState('todo');
  const [priority, setPriority] = useState('medium');
  const [goalId, setGoalId] = useState('');
  const [projectId, setProjectId] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchAgentById(agentUuid).then((a) => {
      if (!cancelled) setAgent(a);
    });
    void fetchCompanyProjects().then((p) => {
      if (!cancelled) setProjects(p);
    });
    void fetchCompanyGoals().then((g) => {
      if (!cancelled) setGoals(g);
    });
    return () => {
      cancelled = true;
    };
  }, [agentUuid]);

  const canSubmit = title.trim().length > 0 && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const created = await createIssue({
      title: title.trim(),
      description: description.trim(),
      assigneeAgentId: agentUuid,
      status,
      priority,
      ...(goalId ? { goalId } : {}),
    });
    setSubmitting(false);
    if (!created) {
      setError('יצירת המשימה נכשלה.');
      return;
    }
    // Re-home the office onto the assigned agent so the operator can
    // immediately watch the new task come to life. Same MessageEvent
    // shape used by the canvas-click flow in App.handleClick.
    const numId = numericIdForAgentUuid(agentUuid);
    if (numId != null) {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'agentSelected', id: numId },
        }),
      );
    }
    onCreated?.(created.id);
    onClose();
  };

  const headerTitle = agent
    ? `הקצה משימה ל-${agent.name}`
    : 'הקצה משימה';

  // `projectId` is captured for forward-compat (Paperclip's createIssue
  // accepts it on some installs) but our current `createIssue` helper
  // doesn't forward it — the project_id is set at the issue level by
  // Paperclip based on the linked goal's project. Showing the picker
  // anyway documents the intent and matches dashboard parity.
  const _projectIdRef = projectId;
  void _projectIdRef;

  return (
    <ModalShell title={headerTitle} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {contextHint ? (
          <div
            style={{
              fontSize: 12,
              color: '#cbd5e1',
              background: 'rgba(99,102,241,0.14)',
              border: '1px solid rgba(99,102,241,0.35)',
              padding: '8px 10px',
              borderRadius: 8,
              lineHeight: 1.5,
            }}
          >
            {contextHint}
          </div>
        ) : null}
        <TextField
          label="כותרת המשימה"
          value={title}
          onChange={setTitle}
          placeholder="מה הסוכן אמור לעשות"
          disabled={submitting}
          autoFocus
        />
        <TextArea
          label="תיאור"
          value={description}
          onChange={setDescription}
          placeholder="הקשר, מדדים, חומר רקע (אופציונלי)"
          disabled={submitting}
        />
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={labelStyle}>סטטוס התחלתי</span>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                disabled={submitting}
                style={fieldStyle}
              >
                <option value="backlog">תור</option>
                <option value="todo">לעשות</option>
                <option value="in_progress">בעבודה</option>
                <option value="in_review">בבדיקה</option>
              </select>
            </label>
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={labelStyle}>עדיפות</span>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                disabled={submitting}
                style={fieldStyle}
              >
                <option value="low">נמוכה</option>
                <option value="medium">בינונית</option>
                <option value="high">גבוהה</option>
                <option value="urgent">דחופה</option>
              </select>
            </label>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {goals.length > 0 ? (
            <div style={{ flex: 1, minWidth: 160 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={labelStyle}>🎯 מטרה</span>
                <select
                  value={goalId}
                  onChange={(e) => setGoalId(e.target.value)}
                  disabled={submitting}
                  style={fieldStyle}
                >
                  <option value="">ללא</option>
                  {goals.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}
          {projects.length > 0 ? (
            <div style={{ flex: 1, minWidth: 160 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={labelStyle}>פרויקט (קונטקסט)</span>
                <select
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  disabled={submitting}
                  style={fieldStyle}
                >
                  <option value="">ללא</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
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
            {submitting ? 'יוצר…' : 'הקצה משימה'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
