import { useMemo, useState } from 'react';

import {
  acceptInteraction,
  answerInteraction,
  rejectInteraction,
  type PaperclipThreadInteraction,
  type QuestionAnswer,
} from '../paperclipApi.js';

/**
 * InteractionCard — Stream 2 / Primitive #4 from CHAT_PANEL_DESIGN.md.
 *
 * Renders an `issue_thread_interactions` row. Three kinds:
 *   • suggest_tasks       — agent proposes a plan of N steps. Accept selects
 *                            which proposed tasks to actually create.
 *   • ask_user_questions  — agent needs answers to a list of questions, each
 *                            with options and a selectionMode ('single'|'multi').
 *                            Submitted via /respond — NOT /accept.
 *   • request_confirmation — single yes/no gate.
 *
 * Pending interactions are interactive (per-kind controls + Accept/Reject).
 * Resolved interactions render read-only with the recorded decision.
 *
 * IMPORTANT: this component is fed live data from the backend and MUST NOT
 * crash on unrecognized kind/status values — older or newer rows may carry
 * vocabulary the client doesn't know yet. `pickKindMeta` / `pickStatusMeta`
 * always return a usable default.
 */

export interface InteractionCardProps {
  interaction: PaperclipThreadInteraction;
  /** Issue id is needed for the respond/accept/reject calls. */
  issueId: string;
  size: (base: number) => number;
  formatTime: (iso: string) => string;
  /** Called after a successful submit so the parent can refresh. */
  onResolved?: (next: PaperclipThreadInteraction) => void;
}

// ── Paperclip payload/result shapes (mirror packages/shared/src/types/issue.ts)

interface QuestionOption {
  id: string;
  label: string;
  description?: string | null;
}
interface Question {
  id: string;
  prompt: string;
  helpText?: string | null;
  selectionMode: 'single' | 'multi';
  required?: boolean;
  options: QuestionOption[];
}
interface AskUserQuestionsPayload {
  version?: 1;
  title?: string | null;
  submitLabel?: string | null;
  questions?: Question[];
}

interface ProposedTask {
  clientKey?: string;
  title?: string;
  description?: string | null;
}
interface SuggestTasksPayload {
  version?: 1;
  title?: string | null;
  intro?: string | null;
  tasks?: ProposedTask[];
}

interface RequestConfirmationPayload {
  version?: 1;
  title?: string | null;
  prompt?: string;
  acceptLabel?: string;
  rejectLabel?: string;
}

// ── Visual maps with safe defaults ─────────────────────────────────────────

const KIND_META: Record<
  string,
  { label: string; icon: string; accent: string }
> = {
  suggest_tasks: { label: 'הצעת תוכנית', icon: '📋', accent: '#6366f1' },
  ask_user_questions: { label: 'שאלות הבהרה', icon: '❓', accent: '#0ea5e9' },
  request_confirmation: { label: 'דרוש אישור', icon: '✋', accent: '#f59e0b' },
};
const DEFAULT_KIND_META = { label: 'אינטראקציה', icon: '💬', accent: '#94a3b8' };

const STATUS_META: Record<
  string,
  { label: string; color: string }
> = {
  pending: { label: 'ממתין', color: '#f59e0b' },
  accepted: { label: 'אושר', color: '#22c55e' },
  answered: { label: 'נענה', color: '#22c55e' },
  rejected: { label: 'נדחה', color: '#dc2626' },
  cancelled: { label: 'בוטל', color: '#64748b' },
  expired: { label: 'פג תוקף', color: '#64748b' },
};
const DEFAULT_STATUS_META = { label: 'לא ידוע', color: '#94a3b8' };

function pickKindMeta(kind: string | null | undefined) {
  return KIND_META[kind ?? ''] ?? DEFAULT_KIND_META;
}
function pickStatusMeta(status: string | null | undefined) {
  return STATUS_META[status ?? ''] ?? DEFAULT_STATUS_META;
}

function readPayload<T>(interaction: PaperclipThreadInteraction): T {
  return (interaction.payload ?? {}) as T;
}

// ── Component ──────────────────────────────────────────────────────────────

