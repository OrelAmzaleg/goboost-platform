import { useEffect, useState } from 'react';

import {
  AGENT_ADAPTER_TYPES,
  AGENT_ROLES,
  createAgentHire,
  fetchCompanyAgents,
  type AgentAdapterType,
  type AgentRole,
  type PaperclipAgentSummary,
} from '../paperclipApi.js';
import { ModalShell, primaryBtn, secondaryBtn } from './ProjectCreateModal.js';
import { TextArea, TextField } from './projectForm.js';

/**
 * NewAgentDialog — four-step "+ new agent" flow matching Paperclip's
 * own dashboard sequence.
 *
 *   choice         → "Ask CEO" / "Build yourself"
 *   ask-ceo-draft  → editable issue draft (title + description) before
 *                    posting it to the CEO. Mirrors Paperclip's
 *                    NewIssueDialog that opens after the Ask CEO click.
 *   adapter-pick   → grid of adapter cards (Claude Code, Codex, Cursor,
 *                    Gemini CLI, Grok Build, etc.) with descriptions
 *                    and "Recommended" badges. Mirrors Paperclip's
 *                    adapter picker that gates the advanced form.
 *   self-config    → structured form with name, title, role, reportsTo,
 *                    + adapter-specific config (command, model,
 *                    thinking effort, instructions file, extra args,
 *                    heartbeat policy).
 *
 * Reachable transitions:
 *   choice → ask-ceo-draft → (post issue, close)
 *   choice → adapter-pick → self-config → (POST /agent-hires, close)
 *
 * The wider runtime knobs (envVars, skills picker, Test Agent button,
 * dangerously-* flags) are NOT in this MVP — operators tune them via
 * AgentManagementModal after the agent exists. Tech-debt-able if the
 * user needs them up-front later.
 */

// ── Display metadata ─────────────────────────────────────────────

const ROLE_LABELS: Record<AgentRole, string> = {
  ceo: 'CEO',
  cto: 'CTO',
  cmo: 'CMO',
  cfo: 'CFO',
  coo: 'COO',
  engineer: 'מהנדס',
  designer: 'מעצב',
  pm: 'מנהל מוצר',
  qa: 'QA',
  finance: 'כספים',
  operations: 'תפעול',
  general: 'כללי',
};

interface AdapterMeta {
  type: AgentAdapterType;
  label: string;
  description: string;
  icon: string;
  recommended?: boolean;
  /**
   * Cloud/managed adapters skip the local `command`/`extraArgs` fields
   * in the config step (they're invoked via URL/protocol instead).
   */
  isCloud?: boolean;
  /**
   * Typical local-CLI binary for this adapter. Used to seed the
   * `command` field when the operator first picks the adapter, so they
   * don't have to type the obvious. Undefined for cloud adapters.
   */
  defaultCommand?: string;
}

const ADAPTERS: AdapterMeta[] = [
  {
    type: 'claude_local',
    label: 'Claude Code',
    description: 'Local Claude agent',
    icon: '✨',
    recommended: true,
    defaultCommand: 'claude',
  },
  {
    type: 'codex_local',
    label: 'Codex',
    description: 'Local Codex agent',
    icon: '< >',
    recommended: true,
    defaultCommand: 'codex',
  },
  {
    type: 'cursor',
    label: 'Cursor',
    description: 'Local Cursor agent',
    icon: '➤',
    defaultCommand: 'cursor',
  },
  {
    type: 'cursor_cloud',
    label: 'Cursor Cloud',
    description: 'Managed remote Cursor agent',
    icon: '☁',
    isCloud: true,
  },
  {
    type: 'gemini_local',
    label: 'Gemini CLI',
    description: 'Local Gemini agent',
    icon: '◆',
    defaultCommand: 'gemini',
  },
  {
    type: 'grok_local',
    label: 'Grok Build',
    description: 'Local Grok Build agent',
    icon: '⚒',
    defaultCommand: 'grok',
  },
  {
    type: 'hermes_local',
    label: 'Hermes Agent',
    description: 'Local Hermes CLI agent',
    icon: '🗝',
    defaultCommand: 'hermes',
  },
  {
    type: 'openclaw_gateway',
    label: 'OpenClaw Gateway',
    description: 'Invoke OpenClaw via gateway protocol',
    icon: '⊟',
    isCloud: true,
  },
  {
    type: 'opencode_local',
    label: 'OpenCode',
    description: 'Local multi-provider agent',
    icon: '▢',
    defaultCommand: 'opencode',
  },
  {
    type: 'pi_local',
    label: 'Pi',
    description: 'Local Pi agent',
    icon: '>_',
    defaultCommand: 'pi',
  },
];

