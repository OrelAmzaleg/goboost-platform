import { useEffect, useMemo, useState } from 'react';

import {
  AGENT_ADAPTER_TYPES,
  createAgentHire,
  createCompany,
  createGoal,
  createIssue,
  type AgentAdapterType,
  type PaperclipCompany,
} from '../paperclipApi.js';

/**
 * CompanyOnboardingWizard — full-screen 4-step flow to spin up a new
 * workspace. Mirrors Paperclip's OnboardingWizard.
 *
 * Steps (input collection only; no endpoint hits until step 4):
 *   1. Company  — name (req) + description + first goal (optional)
 *   2. Agent    — name (default "CEO") + adapter (cards)
 *   3. Task     — title (req) + description
 *   4. Launch   — review + "🚀 שגר workspace" fires ALL endpoints
 *                 sequentially (company → goal → agent → issue),
 *                 then calls `onLaunch(company)`.
 *
 * The "defer to launch" model is the bug fix for the earlier version
 * that created the company on step 1 and left it orphaned if the
 * user closed the wizard before finishing.
 *
 * Typography is intentionally larger here than in the rest of the app
 * — this is a one-time onboarding flow where reading clearly matters
 * more than information density.
 */

const ADAPTER_LABELS: Record<string, string> = {
  claude_local: 'Claude Code',
  codex_local: 'Codex',
  cursor: 'Cursor',
  cursor_cloud: 'Cursor Cloud',
  gemini_local: 'Gemini CLI',
  grok_local: 'Grok Build',
  hermes_local: 'Hermes Agent',
  openclaw_gateway: 'OpenClaw Gateway',
  opencode_local: 'OpenCode',
  pi_local: 'Pi',
};

const ADAPTER_DESCRIPTIONS: Record<string, string> = {
  claude_local: 'Local Claude agent',
  codex_local: 'Local Codex agent',
  cursor: 'Local Cursor agent',
  cursor_cloud: 'Managed remote Cursor agent',
  gemini_local: 'Local Gemini agent',
  grok_local: 'Local Grok Build agent',
  hermes_local: 'Local Hermes CLI agent',
  openclaw_gateway: 'Invoke OpenClaw via gateway protocol',
  opencode_local: 'Local multi-provider agent',
  pi_local: 'Local Pi agent',
};

// Long-text-friendly font stack for inputs/textareas. Heebo is heavy
// at small sizes; system fonts read cleaner for descriptions.
const TEXT_FONT_STACK =
  "system-ui, -apple-system, 'Segoe UI', Roboto, 'Heebo', sans-serif";

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '11px 14px',
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.16)',
  background: '#1e293b',
  color: '#f1f5f9',
  fontFamily: TEXT_FONT_STACK,
  fontSize: 15,
  fontWeight: 400,
  outline: 'none',
  colorScheme: 'dark',
  lineHeight: 1.5,
};

const labelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: '#cbd5e1',
  marginBlockEnd: 6,
  display: 'block',
};

const hintStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#94a3b8',
  lineHeight: 1.65,
  fontFamily: TEXT_FONT_STACK,
};

export interface CompanyOnboardingWizardProps {
  /** True if there are zero companies (first-run state). ✕ Cancel hidden. */
  isFirstRun: boolean;
  onClose: () => void;
  /** Fires after the launch step succeeds end-to-end. */
  onLaunch: (company: PaperclipCompany) => void;
}

type Step = 1 | 2 | 3 | 4;

const STEP_TITLES: Record<Step, string> = {
  1: 'הקמת חברה',
  2: 'יצירת CEO',
  3: 'משימה ראשונה',
  4: 'שיגור',
};