export function InteractionCard({
  interaction,
  issueId,
  size,
  formatTime,
  onResolved,
}: InteractionCardProps) {
  const meta = pickKindMeta(interaction.kind);
  const status = pickStatusMeta(interaction.status);
  const isPending = interaction.status === 'pending';

  const [busy, setBusy] = useState<null | 'accept' | 'reject'>(null);
  const [error, setError] = useState<string | null>(null);

  // ── ask_user_questions: per-question selection state.
  // Keyed by question.id, value is the array of selected option.ids.
  // For selectionMode='single' the array has 0 or 1 entries; for 'multi'
  // it grows as the user clicks more options.
  const askPayload = useMemo(
    () =>
      interaction.kind === 'ask_user_questions'
        ? readPayload<AskUserQuestionsPayload>(interaction)
        : null,
    [interaction],
  );
  const askQuestions = useMemo(() => askPayload?.questions ?? [], [askPayload]);
  const [selections, setSelections] = useState<Record<string, string[]>>(() => {
    // Pre-populate from the existing result for resolved interactions
    // (lets the user see what was previously chosen).
    const initial: Record<string, string[]> = {};
    const existing = (interaction.result ?? {}) as {
      answers?: Array<{ questionId: string; optionIds?: string[] }>;
    };
    for (const ans of existing.answers ?? []) {
      if (ans.questionId) initial[ans.questionId] = ans.optionIds ?? [];
    }
    return initial;
  });

  const toggleOption = (q: Question, optionId: string) => {
    setSelections((prev) => {
      const current = prev[q.id] ?? [];
      if (q.selectionMode === 'single') {
        return { ...prev, [q.id]: current[0] === optionId ? [] : [optionId] };
      }
      // multi
      const next = current.includes(optionId)
        ? current.filter((id) => id !== optionId)
        : [...current, optionId];
      return { ...prev, [q.id]: next };
    });
  };

  // Required-questions guard.
  const missingRequired = askQuestions
    .filter((q) => q.required)
    .some((q) => !(selections[q.id]?.length ?? 0));

  const handleAccept = async () => {
    setBusy('accept');
    setError(null);
    let next: PaperclipThreadInteraction | null = null;

    if (interaction.kind === 'ask_user_questions') {
      const answers: QuestionAnswer[] = askQuestions.map((q) => ({
        questionId: q.id,
        optionIds: selections[q.id] ?? [],
      }));
      next = await answerInteraction(issueId, interaction.id, answers);
    } else if (interaction.kind === 'suggest_tasks') {
      const payload = readPayload<SuggestTasksPayload>(interaction);
      const keys = (payload.tasks ?? [])
        .map((t) => t.clientKey)
        .filter((k): k is string => typeof k === 'string' && k.length > 0);
      next = await acceptInteraction(issueId, interaction.id, keys);
    } else {
      // request_confirmation + any future kind — generic accept.
      next = await acceptInteraction(issueId, interaction.id);
    }

    setBusy(null);
    if (!next) {
      setError('פעולה נכשלה. נסה שוב.');
      return;
    }
    onResolved?.(next);
  };

  const handleReject = async () => {
    setBusy('reject');
    setError(null);
    const next = await rejectInteraction(issueId, interaction.id);
    setBusy(null);
    if (!next) {
      setError('פעולה נכשלה. נסה שוב.');
      return;
    }
    onResolved?.(next);
  };

  const acceptLabel = useMemo(() => {
    if (interaction.kind === 'request_confirmation') {
      return readPayload<RequestConfirmationPayload>(interaction).acceptLabel ?? 'אשר';
    }
    if (interaction.kind === 'ask_user_questions') {
      return askPayload?.submitLabel ?? 'שלח';
    }
    return 'אשר';
  }, [interaction, askPayload]);
  const rejectLabel =
    interaction.kind === 'request_confirmation'
      ? readPayload<RequestConfirmationPayload>(interaction).rejectLabel ?? 'דחה'
      : 'דחה';

  return (
    <div
      style={{
        alignSelf: 'stretch',
        background: 'rgba(30,41,59,0.85)',
        border: `1px solid ${meta.accent}55`,
        borderRadius: 12,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        color: '#e2e8f0',
        fontSize: size(13),
        lineHeight: 1.5,
        boxShadow: `0 2px 6px rgba(0,0,0,0.25), inset 0 0 0 1px ${meta.accent}22`,
      }}
    >
      {/* Header strip: icon + kind label + status pill */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          aria-hidden
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            background: `${meta.accent}33`,
            color: meta.accent,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: size(14),
            flexShrink: 0,
          }}
        >
          {meta.icon}
        </span>
        <span style={{ fontWeight: 700, fontSize: size(13), color: '#f1f5f9' }}>
          {meta.label}
        </span>
        <span
          style={{
            marginInlineStart: 'auto',
            fontSize: size(11),
            fontWeight: 700,
            padding: '2px 8px',
            borderRadius: 999,
            background: `${status.color}33`,
            color: status.color,
            border: `1px solid ${status.color}55`,
          }}
        >
          {status.label}
        </span>
      </div>

      {/* Optional title from the payload — Paperclip emits it for plans/questions. */}
      {(() => {
        const title =
          interaction.kind === 'ask_user_questions'
            ? askPayload?.title
            : interaction.kind === 'suggest_tasks'
              ? readPayload<SuggestTasksPayload>(interaction).title
              : readPayload<RequestConfirmationPayload>(interaction).title;
        return title ? (
          <div style={{ fontWeight: 700, fontSize: size(14), color: '#f1f5f9' }}>
            {title}
          </div>
        ) : null;
      })()}

      {/* Body: per-kind */}
      {interaction.kind === 'suggest_tasks' ? (
        <SuggestTasksBody payload={readPayload<SuggestTasksPayload>(interaction)} size={size} />
      ) : interaction.kind === 'ask_user_questions' ? (
        <AskQuestionsBody
          questions={askQuestions}
          size={size}
          interactive={isPending}
          selections={selections}
          onToggle={toggleOption}
        />
      ) : interaction.kind === 'request_confirmation' ? (
        <ConfirmationBody payload={readPayload<RequestConfirmationPayload>(interaction)} size={size} />
      ) : (
        // Unknown kind — render the raw body if any.
        <div style={{ fontSize: size(12), opacity: 0.7 }}>
          {String(interaction.payload ? JSON.stringify(interaction.payload).slice(0, 200) : '—')}
        </div>
      )}

      {/* Action row — only for pending. */}
      {isPending ? (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={() => void handleReject()}
            disabled={busy !== null}
            style={{
              padding: '6px 14px',
              borderRadius: 8,
              border: '1px solid rgba(248,113,113,0.5)',
              background: 'rgba(220,38,38,0.18)',
              color: '#fecaca',
              fontSize: size(12),
              fontWeight: 700,
              fontFamily: 'inherit',
              cursor: busy !== null ? 'not-allowed' : 'pointer',
              opacity: busy !== null ? 0.6 : 1,
            }}
          >
            {busy === 'reject' ? '…' : rejectLabel}
          </button>
          <button
            type="button"
            onClick={() => void handleAccept()}
            disabled={busy !== null || missingRequired}
            title={missingRequired ? 'חסרות תשובות לשאלות חובה' : undefined}
            style={{
              padding: '6px 14px',
              borderRadius: 8,
              border: '1px solid rgba(74,222,128,0.5)',
              background: 'rgba(34,197,94,0.22)',
              color: '#dcfce7',
              fontSize: size(12),
              fontWeight: 700,
              fontFamily: 'inherit',
              cursor:
                busy !== null || missingRequired ? 'not-allowed' : 'pointer',
              opacity: busy !== null || missingRequired ? 0.5 : 1,
            }}
          >
            {busy === 'accept' ? '…' : acceptLabel}
          </button>
        </div>
      ) : null}

      {/* Resolution footer */}
      {!isPending && interaction.resolvedAt ? (
        <div
          style={{
            fontSize: size(11),
            opacity: 0.7,
            paddingTop: 4,
            borderBlockStart: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          הוחלט: {formatTime(interaction.resolvedAt)}
        </div>
      ) : (
        <div style={{ fontSize: size(10), opacity: 0.5, textAlign: 'start' }}>
          {formatTime(interaction.createdAt)}
        </div>
      )}

      {error ? (
        <div
          style={{
            fontSize: size(11),
            color: '#fecaca',
            background: 'rgba(127,29,29,0.4)',
            padding: '4px 8px',
            borderRadius: 6,
          }}
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}

// ── Body variants ───────────────────────────────────────────────────────────

function SuggestTasksBody({
  payload,
  size,
}: {
  payload: SuggestTasksPayload;
  size: (base: number) => number;
}) {
  const tasks = payload.tasks ?? [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {payload.intro ? (
        <div style={{ fontSize: size(13), opacity: 0.9 }}>{payload.intro}</div>
      ) : null}
      {tasks.length === 0 ? (
        <div style={{ fontSize: size(12), opacity: 0.6, fontStyle: 'italic' }}>
          (אין משימות בהצעה)
        </div>
      ) : (
        <ol
          style={{
            margin: 0,
            paddingInlineStart: 22,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            fontSize: size(12),
          }}
        >
          {tasks.map((t, i) => (
            <li key={t.clientKey ?? i} style={{ lineHeight: 1.5 }}>
              <span style={{ fontWeight: 700 }}>{t.title ?? '—'}</span>
              {t.description ? (
                <span style={{ opacity: 0.75 }}> — {t.description}</span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function AskQuestionsBody({
  questions,
  size,
  interactive,
  selections,
  onToggle,
}: {
  questions: Question[];
  size: (base: number) => number;
  interactive: boolean;
  selections: Record<string, string[]>;
  onToggle: (q: Question, optionId: string) => void;
}) {
  if (questions.length === 0) {
    return (
      <div style={{ fontSize: size(12), opacity: 0.65, fontStyle: 'italic' }}>
        (אין שאלות בנגישות לתצוגה)
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {questions.map((q, i) => {
        const chosen = selections[q.id] ?? [];
        return (
          <div key={q.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span
                style={{
                  fontSize: size(10),
                  opacity: 0.6,
                  fontWeight: 700,
                  letterSpacing: 0.4,
                }}
              >
                שאלה {i + 1}
              </span>
              <span
                style={{
                  fontSize: size(10),
                  opacity: 0.6,
                  padding: '0 5px',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 3,
                  letterSpacing: 0.3,
                }}
              >
                {q.selectionMode === 'multi' ? 'בחירה מרובה' : 'בחירה יחידה'}
              </span>
              {q.required ? (
                <span
                  style={{
                    fontSize: size(10),
                    color: '#fbbf24',
                    fontWeight: 700,
                  }}
                >
                  חובה
                </span>
              ) : null}
            </div>
            <div style={{ fontSize: size(13), fontWeight: 600, lineHeight: 1.5 }}>
              {q.prompt}
            </div>
            {q.helpText ? (
              <div style={{ fontSize: size(11), opacity: 0.7 }}>{q.helpText}</div>
            ) : null}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {(q.options ?? []).map((opt) => {
                const selected = chosen.includes(opt.id);
                return (
                  <button
                    key={opt.id}
                    type="button"
                    disabled={!interactive}
                    onClick={() => interactive && onToggle(q, opt.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 10px',
                      background: selected
                        ? 'rgba(34,197,94,0.18)'
                        : 'rgba(255,255,255,0.04)',
                      border: selected
                        ? '1px solid rgba(74,222,128,0.6)'
                        : '1px solid rgba(255,255,255,0.1)',
                      borderRadius: 7,
                      color: '#e2e8f0',
                      fontFamily: 'inherit',
                      fontSize: size(12),
                      cursor: interactive ? 'pointer' : 'default',
                      textAlign: 'start',
                      transition: 'background 0.12s',
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius:
                          q.selectionMode === 'multi' ? 3 : '50%',
                        border: selected
                          ? '1px solid #4ade80'
                          : '1px solid rgba(255,255,255,0.3)',
                        background: selected ? '#22c55e' : 'transparent',
                        flexShrink: 0,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#0f172a',
                        fontSize: 10,
                        fontWeight: 900,
                      }}
                    >
                      {selected ? '✓' : ''}
                    </span>
                    <span style={{ fontWeight: 600 }}>{opt.label}</span>
                    {opt.description ? (
                      <span style={{ opacity: 0.7, fontSize: size(11) }}>
                        — {opt.description}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ConfirmationBody({
  payload,
  size,
}: {
  payload: RequestConfirmationPayload;
  size: (base: number) => number;
}) {
  return (
    <div style={{ fontSize: size(13), lineHeight: 1.55 }}>
      {payload.prompt ?? 'נדרש אישור כדי להמשיך.'}
    </div>
  );
}