const THINKING_EFFORTS = ['auto', 'low', 'medium', 'high'] as const;
type ThinkingEffort = (typeof THINKING_EFFORTS)[number];

const THINKING_LABELS: Record<ThinkingEffort, string> = {
  auto: 'Auto',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

// ── Styles ─────────────────────────────────────────────────────

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

// ── Component ──────────────────────────────────────────────────

export interface NewAgentDialogProps {
  onClose: () => void;
  /** Called after a successful self-create with the new agent's UUID. */
  onCreated?: (agentId: string) => void;
  /**
   * Invoked when the operator picks the "Ask CEO" path. The parent
   * (OrgChartModal / App) opens the existing AssignTaskModal with a
   * pre-populated issue draft — we don't draw our own composer here.
   * This dialog closes itself right after the callback fires.
   */
  onAskCeo?: (ceoUuid: string, ceoName: string | null) => void;
}

type Step = 'choice' | 'adapter-pick' | 'self-config';

export function NewAgentDialog({
  onClose,
  onCreated,
  onAskCeo,
}: NewAgentDialogProps) {
  const [step, setStep] = useState<Step>('choice');
  const [agents, setAgents] = useState<PaperclipAgentSummary[]>([]);

  // ── adapter-pick → self-config state ──────────────────────────
  const [adapterType, setAdapterType] = useState<AgentAdapterType>('claude-code');

  // ── self-config state ─────────────────────────────────────────
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [role, setRole] = useState<AgentRole>('general');
  const [reportsTo, setReportsTo] = useState<string>('');
  const [command, setCommand] = useState('');
  const [model, setModel] = useState('');
  const [thinkingEffort, setThinkingEffort] = useState<ThinkingEffort>('auto');
  const [instructionsFilePath, setInstructionsFilePath] = useState('');
  const [extraArgs, setExtraArgs] = useState('');
  const [heartbeatEnabled, setHeartbeatEnabled] = useState(false);
  const [intervalSec, setIntervalSec] = useState<string>('60');
  const [capabilities, setCapabilities] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Need the company agents list for the reportsTo picker AND for
  // finding the CEO on the "ask CEO" path.
  useEffect(() => {
    let cancelled = false;
    void fetchCompanyAgents().then((a) => {
      if (!cancelled) setAgents(a);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // CEO heuristic: prefer the agent flagged as role='ceo'; fallback to
  // the first agent with no manager (reportsTo === null).
  const ceoCandidate =
    agents.find((a) => (a as PaperclipAgentSummary & { role?: string }).role === 'ceo') ??
    agents.find((a) => !a.reportsTo) ??
    null;

  const adapterMeta =
    ADAPTERS.find((a) => a.type === adapterType) ?? ADAPTERS[0];

  // ── Submit handlers ────────────────────────────────────────────

  const triggerAskCeo = () => {
    if (!ceoCandidate) {
      setError(
        'לא נמצא CEO לבקש ממנו. צור סוכן ראשון בעצמך, או דרך הדשבורד של Paperclip.',
      );
      return;
    }
    if (!onAskCeo) {
      setError('זרימת "בקש מה-CEO" אינה מחוברת בגירסה הזו.');
      return;
    }
    // Hand off to the parent — it'll open the full AssignTaskModal
    // composer (priority, goal, project, attachments) pre-populated
    // with the agent-creation request. This dialog closes after the
    // call so the operator isn't stacked three modals deep.
    onAskCeo(ceoCandidate.id, ceoCandidate.name);
    onClose();
  };

  const canSubmitSelf = name.trim().length > 0 && !submitting;

  const submitSelf = async () => {
    if (!canSubmitSelf) return;
    setSubmitting(true);
    setError(null);

    // Build adapterConfig from per-adapter fields. Empty strings are
    // dropped so backend defaults take over.
    const adapterConfig: Record<string, unknown> = {};
    if (command.trim()) adapterConfig.command = command.trim();
    if (model.trim()) adapterConfig.model = model.trim();
    if (thinkingEffort !== 'auto') adapterConfig.thinkingEffort = thinkingEffort;
    if (instructionsFilePath.trim())
      adapterConfig.instructionsFilePath = instructionsFilePath.trim();
    if (extraArgs.trim()) {
      adapterConfig.extraArgs = extraArgs
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    const runtimeConfig: Record<string, unknown> = {};
    if (heartbeatEnabled) {
      runtimeConfig.heartbeatEnabled = true;
      const n = Number(intervalSec);
      if (Number.isFinite(n) && n > 0) runtimeConfig.intervalSec = Math.round(n);
    }

    const result = await createAgentHire({
      name: name.trim(),
      title: title.trim() || null,
      role,
      adapterType,
      reportsTo: reportsTo || null,
      capabilities: capabilities.trim() || null,
      adapterConfig,
      ...(Object.keys(runtimeConfig).length > 0 ? { runtimeConfig } : {}),
    });
    setSubmitting(false);
    if (!result) {
      setError('יצירת הסוכן נכשלה.');
      return;
    }
    onCreated?.(result.agent.id);
    onClose();
  };

  // ── Render ─────────────────────────────────────────────────────

  const titleByStep: Record<Step, string> = {
    choice: 'הוספת סוכן חדש',
    'adapter-pick': 'בחר סוג סוכן',
    'self-config': 'הגדרת סוכן',
  };

  return (
    <ModalShell title={titleByStep[step]} onClose={onClose} wide>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
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

        {step === 'choice' ? (
          <ChoiceStep
            onAskCeo={() => {
              setError(null);
              triggerAskCeo();
            }}
            onSelfBuild={() => {
              setError(null);
              setStep('adapter-pick');
            }}
            ceoName={ceoCandidate?.name ?? null}
            onCancel={onClose}
          />
        ) : step === 'adapter-pick' ? (
          <AdapterPickStep
            selected={adapterType}
            onPick={(t) => {
              setAdapterType(t);
              // Seed the `command` field with the adapter's typical CLI
              // binary (claude / codex / grok / ...) so the operator
              // doesn't have to retype it. Skipped for cloud adapters
              // (no local command) and when the user already typed one.
              if (!command) {
                const meta = ADAPTERS.find((a) => a.type === t);
                if (meta?.defaultCommand) setCommand(meta.defaultCommand);
              }
              setStep('self-config');
            }}
            onBack={() => setStep('choice')}
          />
        ) : (
          <SelfConfigStep
            agents={agents}
            adapter={adapterMeta}
            name={name}
            title={title}
            role={role}
            reportsTo={reportsTo}
            command={command}
            model={model}
            thinkingEffort={thinkingEffort}
            instructionsFilePath={instructionsFilePath}
            extraArgs={extraArgs}
            heartbeatEnabled={heartbeatEnabled}
            intervalSec={intervalSec}
            capabilities={capabilities}
            submitting={submitting}
            canSubmit={canSubmitSelf}
            onChangeName={setName}
            onChangeTitle={setTitle}
            onChangeRole={setRole}
            onChangeReportsTo={setReportsTo}
            onChangeCommand={setCommand}
            onChangeModel={setModel}
            onChangeThinking={setThinkingEffort}
            onChangeInstructions={setInstructionsFilePath}
            onChangeExtraArgs={setExtraArgs}
            onChangeHeartbeat={setHeartbeatEnabled}
            onChangeIntervalSec={setIntervalSec}
            onChangeCapabilities={setCapabilities}
            onBack={() => setStep('adapter-pick')}
            onSubmit={() => void submitSelf()}
          />
        )}
      </div>
    </ModalShell>
  );
}

// ── Step: choice ────────────────────────────────────────────────

function ChoiceStep({
  onAskCeo,
  onSelfBuild,
  ceoName,
  onCancel,
}: {
  onAskCeo: () => void;
  onSelfBuild: () => void;
  ceoName: string | null;
  onCancel: () => void;
}) {
  return (
    <>
      <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.5 }}>
        איך תרצה להוסיף את הסוכן החדש?
      </div>
      <button type="button" onClick={onAskCeo} style={choiceCardStyle}>
        <div style={{ fontSize: 22 }}>🧑‍💼</div>
        <div style={{ flex: 1, textAlign: 'start' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#f1f5f9' }}>
            בקש מה-CEO לטפל בזה
          </div>
          <div style={{ fontSize: 11, color: '#94a3b8', marginBlockStart: 4 }}>
            פותח טיוטת משימה ל-{ceoName ?? 'ה-CEO'} שתוכל לערוך לפני שליחה.
          </div>
        </div>
      </button>
      <button type="button" onClick={onSelfBuild} style={choiceCardStyle}>
        <div style={{ fontSize: 22 }}>🛠</div>
        <div style={{ flex: 1, textAlign: 'start' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#f1f5f9' }}>
            בנה לבד
          </div>
          <div style={{ fontSize: 11, color: '#94a3b8', marginBlockStart: 4 }}>
            תחילה תבחר את סוג הסוכן (Claude Code / Codex / Cursor / ...), ואחר
            כך תמלא את ההגדרות.
          </div>
        </div>
      </button>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" onClick={onCancel} style={secondaryBtn}>
          ביטול
        </button>
      </div>
    </>
  );
}

const choiceCardStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  padding: '14px 16px',
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 10,
  color: '#e2e8f0',
  cursor: 'pointer',
  fontFamily: 'inherit',
  textAlign: 'inherit',
};

// (AskCeoDraftStep removed — the "Ask CEO" path now hands off to the
// existing AssignTaskModal via the `onAskCeo` callback, reusing its
// full composer (priority / goal / project / attachments) instead of
// duplicating the form here.)

// ── Step: adapter-pick ──────────────────────────────────────────

function AdapterPickStep({
  selected,
  onPick,
  onBack,
}: {
  selected: AgentAdapterType;
  onPick: (t: AgentAdapterType) => void;
  onBack: () => void;
}) {
  return (
    <>
      <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.5 }}>
        בחר את סוג הסוכן. ההגדרות הבאות יתאימו ל-adapter שבחרת.
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 8,
        }}
      >
        {AGENT_ADAPTER_TYPES.map((type) => {
          const meta = ADAPTERS.find((a) => a.type === type);
          if (!meta) return null;
          return (
            <AdapterCard
              key={type}
              meta={meta}
              selected={selected === type}
              onPick={() => onPick(type)}
            />
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
        <button type="button" onClick={onBack} style={secondaryBtn}>
          חזרה
        </button>
      </div>
    </>
  );
}

function AdapterCard({
  meta,
  selected,
  onPick,
}: {
  meta: AdapterMeta;
  selected: boolean;
  onPick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onPick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 6,
        padding: '14px 14px 12px',
        background: selected
          ? 'rgba(99,102,241,0.18)'
          : hover
            ? 'rgba(255,255,255,0.08)'
            : 'rgba(255,255,255,0.04)',
        border: `1px solid ${selected ? 'rgba(99,102,241,0.55)' : 'rgba(255,255,255,0.12)'}`,
        borderRadius: 10,
        color: '#e2e8f0',
        cursor: 'pointer',
        fontFamily: 'inherit',
        textAlign: 'start',
        minHeight: 88,
      }}
    >
      {meta.recommended ? (
        <span
          style={{
            position: 'absolute',
            top: -8,
            insetInlineStart: 10,
            fontSize: 10,
            fontWeight: 700,
            padding: '2px 8px',
            borderRadius: 999,
            background: '#22c55e',
            color: '#052e16',
          }}
        >
          מומלץ
        </span>
      ) : null}
      <div style={{ fontSize: 18, lineHeight: 1, opacity: 0.9 }}>{meta.icon}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#f1f5f9' }}>
        {meta.label}
      </div>
      <div style={{ fontSize: 11, color: '#94a3b8' }}>{meta.description}</div>
    </button>
  );
}

// ── Step: self-config ───────────────────────────────────────────

function SelfConfigStep({
  agents,
  adapter,
  name,
  title,
  role,
  reportsTo,
  command,
  model,
  thinkingEffort,
  instructionsFilePath,
  extraArgs,
  heartbeatEnabled,
  intervalSec,
  capabilities,
  submitting,
  canSubmit,
  onChangeName,
  onChangeTitle,
  onChangeRole,
  onChangeReportsTo,
  onChangeCommand,
  onChangeModel,
  onChangeThinking,
  onChangeInstructions,
  onChangeExtraArgs,
  onChangeHeartbeat,
  onChangeIntervalSec,
  onChangeCapabilities,
  onBack,
  onSubmit,
}: {
  agents: PaperclipAgentSummary[];
  adapter: AdapterMeta;
  name: string;
  title: string;
  role: AgentRole;
  reportsTo: string;
  command: string;
  model: string;
  thinkingEffort: ThinkingEffort;
  instructionsFilePath: string;
  extraArgs: string;
  heartbeatEnabled: boolean;
  intervalSec: string;
  capabilities: string;
  submitting: boolean;
  canSubmit: boolean;
  onChangeName: (v: string) => void;
  onChangeTitle: (v: string) => void;
  onChangeRole: (v: AgentRole) => void;
  onChangeReportsTo: (v: string) => void;
  onChangeCommand: (v: string) => void;
  onChangeModel: (v: string) => void;
  onChangeThinking: (v: ThinkingEffort) => void;
  onChangeInstructions: (v: string) => void;
  onChangeExtraArgs: (v: string) => void;
  onChangeHeartbeat: (v: boolean) => void;
  onChangeIntervalSec: (v: string) => void;
  onChangeCapabilities: (v: string) => void;
  onBack: () => void;
  onSubmit: () => void;
}) {
  return (
    <>
      {/* Adapter pill at top — reminds the operator which adapter they're
          configuring; click "Back" to change it. */}
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          background: 'rgba(99,102,241,0.18)',
          border: '1px solid rgba(99,102,241,0.45)',
          borderRadius: 999,
          color: '#e0e7ff',
          fontSize: 12,
          alignSelf: 'flex-start',
        }}
      >
        <span>{adapter.icon}</span>
        <span style={{ fontWeight: 700 }}>{adapter.label}</span>
        <span style={{ opacity: 0.75 }}>· {adapter.description}</span>
      </div>

      {/* Identity */}
      <SectionTitle>זהות</SectionTitle>
      <TextField
        label="שם הסוכן"
        value={name}
        onChange={onChangeName}
        placeholder="שם שיופיע בארגון ובצ׳אט"
        disabled={submitting}
        autoFocus
      />
      <TextField
        label="תפקיד (Title)"
        value={title}
        onChange={onChangeTitle}
        placeholder="לדוגמה: סמנכ״ל מוצר"
        disabled={submitting}
      />
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 140 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={labelStyle}>Role</span>
            <select
              value={role}
              onChange={(e) => onChangeRole(e.target.value as AgentRole)}
              disabled={submitting}
              style={fieldStyle}
            >
              {AGENT_ROLES.map((r) => (
                <option
                  key={r}
                  value={r}
                  style={{ background: '#1e293b', color: '#f1f5f9' }}
                >
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div style={{ flex: 1, minWidth: 140 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={labelStyle}>כפוף ל-</span>
            <select
              value={reportsTo}
              onChange={(e) => onChangeReportsTo(e.target.value)}
              disabled={submitting}
              style={fieldStyle}
            >
              <option value="" style={{ background: '#1e293b', color: '#f1f5f9' }}>
                ללא מנהל (root)
              </option>
              {agents.map((a) => (
                <option
                  key={a.id}
                  value={a.id}
                  style={{ background: '#1e293b', color: '#f1f5f9' }}
                >
                  {a.name}
                  {a.title ? ` — ${a.title}` : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* Permissions & Configuration — adapter-specific fields. Cloud
          adapters skip the local `command` + `extraArgs` controls. */}
      <SectionTitle>הגדרות והרשאות</SectionTitle>
      {!adapter.isCloud ? (
        <TextField
          label="Command"
          value={command}
          onChange={onChangeCommand}
          placeholder={adapter.defaultCommand ?? 'CLI command'}
          disabled={submitting}
        />
      ) : null}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 140 }}>
          <TextField
            label="Model"
            value={model}
            onChange={onChangeModel}
            placeholder="Default"
            disabled={submitting}
          />
        </div>
        <div style={{ flex: 1, minWidth: 140 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={labelStyle}>Thinking effort</span>
            <select
              value={thinkingEffort}
              onChange={(e) =>
                onChangeThinking(e.target.value as ThinkingEffort)
              }
              disabled={submitting}
              style={fieldStyle}
            >
              {THINKING_EFFORTS.map((t) => (
                <option
                  key={t}
                  value={t}
                  style={{ background: '#1e293b', color: '#f1f5f9' }}
                >
                  {THINKING_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <TextField
        label="Agent instructions file"
        value={instructionsFilePath}
        onChange={onChangeInstructions}
        placeholder="/absolute/path/to/AGENTS.md"
        disabled={submitting}
      />
      {!adapter.isCloud ? (
        <TextField
          label="Extra args (comma-separated)"
          value={extraArgs}
          onChange={onChangeExtraArgs}
          placeholder="--verbose, --foo=bar"
          disabled={submitting}
        />
      ) : null}

      {/* Run policy */}
      <SectionTitle>Run policy</SectionTitle>
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 13,
          color: '#cbd5e1',
        }}
      >
        <input
          type="checkbox"
          checked={heartbeatEnabled}
          onChange={(e) => onChangeHeartbeat(e.target.checked)}
          disabled={submitting}
          style={{
            width: 16,
            height: 16,
            accentColor: '#6366f1',
            cursor: 'pointer',
          }}
        />
        <span>Heartbeat on interval — הפעלה אוטומטית מחזורית</span>
      </label>
      {heartbeatEnabled ? (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>Interval (שניות)</span>
          <input
            type="number"
            min={5}
            value={intervalSec}
            onChange={(e) => onChangeIntervalSec(e.target.value)}
            disabled={submitting}
            style={{ ...fieldStyle, maxWidth: 160 }}
          />
        </label>
      ) : null}

      <SectionTitle>הקשר</SectionTitle>
      <TextArea
        label="Capabilities (כישורים)"
        value={capabilities}
        onChange={onChangeCapabilities}
        placeholder="מה הסוכן יודע לעשות (אופציונלי)"
        disabled={submitting}
      />

      <div
        style={{
          display: 'flex',
          gap: 8,
          justifyContent: 'space-between',
          marginBlockStart: 4,
        }}
      >
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          style={secondaryBtn}
        >
          חזרה לבחירת סוג
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit}
          style={{
            ...primaryBtn,
            opacity: canSubmit ? 1 : 0.5,
            cursor: canSubmit ? 'pointer' : 'not-allowed',
          }}
        >
          {submitting ? 'יוצר…' : 'צור סוכן'}
        </button>
      </div>
    </>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.5,
        color: '#94a3b8',
        marginBlockStart: 6,
        textTransform: 'uppercase',
        borderBlockEnd: '1px solid rgba(255,255,255,0.08)',
        paddingBlockEnd: 4,
      }}
    >
      {children}
    </div>
  );
}