export function CompanyOnboardingWizard({
  isFirstRun,
  onClose,
  onLaunch,
}: CompanyOnboardingWizardProps) {
  const [step, setStep] = useState<Step>(1);
  const [launching, setLaunching] = useState(false);
  const [launchProgress, setLaunchProgress] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // Step 1 — Company
  const [companyName, setCompanyName] = useState('');
  const [companyDescription, setCompanyDescription] = useState('');
  const [firstGoal, setFirstGoal] = useState('');

  // Step 2 — Agent
  const [agentName, setAgentName] = useState('CEO');
  const [adapterType, setAdapterType] = useState<AgentAdapterType>(
    'claude_local',
  );

  // Step 3 — Task
  const [taskTitle, setTaskTitle] = useState('Welcome to your workspace');
  const [taskDescription, setTaskDescription] = useState(
    'הצג את עצמך והסבר איך הסוכנים בארגון יכולים לעזור לי.',
  );

  // Cmd+Enter to advance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        advance();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  // Per-step validity (no endpoint calls — pure input check).
  const canAdvance = useMemo(() => {
    if (launching) return false;
    if (step === 1) return companyName.trim().length > 0;
    if (step === 2) return agentName.trim().length > 0;
    if (step === 3) return taskTitle.trim().length > 0;
    return true;
  }, [launching, step, companyName, agentName, taskTitle]);

  /**
   * The ONLY place that hits the network. Runs all 4 creates in
   * sequence — if company creation succeeds but agent fails, we
   * surface a partial-success error and let the operator retry from
   * the wizard (the company will already exist in the switcher).
   */
  async function launchAll(): Promise<void> {
    setLaunching(true);
    setError(null);

    setLaunchProgress('יוצר חברה…');
    const company = await createCompany({
      name: companyName.trim(),
      description: companyDescription.trim() || null,
    });
    if (!company) {
      setLaunching(false);
      setLaunchProgress('');
      setError(
        'יצירת החברה נכשלה. דרוש admin ב-Paperclip לשם כך — צור את החברה ידנית בדשבורד פייפרקליפ ב-:3100 ורענן.',
      );
      return;
    }

    // From this point on, partial failures show a softer warning —
    // the company exists, the user can recover the rest later.
    //
    // Every subsequent create gets the new company's id as an explicit
    // override: the module-level `moduleCompanyId` still points at the
    // previously-active company (or null on first run) until App.tsx
    // re-bootstraps after `onLaunch`. Without the override, agent/issue
    // creates would land on the wrong company — or silently no-op.
    const failures: string[] = [];

    if (firstGoal.trim()) {
      setLaunchProgress('מוסיף מטרה ראשונה…');
      const goal = await createGoal(
        {
          title: firstGoal.trim(),
          level: 'company',
          status: 'active',
        },
        company.id,
      );
      if (!goal) failures.push('מטרה ראשונה');
    }

    setLaunchProgress('יוצר CEO…');
    const agentResult = await createAgentHire(
      {
        name: agentName.trim(),
        role: 'ceo',
        adapterType,
        title: 'CEO',
      },
      company.id,
    );
    if (!agentResult) {
      failures.push('CEO');
    } else {
      setLaunchProgress('יוצר משימה ראשונה…');
      const issue = await createIssue(
        {
          title: taskTitle.trim(),
          description: taskDescription.trim(),
          assigneeAgentId: agentResult.agent.id,
          status: 'todo',
          priority: 'medium',
        },
        company.id,
      );
      if (!issue) {
        failures.push('משימה ראשונה');
      }
    }

    setLaunching(false);
    setLaunchProgress('');

    if (failures.length > 0) {
      setError(
        `החברה "${company.name}" נוצרה, אבל לא הצלחנו להשלים: ${failures.join(', ')}. תוכל להוסיף אותם ידנית מהממשק אחרי המעבר ל-workspace.`,
      );
      // Even on partial failure, switch into the new workspace —
      // the user can recover from there.
    }

    onLaunch(company);
  }

  function advance() {
    if (!canAdvance) return;
    if (step < 4) {
      setStep(((step + 1) as Step));
      return;
    }
    void launchAll();
  }

  return (
    <div
      dir="rtl"
      style={{
        position: 'fixed',
        inset: 0,
        background: '#0b1120',
        zIndex: 9999,
        display: 'flex',
        fontFamily: TEXT_FONT_STACK,
        color: '#e2e8f0',
      }}
    >
      {/* Right pane (RTL "start" = right): wizard form */}
      <div
        style={{
          flex: '1 1 640px',
          maxWidth: 720,
          minWidth: 380,
          padding: '40px 48px',
          display: 'flex',
          flexDirection: 'column',
          gap: 22,
          overflow: 'auto',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div
              style={{
                fontSize: 12,
                color: '#94a3b8',
                fontWeight: 700,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
              }}
            >
              שלב {step} מ-4
            </div>
            <div
              style={{
                fontSize: 28,
                fontWeight: 700,
                color: '#f1f5f9',
                marginBlockStart: 6,
              }}
            >
              {STEP_TITLES[step]}
            </div>
          </div>
          {!isFirstRun ? (
            <button
              type="button"
              onClick={onClose}
              disabled={launching}
              title="סגור"
              aria-label="סגור"
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'rgba(255,255,255,0.06)',
                color: '#fff',
                cursor: launching ? 'not-allowed' : 'pointer',
                fontSize: 18,
                fontFamily: 'inherit',
                opacity: launching ? 0.5 : 1,
              }}
            >
              ✕
            </button>
          ) : null}
        </div>

        {/* Tab strip — click-to-jump backwards only */}
        <div
          style={{
            display: 'flex',
            gap: 4,
            borderBlockEnd: '1px solid rgba(255,255,255,0.1)',
            paddingBlockEnd: 10,
          }}
        >
          {([1, 2, 3, 4] as Step[]).map((s) => {
            const done = s < step;
            const current = s === step;
            return (
              <button
                key={s}
                type="button"
                onClick={() => {
                  if (s < step && !launching) setStep(s);
                }}
                disabled={s > step || launching}
                style={{
                  flex: 1,
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: 'none',
                  background: current
                    ? 'rgba(99,102,241,0.3)'
                    : done
                      ? 'rgba(34,197,94,0.18)'
                      : 'transparent',
                  color: current ? '#e0e7ff' : done ? '#bbf7d0' : '#64748b',
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: s > step || launching ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                  textAlign: 'center',
                }}
              >
                {done ? '✓ ' : ''}
                {s}. {STEP_TITLES[s]}
              </button>
            );
          })}
        </div>

        {/* Step body */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 18,
            flex: 1,
          }}
        >
          {error ? (
            <div
              style={{
                fontSize: 14,
                color: '#fecaca',
                background: 'rgba(127,29,29,0.4)',
                padding: '12px 16px',
                borderRadius: 10,
                lineHeight: 1.6,
                fontFamily: TEXT_FONT_STACK,
              }}
            >
              {error}
            </div>
          ) : null}

          {step === 1 ? (
            <Step1Company
              name={companyName}
              description={companyDescription}
              firstGoal={firstGoal}
              onChangeName={setCompanyName}
              onChangeDescription={setCompanyDescription}
              onChangeFirstGoal={setFirstGoal}
              disabled={launching}
            />
          ) : step === 2 ? (
            <Step2Agent
              agentName={agentName}
              adapterType={adapterType}
              onChangeName={setAgentName}
              onChangeAdapter={setAdapterType}
              disabled={launching}
            />
          ) : step === 3 ? (
            <Step3Task
              title={taskTitle}
              description={taskDescription}
              onChangeTitle={setTaskTitle}
              onChangeDescription={setTaskDescription}
              disabled={launching}
            />
          ) : (
            <Step4Launch
              companyName={companyName}
              companyDescription={companyDescription}
              firstGoal={firstGoal}
              agentName={agentName}
              adapterType={adapterType}
              taskTitle={taskTitle}
              launchProgress={launchProgress}
            />
          )}
        </div>

        {/* Footer nav */}
        <div
          style={{
            display: 'flex',
            gap: 8,
            justifyContent: 'space-between',
            borderBlockStart: '1px solid rgba(255,255,255,0.08)',
            paddingBlockStart: 16,
          }}
        >
          {step > 1 ? (
            <button
              type="button"
              onClick={() => setStep(((step - 1) as Step))}
              disabled={launching}
              style={{
                padding: '10px 18px',
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'transparent',
                color: '#cbd5e1',
                fontSize: 14,
                fontWeight: 600,
                fontFamily: 'inherit',
                cursor: launching ? 'not-allowed' : 'pointer',
                opacity: launching ? 0.5 : 1,
              }}
            >
              ← חזרה
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={advance}
            disabled={!canAdvance}
            style={{
              padding: '12px 26px',
              fontSize: 15,
              fontWeight: 700,
              borderRadius: 9,
              border: '1px solid rgba(34,197,94,0.6)',
              background: 'rgba(34,197,94,0.28)',
              color: '#dcfce7',
              fontFamily: 'inherit',
              opacity: canAdvance ? 1 : 0.5,
              cursor: canAdvance ? 'pointer' : 'not-allowed',
            }}
          >
            {launching
              ? launchProgress || 'מבצע…'
              : step < 4
                ? 'המשך →'
                : '🚀 שגר workspace'}
          </button>
        </div>

        <div
          style={{
            fontSize: 12,
            color: '#475569',
            textAlign: 'center',
            fontFamily: TEXT_FONT_STACK,
          }}
        >
          טיפ: Cmd/Ctrl+Enter להתקדמות לשלב הבא · כלום לא נשמר עד "🚀 שגר"
        </div>
      </div>

      {/* Left pane (RTL "end" = left): illustration / branding */}
      <div
        style={{
          flex: 1,
          background:
            'linear-gradient(135deg, #4f46e5 0%, #7c3aed 50%, #db2777 100%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '40px 60px',
          textAlign: 'center',
          gap: 22,
          color: '#fff',
          fontFamily: TEXT_FONT_STACK,
        }}
      >
        <div style={{ fontSize: 64 }}>🏢</div>
        <div style={{ fontSize: 30, fontWeight: 700 }}>הקמת workspace חדש</div>
        <div
          style={{
            fontSize: 16,
            opacity: 0.92,
            maxWidth: 440,
            lineHeight: 1.65,
            fontWeight: 400,
          }}
        >
          כל workspace הוא חברה עצמאית עם המשרד שלה, הסוכנים שלה, המטרות
          והפרויקטים. הנתונים מופרדים לחלוטין בין workspaces — מעבר בין אחד
          לשני טוען מצב נקי לגמרי.
        </div>
        <div
          style={{
            marginBlockStart: 22,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            fontSize: 14,
            opacity: 0.8,
          }}
        >
          {([1, 2, 3, 4] as Step[]).map((s) => (
            <div
              key={s}
              style={{
                opacity: s <= step ? 1 : 0.5,
                fontWeight: s === step ? 700 : 500,
              }}
            >
              {s <= step ? '●' : '○'} שלב {s} — {STEP_TITLES[s]}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Step bodies ──────────────────────────────────────────────────

function Step1Company({
  name,
  description,
  firstGoal,
  onChangeName,
  onChangeDescription,
  onChangeFirstGoal,
  disabled,
}: {
  name: string;
  description: string;
  firstGoal: string;
  onChangeName: (v: string) => void;
  onChangeDescription: (v: string) => void;
  onChangeFirstGoal: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <p style={hintStyle}>
        תן שם לחברה החדשה. השם יופיע בכל מקום ב-workspace הזה. החברה לא
        נוצרת עכשיו — רק אחרי שתשלים את כל השלבים ותלחץ "🚀 שגר".
      </p>
      <div>
        <label style={labelStyle}>שם החברה</label>
        <input
          type="text"
          value={name}
          onChange={(e) => onChangeName(e.target.value)}
          placeholder="לדוגמה: Acme Corp"
          disabled={disabled}
          autoFocus
          style={inputStyle}
        />
      </div>
      <div>
        <label style={labelStyle}>תיאור (אופציונלי)</label>
        <textarea
          value={description}
          onChange={(e) => onChangeDescription(e.target.value)}
          placeholder="במה החברה עוסקת?"
          disabled={disabled}
          rows={3}
          style={{ ...inputStyle, resize: 'vertical', minHeight: 84 }}
        />
      </div>
      <div>
        <label style={labelStyle}>מטרה ראשונה (אופציונלי)</label>
        <input
          type="text"
          value={firstGoal}
          onChange={(e) => onChangeFirstGoal(e.target.value)}
          placeholder="לדוגמה: השקת המוצר ב-Q1"
          disabled={disabled}
          style={inputStyle}
        />
        <div
          style={{
            fontSize: 12,
            color: '#64748b',
            marginBlockStart: 6,
            fontFamily: TEXT_FONT_STACK,
          }}
        >
          תוכל להוסיף מטרות נוספות מהכפתור 🎯 בסרגל הסימניות.
        </div>
      </div>
    </>
  );
}

function Step2Agent({
  agentName,
  adapterType,
  onChangeName,
  onChangeAdapter,
  disabled,
}: {
  agentName: string;
  adapterType: AgentAdapterType;
  onChangeName: (v: string) => void;
  onChangeAdapter: (v: AgentAdapterType) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <p style={hintStyle}>
        כל workspace זקוק לפחות לסוכן CEO אחד. הוא ינהל את שאר הסוכנים
        ויהיה איש הקשר הראשי שלך.
      </p>
      <div>
        <label style={labelStyle}>שם הסוכן</label>
        <input
          type="text"
          value={agentName}
          onChange={(e) => onChangeName(e.target.value)}
          placeholder="CEO"
          disabled={disabled}
          autoFocus
          style={inputStyle}
        />
      </div>
      <div>
        <div style={labelStyle}>בחר adapter</div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: 10,
            maxHeight: 340,
            overflow: 'auto',
          }}
        >
          {AGENT_ADAPTER_TYPES.map((t) => {
            const selected = adapterType === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => onChangeAdapter(t)}
                disabled={disabled}
                style={{
                  padding: '12px 14px',
                  background: selected
                    ? 'rgba(99,102,241,0.22)'
                    : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${selected ? 'rgba(99,102,241,0.55)' : 'rgba(255,255,255,0.12)'}`,
                  borderRadius: 9,
                  color: '#e2e8f0',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                  textAlign: 'inherit',
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 700 }}>
                  {ADAPTER_LABELS[t] ?? t}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: '#94a3b8',
                    marginBlockStart: 3,
                    fontFamily: TEXT_FONT_STACK,
                  }}
                >
                  {ADAPTER_DESCRIPTIONS[t] ?? ''}
                </div>
              </button>
            );
          })}
        </div>
      </div>
      <div
        style={{
          fontSize: 12,
          color: '#64748b',
          fontFamily: TEXT_FONT_STACK,
        }}
      >
        תוכל להוסיף סוכנים נוספים מ-🏢 מבנה ארגוני, או מ-+ סוכן חדש שם.
      </div>
    </>
  );
}

function Step3Task({
  title,
  description,
  onChangeTitle,
  onChangeDescription,
  disabled,
}: {
  title: string;
  description: string;
  onChangeTitle: (v: string) => void;
  onChangeDescription: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <p style={hintStyle}>
        משימה ראשונה ל-CEO. זה ייצור issue שאליו יוצמד chat — ככה אפשר לבדוק
        שכל המנגנון עובד מקצה לקצה.
      </p>
      <div>
        <label style={labelStyle}>כותרת המשימה</label>
        <input
          type="text"
          value={title}
          onChange={(e) => onChangeTitle(e.target.value)}
          placeholder="Welcome to your workspace"
          disabled={disabled}
          autoFocus
          style={inputStyle}
        />
      </div>
      <div>
        <label style={labelStyle}>תיאור</label>
        <textarea
          value={description}
          onChange={(e) => onChangeDescription(e.target.value)}
          placeholder="מה אתה רוצה שה-CEO יעשה לראשונה?"
          disabled={disabled}
          rows={5}
          style={{ ...inputStyle, resize: 'vertical', minHeight: 120 }}
        />
      </div>
    </>
  );
}

function Step4Launch({
  companyName,
  companyDescription,
  firstGoal,
  agentName,
  adapterType,
  taskTitle,
  launchProgress,
}: {
  companyName: string;
  companyDescription: string;
  firstGoal: string;
  agentName: string;
  adapterType: AgentAdapterType;
  taskTitle: string;
  launchProgress: string;
}) {
  return (
    <>
      <p style={hintStyle}>
        הכל מוכן — סקירה אחרונה לפני שיגור. לחיצה על "🚀 שגר" יוצרת את כל
        הישויות לפי הסדר (חברה → מטרה → CEO → משימה ראשונה) ומעבירה אותך
        ל-workspace החדש.
      </p>
      <SummaryRow icon="🏢" label="חברה" value={companyName} />
      {companyDescription.trim() ? (
        <SummaryRow icon="📝" label="תיאור" value={companyDescription} />
      ) : null}
      {firstGoal.trim() ? (
        <SummaryRow icon="🎯" label="מטרה ראשונה" value={firstGoal} />
      ) : null}
      <SummaryRow
        icon="🧑‍💼"
        label="CEO"
        value={`${agentName} · ${ADAPTER_LABELS[adapterType] ?? adapterType}`}
      />
      <SummaryRow icon="📋" label="משימה ראשונה" value={taskTitle} />
      {launchProgress ? (
        <div
          style={{
            ...hintStyle,
            color: '#86efac',
            background: 'rgba(34,197,94,0.10)',
            border: '1px solid rgba(34,197,94,0.32)',
            padding: '10px 14px',
            borderRadius: 8,
          }}
        >
          ⏳ {launchProgress}
        </div>
      ) : null}
    </>
  );
}

function SummaryRow({
  icon,
  label,
  value,
}: {
  icon: string;
  label: string;
  value: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 14,
        padding: '12px 14px',
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 9,
        alignItems: 'flex-start',
      }}
    >
      <span style={{ fontSize: 22, flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: '#94a3b8',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: 15,
            color: '#f1f5f9',
            marginBlockStart: 4,
            fontFamily: TEXT_FONT_STACK,
            lineHeight: 1.5,
            wordBreak: 'break-word',
          }}
        >
          {value || '—'}
        </div>
      </div>
    </div>
  );
}
