import { useCallback, useEffect, useState } from 'react';

import {
  AGENT_ADAPTER_TYPES,
  AGENT_ROLES,
  cancelRun,
  deleteInstructionsFile,
  fetchAgentById,
  fetchAgentConfigRevisions,
  fetchAgentConfiguration,
  fetchAgentInstructions,
  fetchAgentRuns,
  fetchAgentSkills,
  fetchBudgetOverview,
  fetchCompanyAgents,
  fetchCompanySkills,
  fetchInstructionsFile,
  fetchParticipantIssues,
  fetchRunEvents,
  fetchRunIssuesTouched,
  fetchRunLog,
  fetchRunWorkspaceOperations,
  rollbackAgentConfigRevision,
  saveInstructionsFile,
  subscribeActivity,
  syncAgentSkills,
  terminateAgent,
  updateAgent,
  updateAgentPermissions,
  upsertBudgetPolicy,
  type AgentRole,
  type PaperclipAgentConfiguration,
  type PaperclipAgentDetail,
  type PaperclipAgentSkillEntry,
  type PaperclipAgentSkillSnapshot,
  type PaperclipAgentSummary,
  type PaperclipBudgetOverviewEntry,
  type PaperclipCompanySkill,
  type PaperclipConfigRevision,
  type PaperclipHeartbeatRunSummary,
  type PaperclipInstructionsBundle,
  type PaperclipIssue,
  type PaperclipRunEvent,
  type PaperclipRunIssue,
  type PaperclipRunLogChunk,
  type PaperclipWorkspaceOperation,
} from '../paperclipApi.js';
import { ModalShell, primaryBtn, secondaryBtn } from './ProjectCreateModal.js';
import { TextArea, TextField } from './projectForm.js';

/**
 * AgentManagementModal — superset mirror of Paperclip's agent dashboard.
 *
 * Six tabs, in the order Paperclip presents them:
 *   1. Dashboard    — read-only overview (3.D)
 *   2. Configuration — adapter/model/budget/permissions (3.B)
 *   3. Instructions  — markdown system prompt (3.B)
 *   4. Skills        — installed skills (3.C)
 *   5. Runs          — heartbeat run history + drill-down (3.C)
 *   6. Budget        — spend gauge + cap edit (3.D)
 *
 * Phase 3.B implements Configuration + Instructions. The other tabs
 * render lightweight "coming next" placeholders so the shell + tab
 * navigation are testable end-to-end, and so Phases 3.C/3.D have a
 * clear slot to drop into.
 *
 * The modal subscribes to `agent.*` activity for the focused agent so
 * a status change (pause/resume/wakeup) elsewhere is reflected here.
 */

export type AgentMgmtTab =
  | 'dashboard'
  | 'configuration'
  | 'instructions'
  | 'skills'
  | 'runs'
  | 'budget';

const TAB_LABELS: Record<AgentMgmtTab, string> = {
  dashboard: 'סקירה',
  configuration: 'הגדרות',
  instructions: 'הוראות',
  skills: 'מיומנויות',
  runs: 'ריצות',
  budget: 'תקציב',
};

const TAB_ORDER: AgentMgmtTab[] = [
  'dashboard',
  'configuration',
  'instructions',
  'skills',
  'runs',
  'budget',
];

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

export interface AgentManagementModalProps {
  agentUuid: string;
  onClose: () => void;
  /**
   * The starting tab. Defaults to `dashboard`. Lets callers (org chart,
   * toolbar) open the modal on a particular pane.
   */
  initialTab?: AgentMgmtTab;
}

export function AgentManagementModal({
  agentUuid,
  onClose,
  initialTab = 'dashboard',
}: AgentManagementModalProps) {
  const [tab, setTab] = useState<AgentMgmtTab>(initialTab);
  const [agent, setAgent] = useState<PaperclipAgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Reload on mount + on every agent.* activity for THIS agent.
  const reload = useCallback(async () => {
    setLoading(true);
    const a = await fetchAgentById(agentUuid);
    setAgent(a);
    setError(a ? null : 'לא ניתן לטעון את הסוכן.');
    setLoading(false);
  }, [agentUuid]);

  useEffect(() => {
    let cancelled = false;
    void reload();
    const unsub = subscribeActivity((payload) => {
      const et = String(payload.entityType ?? '');
      const eid = String(payload.entityId ?? '');
      if (et !== 'agent' || eid !== agentUuid) return;
      if (!cancelled) void reload();
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [agentUuid, reload]);

  const headerTitle = agent
    ? `${agent.name} · ניהול`
    : 'ניהול סוכן';

  return (
    <ModalShell title={headerTitle} onClose={onClose} wide>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Tab strip — same visual pattern as ProjectEditModal */}
        <div
          style={{
            display: 'flex',
            gap: 4,
            borderBlockEnd: '1px solid rgba(255,255,255,0.1)',
            paddingBlockEnd: 8,
            flexWrap: 'wrap',
          }}
        >
          {TAB_ORDER.map((id) => (
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
              {TAB_LABELS[id]}
            </button>
          ))}
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

        {loading ? (
          <div style={{ fontSize: 13, color: '#94a3b8', padding: '20px 0' }}>
            טוען נתוני סוכן…
          </div>
        ) : !agent ? null : tab === 'dashboard' ? (
          <DashboardTab agent={agent} />
        ) : tab === 'configuration' ? (
          <ConfigurationTab agent={agent} onSaved={reload} />
        ) : tab === 'instructions' ? (
          <InstructionsTab agentUuid={agentUuid} />
        ) : tab === 'skills' ? (
          <SkillsTab agentUuid={agentUuid} />
        ) : tab === 'runs' ? (
          <RunsTab agentUuid={agentUuid} />
        ) : tab === 'budget' ? (
          <BudgetTab agent={agent} />
        ) : (
          <ComingSoon tab={tab} />
        )}

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            marginBlockStart: 4,
          }}
        >
          <button type="button" onClick={onClose} style={primaryBtn}>
            סגור
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ── Configuration tab ────────────────────────────────────────────

// ── Configuration tab (Session 5 — full buildout) ───────────────
//
// Reads the live config via `fetchAgentConfiguration` (not just the
// summary `agent` prop) so we get adapterConfig + runtimeConfig +
// permissions. Save fires TWO endpoints in parallel:
//   • `updateAgent(id, patch)` for the main fields + adapter/runtime
//     config (merge semantics by default)
//   • `updateAgentPermissions(id, {...})` for the permission flags,
//     since the main PATCH explicitly rejects `permissions`.
// One Save button → both calls together; partial failure surfaces an
// error per-call.

const ROLE_LABELS_FOR_CONFIG: Record<AgentRole, string> = {
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

const ADAPTER_LABELS_FOR_CONFIG: Record<string, string> = {
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

// Cloud adapters skip the local command/extra-args inputs (mirrors the
// `isCloud` flag in NewAgentDialog).
const CLOUD_ADAPTERS: ReadonlySet<string> = new Set([
  'cursor_cloud',
  'openclaw_gateway',
]);

// Adapter-specific permission/feature flags Paperclip exposes per
// adapter (per Q5 investigation). Edited via plain checkboxes when
// the current adapter supports them.
function adapterSupportsChrome(t: string): boolean {
  return t === 'claude_local';
}
function adapterSupportsSkipPerm(t: string): boolean {
  return t === 'claude_local';
}
function adapterSupportsSearch(t: string): boolean {
  return t === 'codex_local';
}
function adapterSupportsFastMode(t: string): boolean {
  return t === 'codex_local';
}

function getStr(c: Record<string, unknown>, k: string): string {
  const v = c[k];
  return typeof v === 'string' ? v : '';
}
function getBool(c: Record<string, unknown>, k: string): boolean {
  const v = c[k];
  return v === true;
}
function getNum(c: Record<string, unknown>, k: string): string {
  const v = c[k];
  return typeof v === 'number' ? String(v) : '';
}
function getStrArrayCsv(c: Record<string, unknown>, k: string): string {
  const v = c[k];
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').join(', ');
  return '';
}

function ConfigurationTab({
  agent,
  onSaved,
}: {
  agent: PaperclipAgentDetail;
  onSaved: () => Promise<void> | void;
}) {
  // Live config (independent fetch — agent prop only has the summary).
  const [config, setConfig] = useState<PaperclipAgentConfiguration | null>(null);
  const [companyAgents, setCompanyAgents] = useState<PaperclipAgentSummary[]>(
    [],
  );
  const [configLoading, setConfigLoading] = useState(true);

  // Identity
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('');
  const [title, setTitle] = useState('');
  const [role, setRole] = useState<AgentRole>('general');
  const [reportsTo, setReportsTo] = useState<string>('');
  const [capabilities, setCapabilities] = useState('');

  // Adapter
  const [adapterType, setAdapterType] = useState<string>('');
  const [model, setModel] = useState('');
  const [command, setCommand] = useState('');
  const [instructionsFilePath, setInstructionsFilePath] = useState('');
  const [extraArgs, setExtraArgs] = useState('');

  // Adapter-specific feature flags
  const [chromePath, setChromePath] = useState('');
  const [dangerouslySkipPermissions, setDangerouslySkipPermissions] =
    useState(false);
  const [search, setSearch] = useState(false);
  const [fastMode, setFastMode] = useState(false);

  // Run policy
  const [maxConcurrent, setMaxConcurrent] = useState<string>('');
  const [budgetCents, setBudgetCents] = useState<string>('');
  const [heartbeatEnabled, setHeartbeatEnabled] = useState(false);
  const [intervalSec, setIntervalSec] = useState<string>('60');

  // Permissions (separate save target)
  const [canCreateAgents, setCanCreateAgents] = useState(false);
  const [canAssignTasks, setCanAssignTasks] = useState(false);
  // Snapshot of the loaded permission values so we know what's dirty
  // — and skip the permissions PATCH when nothing changed.
  const [initialPerms, setInitialPerms] = useState<{
    canCreateAgents: boolean;
    canAssignTasks: boolean;
  } | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // ── Initial load ─────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setConfigLoading(true);
    void Promise.all([
      fetchAgentConfiguration(agent.id),
      fetchCompanyAgents(),
    ]).then(([cfg, agents]) => {
      if (cancelled) return;
      setCompanyAgents(agents);
      if (cfg) {
        setConfig(cfg);
        setName(cfg.name ?? '');
        setTitle(cfg.title ?? '');
        setRole(((cfg.role as AgentRole) ?? 'general'));
        setReportsTo(cfg.reportsTo ?? '');
        setAdapterType(cfg.adapterType ?? '');
        const ac = cfg.adapterConfig ?? {};
        setModel(getStr(ac, 'model'));
        setCommand(getStr(ac, 'command'));
        setInstructionsFilePath(getStr(ac, 'instructionsFilePath'));
        setExtraArgs(getStrArrayCsv(ac, 'extraArgs'));
        setChromePath(getStr(ac, 'chrome'));
        setDangerouslySkipPermissions(getBool(ac, 'dangerouslySkipPermissions'));
        setSearch(getBool(ac, 'search'));
        setFastMode(getBool(ac, 'fastMode'));
        const rc = cfg.runtimeConfig ?? {};
        setHeartbeatEnabled(getBool(rc, 'heartbeatEnabled'));
        const iv = getNum(rc, 'intervalSec');
        if (iv) setIntervalSec(iv);
        setCanCreateAgents(cfg.permissions.canCreateAgents);
        setCanAssignTasks(cfg.permissions.canAssignTasks);
        setInitialPerms({
          canCreateAgents: cfg.permissions.canCreateAgents,
          canAssignTasks: cfg.permissions.canAssignTasks,
        });
      }
      // Fields not surfaced by /configuration but available on the
      // summary `agent` prop (icon, description, budget, concurrency).
      setIcon(agent.icon ?? '');
      setCapabilities(agent.capabilities ?? '');
      setMaxConcurrent(
        agent.maxConcurrentRuns != null ? String(agent.maxConcurrentRuns) : '',
      );
      setBudgetCents(
        agent.budgetMonthlyCents != null
          ? String(agent.budgetMonthlyCents)
          : '',
      );
      setConfigLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [agent.id, agent.icon, agent.capabilities, agent.maxConcurrentRuns, agent.budgetMonthlyCents]);

  const reportsToOptions = companyAgents.filter((a) => a.id !== agent.id);
  const isCloud = CLOUD_ADAPTERS.has(adapterType);

  const canSubmit = name.trim().length > 0 && !saving && !configLoading;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setSaveError(null);

    // Build adapterConfig — only include keys that have values OR
    // are explicitly false (so toggles can be cleared). The backend
    // merges this into existing config by default.
    const adapterConfigPatch: Record<string, unknown> = {
      command: command.trim(),
      model: model.trim(),
      instructionsFilePath: instructionsFilePath.trim(),
      extraArgs: extraArgs
        ? extraArgs
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    };
    if (adapterSupportsChrome(adapterType)) {
      adapterConfigPatch.chrome = chromePath.trim();
    }
    if (adapterSupportsSkipPerm(adapterType)) {
      adapterConfigPatch.dangerouslySkipPermissions = dangerouslySkipPermissions;
    }
    if (adapterSupportsSearch(adapterType)) {
      adapterConfigPatch.search = search;
    }
    if (adapterSupportsFastMode(adapterType)) {
      adapterConfigPatch.fastMode = fastMode;
    }

    const runtimeConfigPatch: Record<string, unknown> = {
      heartbeatEnabled,
    };
    if (heartbeatEnabled) {
      const n = Number(intervalSec);
      if (Number.isFinite(n) && n > 0) runtimeConfigPatch.intervalSec = Math.round(n);
    }

    const agentPatch: Partial<PaperclipAgentDetail> = {
      name: name.trim(),
      icon: icon.trim() || null,
      title: title.trim() || null,
      role,
      reportsTo: reportsTo || null,
      capabilities: capabilities.trim() || null,
      adapterType,
      adapterConfig: adapterConfigPatch,
      runtimeConfig: runtimeConfigPatch,
      maxConcurrentRuns:
        maxConcurrent === '' ? null : Math.max(1, Number(maxConcurrent) | 0),
      budgetMonthlyCents:
        budgetCents === '' ? null : Math.max(0, Number(budgetCents) | 0),
    };

    // Determine whether permissions need a separate PATCH.
    const permsDirty =
      initialPerms == null ||
      initialPerms.canCreateAgents !== canCreateAgents ||
      initialPerms.canAssignTasks !== canAssignTasks;

    const [agentRes, permsOk] = await Promise.all([
      updateAgent(agent.id, agentPatch),
      permsDirty
        ? updateAgentPermissions(agent.id, { canCreateAgents, canAssignTasks })
        : Promise.resolve(true),
    ]);
    setSaving(false);
    if (!agentRes && !permsOk) {
      setSaveError('שמירת ההגדרות וההרשאות נכשלה.');
      return;
    }
    if (!agentRes) {
      setSaveError('שמירת ההגדרות נכשלה (ההרשאות נשמרו).');
      return;
    }
    if (!permsOk) {
      setSaveError('שמירת ההרשאות נכשלה (שאר ההגדרות נשמרו).');
      return;
    }
    setSavedAt(Date.now());
    setInitialPerms({ canCreateAgents, canAssignTasks });
    // Re-fetch live config so the form reflects backend-side normalizations.
    const fresh = await fetchAgentConfiguration(agent.id);
    if (fresh) setConfig(fresh);
    await onSaved();
  };

  if (configLoading) {
    return (
      <div style={{ fontSize: 13, color: '#94a3b8', padding: '20px 0' }}>
        טוען הגדרות סוכן…
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* ── Identity ── */}
      <ConfigSection title="זהות">
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 2, minWidth: 200 }}>
            <TextField
              label="שם הסוכן"
              value={name}
              onChange={setName}
              disabled={saving}
            />
          </div>
          <div style={{ flex: 1, minWidth: 80 }}>
            <TextField
              label="אייקון (emoji)"
              value={icon}
              onChange={setIcon}
              placeholder="🤖"
              disabled={saving}
            />
          </div>
        </div>
        <TextField
          label="תפקיד (Title)"
          value={title}
          onChange={setTitle}
          placeholder="לדוגמה: מנהל פרויקטים, מהנדס תוכנה"
          disabled={saving}
        />
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 140 }}>
            <SelectField
              label="Role"
              value={role}
              onChange={(v) => setRole(v as AgentRole)}
              disabled={saving}
              options={AGENT_ROLES.map((r) => ({
                value: r,
                label: ROLE_LABELS_FOR_CONFIG[r],
              }))}
            />
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <SelectField
              label="כפוף ל-"
              value={reportsTo}
              onChange={setReportsTo}
              disabled={saving}
              options={[
                { value: '', label: 'ללא מנהל (root)' },
                ...reportsToOptions.map((a) => ({
                  value: a.id,
                  label: a.title ? `${a.name} — ${a.title}` : a.name,
                })),
              ]}
            />
          </div>
        </div>
        <TextArea
          label="Capabilities (כישורים)"
          value={capabilities}
          onChange={setCapabilities}
          placeholder="מה הסוכן יודע לעשות"
          disabled={saving}
        />
      </ConfigSection>

      {/* ── Adapter ── */}
      <ConfigSection title="Adapter">
        <SelectField
          label="Adapter type"
          value={adapterType}
          onChange={setAdapterType}
          disabled={saving}
          options={AGENT_ADAPTER_TYPES.map((t) => ({
            value: t,
            label: ADAPTER_LABELS_FOR_CONFIG[t] ?? t,
          }))}
        />
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {!isCloud ? (
            <div style={{ flex: 1, minWidth: 140 }}>
              <TextField
                label="Command"
                value={command}
                onChange={setCommand}
                placeholder="CLI command"
                disabled={saving}
              />
            </div>
          ) : null}
          <div style={{ flex: 1, minWidth: 140 }}>
            <TextField
              label="Model"
              value={model}
              onChange={setModel}
              placeholder="Default (per adapter profile)"
              disabled={saving}
            />
          </div>
        </div>
        <TextField
          label="Agent instructions file"
          value={instructionsFilePath}
          onChange={setInstructionsFilePath}
          placeholder="/absolute/path/to/AGENTS.md"
          disabled={saving}
        />
        {!isCloud ? (
          <TextField
            label="Extra args (comma-separated)"
            value={extraArgs}
            onChange={setExtraArgs}
            placeholder="--verbose, --foo=bar"
            disabled={saving}
          />
        ) : null}
      </ConfigSection>

      {/* ── Adapter-specific feature flags (conditional) ── */}
      {(adapterSupportsChrome(adapterType) ||
        adapterSupportsSkipPerm(adapterType) ||
        adapterSupportsSearch(adapterType) ||
        adapterSupportsFastMode(adapterType)) ? (
        <ConfigSection title="הגדרות ייחודיות ל-Adapter">
          {adapterSupportsChrome(adapterType) ? (
            <TextField
              label="Chrome path"
              value={chromePath}
              onChange={setChromePath}
              placeholder="/path/to/chrome (אם נדרש)"
              disabled={saving}
            />
          ) : null}
          {adapterSupportsSkipPerm(adapterType) ? (
            <CheckboxRow
              label="Dangerously skip permissions"
              checked={dangerouslySkipPermissions}
              onChange={setDangerouslySkipPermissions}
              disabled={saving}
              hint="עוקף את אישורי הכלים של Claude. שימוש זהיר בלבד."
            />
          ) : null}
          {adapterSupportsSearch(adapterType) ? (
            <CheckboxRow
              label="Web search"
              checked={search}
              onChange={setSearch}
              disabled={saving}
            />
          ) : null}
          {adapterSupportsFastMode(adapterType) ? (
            <CheckboxRow
              label="Fast mode"
              checked={fastMode}
              onChange={setFastMode}
              disabled={saving}
            />
          ) : null}
        </ConfigSection>
      ) : null}

      {/* ── Run policy ── */}
      <ConfigSection title="Run policy">
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={labelStyle}>Max concurrent runs</span>
              <input
                type="number"
                min={1}
                value={maxConcurrent}
                onChange={(e) => setMaxConcurrent(e.target.value)}
                disabled={saving}
                style={fieldStyle}
              />
            </label>
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={labelStyle}>תקציב חודשי (סנט)</span>
              <input
                type="number"
                min={0}
                value={budgetCents}
                onChange={(e) => setBudgetCents(e.target.value)}
                disabled={saving}
                style={fieldStyle}
              />
            </label>
          </div>
        </div>
        <CheckboxRow
          label="Heartbeat on interval"
          checked={heartbeatEnabled}
          onChange={setHeartbeatEnabled}
          disabled={saving}
          hint="הפעלה אוטומטית מחזורית של הסוכן"
        />
        {heartbeatEnabled ? (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={labelStyle}>Interval (שניות)</span>
            <input
              type="number"
              min={5}
              value={intervalSec}
              onChange={(e) => setIntervalSec(e.target.value)}
              disabled={saving}
              style={{ ...fieldStyle, maxWidth: 160 }}
            />
          </label>
        ) : null}
      </ConfigSection>

      {/* ── Permissions ── */}
      <ConfigSection title="הרשאות">
        <CheckboxRow
          label="canCreateAgents"
          checked={canCreateAgents}
          onChange={setCanCreateAgents}
          disabled={saving}
          hint="מאפשר לסוכן ליצור / לגייס סוכנים חדשים"
        />
        <CheckboxRow
          label="canAssignTasks"
          checked={canAssignTasks}
          onChange={setCanAssignTasks}
          disabled={saving}
          hint="מאפשר לסוכן להקצות משימות לסוכנים אחרים"
        />
      </ConfigSection>

      {/* ── Config revisions ── */}
      <ConfigSection title="היסטוריית גרסאות הגדרה">
        <RevisionsAccordion
          agentId={agent.id}
          onRolledBack={async () => {
            // Reload config after rollback so the form reflects the
            // restored values.
            const fresh = await fetchAgentConfiguration(agent.id);
            if (fresh) setConfig(fresh);
            await onSaved();
          }}
        />
      </ConfigSection>

      {saveError ? (
        <div
          style={{
            fontSize: 12,
            color: '#fecaca',
            background: 'rgba(127,29,29,0.4)',
            padding: '6px 10px',
            borderRadius: 6,
          }}
        >
          {saveError}
        </div>
      ) : null}

      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBlockStart: 4,
        }}
      >
        <span style={{ fontSize: 10, color: '#64748b' }}>
          עודכן: {config?.updatedAt ? new Date(config.updatedAt).toLocaleString('he-IL') : '—'}
        </span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {savedAt && Date.now() - savedAt < 4000 ? (
            <span style={{ fontSize: 11, color: '#86efac' }}>נשמר ✓</span>
          ) : null}
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
            {saving ? 'שומר…' : 'שמור שינויים'}
          </button>
        </div>
      </div>

      {/* ── Danger Zone — destructive actions ─────────────────────
          Session 7: ✕ Terminate moved off the AgentActionToolbar
          (too close to everyday buttons → easy mis-click). It now
          lives here, visually quarantined with red trim + explicit
          confirm. */}
      <DangerZone
        agentName={agent.name}
        agentId={agent.id}
        onTerminated={async () => {
          await onSaved();
        }}
      />
    </div>
  );
}

function DangerZone({
  agentName,
  agentId,
  onTerminated,
}: {
  agentName: string;
  agentId: string;
  onTerminated: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);

  const onTerminate = async () => {
    const ok = window.confirm(
      `להפסיק את הסוכן "${agentName}" לצמיתות?\n\n` +
        'הסוכן יסומן כ-terminated ולא יוכל להריץ heartbeats חדשים. ' +
        'שחזור אפשרי רק דרך הדשבורד של Paperclip. רוטינות פעילות שלו ' +
        'יחדלו להפעיל אותו.',
    );
    if (!ok) return;
    setBusy(true);
    const success = await terminateAgent(agentId);
    setBusy(false);
    if (!success) {
      window.alert('הפסקת הסוכן נכשלה. בדוק את הדשבורד של Paperclip.');
      return;
    }
    await onTerminated();
  };

  return (
    <div
      style={{
        marginBlockStart: 18,
        background: 'rgba(127, 29, 29, 0.18)',
        border: '1px solid rgba(239, 68, 68, 0.4)',
        borderRadius: 10,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.5,
          color: '#fecaca',
          textTransform: 'uppercase',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span>⚠</span> אזור מסוכן
      </div>
      <div style={{ fontSize: 12, color: '#fca5a5', lineHeight: 1.5 }}>
        פעולות בלתי-הפיכות. עצור והבן את ההשלכות לפני שלוחצים.
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          padding: 10,
          background: 'rgba(127, 29, 29, 0.28)',
          border: '1px solid rgba(239, 68, 68, 0.45)',
          borderRadius: 8,
        }}
      >
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#fee2e2' }}>
            הפסקת הסוכן
          </div>
          <div style={{ fontSize: 11, color: '#fca5a5', marginBlockStart: 4, lineHeight: 1.5 }}>
            הסוכן יסומן כ-<code>terminated</code>. כל ה-heartbeats יחדלו.
            הרוטינות שלו ימשיכו להופיע ברשימה אך לא יפעלו אותו. שחזור רק
            דרך Paperclip.
          </div>
        </div>
        <button
          type="button"
          onClick={() => void onTerminate()}
          disabled={busy}
          style={{
            padding: '8px 16px',
            borderRadius: 7,
            border: '1px solid rgba(239, 68, 68, 0.7)',
            background: 'rgba(239, 68, 68, 0.32)',
            color: '#fee2e2',
            fontSize: 12,
            fontWeight: 700,
            fontFamily: 'inherit',
            cursor: busy ? 'not-allowed' : 'pointer',
            opacity: busy ? 0.5 : 1,
            flexShrink: 0,
          }}
        >
          {busy ? 'מפסיק…' : '✕ הפסק סוכן'}
        </button>
      </div>
    </div>
  );
}

// ── Small helpers ────────────────────────────────────────────────

function ConfigSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 10,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.5,
          color: '#cbd5e1',
          textTransform: 'uppercase',
          borderBlockEnd: '1px solid rgba(255,255,255,0.08)',
          paddingBlockEnd: 6,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  disabled,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  options: { value: string; label: string }[];
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={labelStyle}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={fieldStyle}
      >
        {options.map((o) => (
          <option
            key={o.value}
            value={o.value}
            style={{ background: '#1e293b', color: '#f1f5f9' }}
          >
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function CheckboxRow({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 13,
          color: '#cbd5e1',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
          style={{
            width: 16,
            height: 16,
            accentColor: '#6366f1',
            cursor: disabled ? 'not-allowed' : 'pointer',
          }}
        />
        <span>{label}</span>
      </label>
      {hint ? (
        <div style={{ fontSize: 10, color: '#64748b', marginInlineStart: 24 }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

// ── Configuration revisions accordion (Session 5.D) ──────────────

function RevisionsAccordion({
  agentId,
  onRolledBack,
}: {
  agentId: string;
  onRolledBack: () => Promise<void> | void;
}) {
  const [revisions, setRevisions] = useState<PaperclipConfigRevision[] | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [rollingBackId, setRollingBackId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const r = await fetchAgentConfigRevisions(agentId);
    setRevisions(r);
    setLoading(false);
  }, [agentId]);

  // Lazy: only fetch when the operator opens the accordion.
  useEffect(() => {
    if (!open || revisions != null) return;
    void reload();
  }, [open, revisions, reload]);

  const onRollback = async (revId: string) => {
    if (
      !window.confirm(
        'לשחזר את גרסת ההגדרה הזו? הסוכן יחזור לערכים שהיו בנקודה הזו.',
      )
    ) {
      return;
    }
    setRollingBackId(revId);
    const ok = await rollbackAgentConfigRevision(agentId, revId);
    setRollingBackId(null);
    if (!ok) {
      window.alert('שחזור הגרסה נכשל.');
      return;
    }
    await reload();
    await onRolledBack();
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '6px 10px',
          background: 'transparent',
          border: '1px dashed rgba(255,255,255,0.18)',
          borderRadius: 8,
          color: '#cbd5e1',
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: 12,
        }}
      >
        <span>
          {open ? '▲' : '▼'} גרסאות הגדרה
          {revisions ? ` (${revisions.length})` : ''}
        </span>
        <span style={{ fontSize: 10, opacity: 0.7 }}>
          כל שמירה יוצרת גרסה — ניתן לשחזר כל אחת
        </span>
      </button>
      {open ? (
        loading ? (
          <div style={{ fontSize: 12, color: '#94a3b8', padding: '10px 0' }}>
            טוען היסטוריה…
          </div>
        ) : revisions == null || revisions.length === 0 ? (
          <div style={{ fontSize: 12, color: '#94a3b8', padding: '10px 0' }}>
            אין גרסאות שמורות.
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              marginBlockStart: 8,
            }}
          >
            {revisions.map((r) => (
              <RevisionRow
                key={r.id}
                rev={r}
                rollingBack={rollingBackId === r.id}
                onRollback={() => void onRollback(r.id)}
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

function RevisionRow({
  rev,
  rollingBack,
  onRollback,
}: {
  rev: PaperclipConfigRevision;
  rollingBack: boolean;
  onRollback: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 8,
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontFamily:
            "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
          background: 'rgba(0,0,0,0.35)',
          padding: '1px 6px',
          borderRadius: 4,
          color: '#cbd5e1',
          flexShrink: 0,
        }}
      >
        {rev.id.slice(0, 8)}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: '#e2e8f0' }}>
          {new Date(rev.createdAt).toLocaleString('he-IL')}
          <span style={{ opacity: 0.7, marginInlineStart: 6 }}>
            · {rev.source}
          </span>
        </div>
        {rev.changedKeys && rev.changedKeys.length > 0 ? (
          <div
            style={{
              fontSize: 10,
              color: '#94a3b8',
              marginBlockStart: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={rev.changedKeys.join(', ')}
          >
            שינויים: {rev.changedKeys.join(', ')}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onRollback}
        disabled={rollingBack}
        title="שחזר את ההגדרות לגרסה הזו"
        style={{
          padding: '4px 10px',
          fontSize: 11,
          borderRadius: 6,
          border: '1px solid rgba(99,102,241,0.55)',
          background: 'rgba(99,102,241,0.18)',
          color: '#e0e7ff',
          cursor: rollingBack ? 'not-allowed' : 'pointer',
          opacity: rollingBack ? 0.5 : 1,
          fontFamily: 'inherit',
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        {rollingBack ? 'משחזר…' : 'שחזר'}
      </button>
    </div>
  );
}

// ── Instructions tab ─────────────────────────────────────────────

// Session 6: Instructions is a multi-file bundle. Layout = left
// sidebar (file list with ★ entry-file badge + size + delete) | right
// editor (selected file). New-file row at the bottom of the sidebar.
// "Save" is per-file. Switching files prompts if dirty.
function InstructionsTab({ agentUuid }: { agentUuid: string }) {
  const [bundle, setBundle] = useState<PaperclipInstructionsBundle | null>(
    null,
  );
  const [activePath, setActivePath] = useState<string>('');
  const [content, setContent] = useState('');
  const [origContent, setOrigContent] = useState('');
  const [loadingBundle, setLoadingBundle] = useState(true);
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [newPath, setNewPath] = useState('');

  // ── Initial bundle load ─────────────────────────────────────
  const reloadBundle = useCallback(async () => {
    setLoadingBundle(true);
    const b = await fetchAgentInstructions(agentUuid);
    if (b) {
      setBundle(b);
      // Default-select the entry file the first time.
      setActivePath((prev) => prev || b.entryPath);
    } else {
      setError('לא ניתן לטעון את חבילת ההוראות.');
    }
    setLoadingBundle(false);
  }, [agentUuid]);

  useEffect(() => {
    void reloadBundle();
  }, [reloadBundle]);

  // ── Load file content whenever active path changes ─────────
  useEffect(() => {
    if (!activePath) return;
    let cancelled = false;
    setLoadingFile(true);
    setError(null);
    void fetchInstructionsFile(agentUuid, activePath).then((f) => {
      if (cancelled) return;
      if (!f) {
        setError(`לא ניתן לטעון את הקובץ ${activePath}.`);
        setContent('');
        setOrigContent('');
      } else {
        setContent(f.content);
        setOrigContent(f.content);
      }
      setLoadingFile(false);
    });
    return () => {
      cancelled = true;
    };
  }, [agentUuid, activePath]);

  const dirty = content !== origContent;

  const switchFile = (path: string) => {
    if (path === activePath) return;
    if (dirty && !window.confirm('יש שינויים שלא נשמרו. לעבור בכל זאת?')) {
      return;
    }
    setActivePath(path);
  };

  const submit = async () => {
    if (!activePath) return;
    setSaving(true);
    const ok = await saveInstructionsFile(agentUuid, activePath, content);
    setSaving(false);
    if (!ok) {
      setError('שמירת הקובץ נכשלה.');
      return;
    }
    setOrigContent(content);
    setSavedAt(Date.now());
    void reloadBundle();
  };

  const onAddFile = async () => {
    const path = newPath.trim();
    if (!path) return;
    if (bundle?.files.some((f) => f.path === path)) {
      window.alert('קובץ עם השם הזה כבר קיים בחבילה.');
      return;
    }
    setSaving(true);
    const ok = await saveInstructionsFile(agentUuid, path, '');
    setSaving(false);
    if (!ok) {
      setError('יצירת הקובץ נכשלה.');
      return;
    }
    setNewPath('');
    await reloadBundle();
    setActivePath(path);
  };

  const onDeleteFile = async (path: string) => {
    if (path === bundle?.entryPath) {
      window.alert('לא ניתן למחוק את קובץ הכניסה של החבילה.');
      return;
    }
    if (!window.confirm(`למחוק את הקובץ "${path}"?`)) return;
    setSaving(true);
    const ok = await deleteInstructionsFile(agentUuid, path);
    setSaving(false);
    if (!ok) {
      setError('מחיקת הקובץ נכשלה.');
      return;
    }
    if (activePath === path) {
      setActivePath(bundle?.entryPath ?? '');
    }
    await reloadBundle();
  };

  if (loadingBundle && !bundle) {
    return (
      <div style={{ fontSize: 13, color: '#94a3b8', padding: '20px 0' }}>
        טוען חבילה…
      </div>
    );
  }

  const readOnly = bundle && !bundle.editable;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Bundle metadata row */}
      {bundle ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'wrap',
            fontSize: 11,
            color: '#94a3b8',
          }}
        >
          {bundle.mode ? (
            <span
              style={{
                background: 'rgba(99,102,241,0.22)',
                color: '#c7d2fe',
                padding: '1px 8px',
                borderRadius: 999,
                fontWeight: 700,
              }}
            >
              mode: {bundle.mode}
            </span>
          ) : null}
          {readOnly ? (
            <span
              style={{
                background: 'rgba(245,158,11,0.22)',
                color: '#fde68a',
                padding: '1px 8px',
                borderRadius: 999,
                fontWeight: 700,
              }}
            >
              קריאה בלבד
            </span>
          ) : null}
          {bundle.rootPath ? (
            <span
              style={{
                fontFamily:
                  "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
                background: 'rgba(0,0,0,0.3)',
                padding: '1px 6px',
                borderRadius: 4,
              }}
              title={bundle.rootPath}
            >
              {bundle.rootPath}
            </span>
          ) : null}
          {bundle.warnings.length > 0
            ? bundle.warnings.map((w, i) => (
                <span key={i} style={{ color: '#fca5a5' }}>
                  ⚠ {w}
                </span>
              ))
            : null}
        </div>
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(180px, 240px) 1fr',
          gap: 12,
          alignItems: 'stretch',
        }}
      >
        {/* Sidebar — files */}
        <div
          style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 8,
            padding: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            minWidth: 0,
          }}
        >
          {bundle?.files.map((f) => (
            <InstructionsFileRow
              key={f.path}
              file={f}
              active={f.path === activePath}
              canDelete={!readOnly && !f.isEntry}
              onSelect={() => switchFile(f.path)}
              onDelete={() => void onDeleteFile(f.path)}
            />
          ))}
          {!readOnly ? (
            <div
              style={{
                display: 'flex',
                gap: 4,
                marginBlockStart: 6,
                borderBlockStart: '1px solid rgba(255,255,255,0.08)',
                paddingBlockStart: 6,
              }}
            >
              <input
                type="text"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                placeholder="path/to/file.md"
                disabled={saving}
                style={{
                  ...fieldStyle,
                  flex: 1,
                  minWidth: 0,
                  padding: '6px 8px',
                  fontSize: 11,
                  fontFamily:
                    "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void onAddFile();
                }}
              />
              <button
                type="button"
                onClick={() => void onAddFile()}
                disabled={saving || !newPath.trim()}
                title="הוסף קובץ"
                style={{
                  padding: '6px 10px',
                  borderRadius: 6,
                  border: '1px solid rgba(34,197,94,0.55)',
                  background: 'rgba(34,197,94,0.22)',
                  color: '#dcfce7',
                  cursor:
                    saving || !newPath.trim() ? 'not-allowed' : 'pointer',
                  fontSize: 13,
                  fontFamily: 'inherit',
                  fontWeight: 700,
                  opacity: saving || !newPath.trim() ? 0.5 : 1,
                  flexShrink: 0,
                }}
              >
                +
              </button>
            </div>
          ) : null}
        </div>

        {/* Editor — selected file */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div
            style={{
              fontSize: 11,
              color: '#94a3b8',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span>קובץ נבחר:</span>
            <span
              style={{
                fontFamily:
                  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
                background: 'rgba(0,0,0,0.3)',
                padding: '1px 6px',
                borderRadius: 4,
              }}
            >
              {activePath || '—'}
            </span>
            {activePath === bundle?.entryPath ? (
              <span
                style={{
                  fontSize: 10,
                  color: '#fde68a',
                  padding: '1px 6px',
                  borderRadius: 999,
                  background: 'rgba(245,158,11,0.18)',
                  fontWeight: 700,
                }}
                title="קובץ כניסת החבילה"
              >
                ★ entry
              </span>
            ) : null}
          </div>
          {loadingFile ? (
            <div style={{ fontSize: 13, color: '#94a3b8', padding: '20px 0' }}>
              טוען קובץ…
            </div>
          ) : (
            <>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                disabled={saving || !!readOnly}
                rows={18}
                style={{
                  ...fieldStyle,
                  resize: 'vertical',
                  minHeight: 320,
                  fontFamily:
                    "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 12,
                  lineHeight: 1.5,
                }}
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
              {!readOnly ? (
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                  }}
                >
                  {savedAt && Date.now() - savedAt < 4000 ? (
                    <span style={{ fontSize: 11, color: '#86efac' }}>נשמר ✓</span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void submit()}
                    disabled={saving || !dirty}
                    style={{
                      ...primaryBtn,
                      opacity: saving || !dirty ? 0.5 : 1,
                      cursor: saving || !dirty ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {saving ? 'שומר…' : dirty ? 'שמור קובץ' : 'אין שינויים'}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function InstructionsFileRow({
  file,
  active,
  canDelete,
  onSelect,
  onDelete,
}: {
  file: { path: string; bytes?: number; isEntry?: boolean };
  active: boolean;
  canDelete: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 8px',
        background: active
          ? 'rgba(99,102,241,0.22)'
          : hover
            ? 'rgba(255,255,255,0.06)'
            : 'transparent',
        border: `1px solid ${active ? 'rgba(99,102,241,0.55)' : 'transparent'}`,
        borderRadius: 6,
        cursor: 'pointer',
        minWidth: 0,
      }}
    >
      {file.isEntry ? (
        <span style={{ color: '#fde68a', fontSize: 11 }} title="קובץ כניסה">
          ★
        </span>
      ) : null}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 11,
          fontFamily:
            "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
          color: '#e2e8f0',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={file.path}
      >
        {file.path}
      </span>
      {canDelete && hover ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="מחק קובץ"
          aria-label="מחק קובץ"
          style={{
            width: 18,
            height: 18,
            padding: 0,
            background: 'transparent',
            border: 'none',
            color: '#fca5a5',
            cursor: 'pointer',
            fontSize: 12,
            lineHeight: 1,
          }}
        >
          🗑
        </button>
      ) : null}
    </div>
  );
}

// ── Skills tab ───────────────────────────────────────────────────

// Session 6: skills work on a snapshot model. The agent snapshot
// reports every skill the adapter knows about (with state + origin),
// plus the desiredSkills list. The company library is a separate
// fetch — feeds the "+ add skill" picker for skills not yet in the
// agent's entry list.

const SKILL_STATE_COLOR: Record<string, string> = {
  installed: '#22c55e',
  configured: '#0ea5e9',
  available: '#94a3b8',
  external: '#a855f7',
  stale: '#f59e0b',
  missing: '#ef4444',
};

const SKILL_STATE_LABEL: Record<string, string> = {
  installed: 'מותקן',
  configured: 'מוגדר',
  available: 'זמין',
  external: 'חיצוני',
  stale: 'מיושן',
  missing: 'חסר',
};

function SkillsTab({ agentUuid }: { agentUuid: string }) {
  const [snapshot, setSnapshot] = useState<PaperclipAgentSkillSnapshot | null>(
    null,
  );
  const [companyLib, setCompanyLib] = useState<PaperclipCompanySkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addKey, setAddKey] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    const [snap, lib] = await Promise.all([
      fetchAgentSkills(agentUuid),
      fetchCompanySkills(),
    ]);
    setSnapshot(snap);
    setCompanyLib(lib);
    setLoading(false);
  }, [agentUuid]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loading) {
    return (
      <div style={{ fontSize: 13, color: '#94a3b8', padding: '20px 0' }}>
        טוען מיומנויות…
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div style={{ fontSize: 13, color: '#fecaca', padding: '20px 0' }}>
        לא ניתן לטעון את snapshot המיומנויות.
      </div>
    );
  }

  if (!snapshot.supported) {
    return (
      <div
        style={{
          fontSize: 13,
          color: '#94a3b8',
          padding: 20,
          background: 'rgba(255,255,255,0.04)',
          border: '1px dashed rgba(255,255,255,0.12)',
          borderRadius: 8,
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 22, marginBlockEnd: 6 }}>🔒</div>
        adapter <code>{snapshot.adapterType}</code> לא תומך במיומנויות.
      </div>
    );
  }

  // Company-library skills the operator could ADD (not already in the
  // entry list as a desired skill).
  const entryKeys = new Set(snapshot.entries.map((e) => e.key));
  const addable = companyLib.filter((c) => c.key && !entryKeys.has(c.key));

  const toggleDesired = async (key: string, next: boolean) => {
    if (syncing) return;
    setError(null);
    const newDesired = next
      ? Array.from(new Set([...snapshot.desiredSkills, key]))
      : snapshot.desiredSkills.filter((k) => k !== key);
    setSyncing(true);
    const updated = await syncAgentSkills(agentUuid, newDesired);
    setSyncing(false);
    if (!updated) {
      setError('סנכרון המיומנויות נכשל.');
      return;
    }
    setSnapshot(updated);
  };

  const addCompanySkill = async () => {
    const key = addKey.trim();
    if (!key) return;
    await toggleDesired(key, true);
    setAddKey('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div
        style={{
          fontSize: 11,
          color: '#94a3b8',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            background: 'rgba(99,102,241,0.22)',
            color: '#c7d2fe',
            padding: '1px 8px',
            borderRadius: 999,
            fontWeight: 700,
          }}
        >
          mode: {snapshot.mode}
        </span>
        <span>
          {snapshot.desiredSkills.length} מיומנויות מבוקשות · {snapshot.entries.length}{' '}
          ב-snapshot
        </span>
        {snapshot.warnings.map((w, i) => (
          <span key={i} style={{ color: '#fca5a5' }}>
            ⚠ {w}
          </span>
        ))}
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

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {snapshot.entries.length === 0 ? (
          <div
            style={{ fontSize: 12, color: '#94a3b8', padding: '10px 0' }}
          >
            לסוכן הזה לא רשומות מיומנויות עדיין.
          </div>
        ) : (
          snapshot.entries.map((e) => (
            <SkillEntryRow
              key={e.key}
              entry={e}
              syncing={syncing}
              onToggle={(next) => void toggleDesired(e.key, next)}
            />
          ))
        )}
      </div>

      {/* Add-from-library picker */}
      {addable.length > 0 ? (
        <div
          style={{
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            borderBlockStart: '1px solid rgba(255,255,255,0.08)',
            paddingBlockStart: 10,
          }}
        >
          <span style={{ fontSize: 11, color: '#94a3b8', flexShrink: 0 }}>
            הוסף מהספרייה:
          </span>
          <select
            value={addKey}
            onChange={(e) => setAddKey(e.target.value)}
            disabled={syncing}
            style={{ ...fieldStyle, flex: 1, minWidth: 0 }}
          >
            <option value="" style={{ background: '#1e293b', color: '#f1f5f9' }}>
              בחר מיומנות…
            </option>
            {addable.map((c) => (
              <option
                key={c.key}
                value={c.key}
                style={{ background: '#1e293b', color: '#f1f5f9' }}
              >
                {c.name ?? c.key}
                {c.category ? ` · ${c.category}` : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void addCompanySkill()}
            disabled={syncing || !addKey}
            style={{
              ...primaryBtn,
              padding: '6px 12px',
              fontSize: 12,
              opacity: syncing || !addKey ? 0.5 : 1,
              cursor: syncing || !addKey ? 'not-allowed' : 'pointer',
              flexShrink: 0,
            }}
          >
            הוסף
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SkillEntryRow({
  entry,
  syncing,
  onToggle,
}: {
  entry: PaperclipAgentSkillEntry;
  syncing: boolean;
  onToggle: (next: boolean) => void;
}) {
  const stateColor = SKILL_STATE_COLOR[entry.state] ?? '#64748b';
  const stateLabel = SKILL_STATE_LABEL[entry.state] ?? entry.state;
  const disabled = syncing || entry.readOnly || entry.required;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '8px 10px',
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 8,
      }}
    >
      <input
        type="checkbox"
        checked={entry.desired}
        disabled={disabled}
        onChange={(e) => onToggle(e.target.checked)}
        title={
          entry.required
            ? 'מיומנות חובה — לא ניתן לבטל'
            : entry.readOnly
              ? 'מיומנות קריאה-בלבד'
              : ''
        }
        style={{
          width: 16,
          height: 16,
          accentColor: '#6366f1',
          marginBlockStart: 3,
          cursor: disabled ? 'not-allowed' : 'pointer',
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: '#e2e8f0',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'wrap',
          }}
        >
          <span
            style={{
              fontFamily:
                "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
            }}
          >
            {entry.runtimeName ?? entry.key}
          </span>
          <span
            style={{
              fontSize: 10,
              padding: '1px 6px',
              borderRadius: 999,
              background: `${stateColor}33`,
              color: stateColor,
              fontWeight: 700,
            }}
          >
            {stateLabel}
          </span>
          {entry.required ? (
            <span
              style={{
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 999,
                background: 'rgba(245,158,11,0.22)',
                color: '#fde68a',
                fontWeight: 700,
              }}
            >
              חובה
            </span>
          ) : null}
          {entry.managed ? (
            <span
              style={{
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 999,
                background: 'rgba(99,102,241,0.22)',
                color: '#c7d2fe',
              }}
            >
              מנוהל
            </span>
          ) : null}
        </div>
        {entry.originLabel ? (
          <div
            style={{ fontSize: 11, color: '#94a3b8', marginBlockStart: 2 }}
          >
            מקור: {entry.originLabel}
          </div>
        ) : null}
        {entry.locationLabel ? (
          <div
            style={{
              fontSize: 10,
              color: '#64748b',
              marginBlockStart: 2,
              fontFamily:
                "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
            }}
            title={entry.sourcePath ?? entry.targetPath ?? ''}
          >
            {entry.locationLabel}
          </div>
        ) : null}
        {entry.detail ? (
          <div
            style={{ fontSize: 11, color: '#94a3b8', marginBlockStart: 2 }}
          >
            {entry.detail}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── Runs tab (list + drill-down log) ─────────────────────────────

function RunsTab({ agentUuid }: { agentUuid: string }) {
  const [runs, setRuns] = useState<PaperclipHeartbeatRunSummary[] | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const r = await fetchAgentRuns(agentUuid);
    setRuns(r);
    setLoading(false);
  }, [agentUuid]);

  useEffect(() => {
    let cancelled = false;
    void reload();
    // Refresh when a run starts/ends — heartbeat.run.* events fan out
    // through `subscribeActivity` (Paperclip mirrors them into activity
    // log entries) so we get a single subscription for both signals.
    const unsub = subscribeActivity((payload) => {
      const action = String(payload.action ?? '');
      const ea = String(payload.agentId ?? '');
      if (!action.startsWith('heartbeat.') && !action.startsWith('run.')) return;
      if (ea && ea !== agentUuid) return;
      if (!cancelled) void reload();
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [agentUuid, reload]);

  const onCancel = async (runId: string) => {
    if (!window.confirm('לבטל את הריצה הזו?')) return;
    setCancelling(runId);
    const ok = await cancelRun(runId);
    setCancelling(null);
    if (ok) void reload();
    else window.alert('ביטול הריצה נכשל.');
  };

  if (loading && runs == null) {
    return (
      <div style={{ fontSize: 13, color: '#94a3b8', padding: '20px 0' }}>
        טוען היסטוריית ריצות…
      </div>
    );
  }
  if (!runs || runs.length === 0) {
    return (
      <div style={{ fontSize: 13, color: '#94a3b8', padding: '20px 0' }}>
        אין ריצות לסוכן הזה.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {runs.map((r) => (
        <RunRow
          key={r.id}
          run={r}
          expanded={openRunId === r.id}
          cancelling={cancelling === r.id}
          onToggle={() => setOpenRunId((cur) => (cur === r.id ? null : r.id))}
          onCancel={() => void onCancel(r.id)}
        />
      ))}
    </div>
  );
}

function RunRow({
  run,
  expanded,
  cancelling,
  onToggle,
  onCancel,
}: {
  run: PaperclipHeartbeatRunSummary;
  expanded: boolean;
  cancelling: boolean;
  onToggle: () => void;
  onCancel: () => void;
}) {
  const isActive = run.status === 'running' || run.status === 'queued';
  const statusColor =
    run.status === 'succeeded'
      ? '#22c55e'
      : run.status === 'failed' || run.status === 'error'
        ? '#ef4444'
        : run.status === 'cancelled' || run.status === 'timed_out'
          ? '#94a3b8'
          : '#f59e0b';
  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <div
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 10px',
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: statusColor,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: '#cbd5e1',
            flexShrink: 0,
            background: 'rgba(0,0,0,0.25)',
            padding: '1px 6px',
            borderRadius: 4,
            fontFamily:
              "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
          }}
        >
          {run.id.slice(0, 8)}
        </span>
        <span style={{ fontSize: 12, color: '#e2e8f0', flex: 1, minWidth: 0 }}>
          {run.invocationSource ?? 'run'}
          {run.triggerDetail ? ` · ${run.triggerDetail}` : ''}
        </span>
        {run.model ? (
          <span style={{ fontSize: 10, color: '#94a3b8', flexShrink: 0 }}>
            {run.model}
          </span>
        ) : null}
        <span style={{ fontSize: 10, color: '#94a3b8', flexShrink: 0 }}>
          {run.status}
        </span>
        <span style={{ fontSize: 10, color: '#64748b', flexShrink: 0 }}>
          {expanded ? '▲' : '▼'}
        </span>
      </div>
      {expanded ? (
        <div
          style={{
            padding: '8px 10px',
            borderBlockStart: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <RunMetrics run={run} />
          {isActive ? (
            <button
              type="button"
              onClick={onCancel}
              disabled={cancelling}
              style={{
                alignSelf: 'flex-end',
                padding: '5px 10px',
                fontSize: 11,
                borderRadius: 6,
                border: '1px solid rgba(239,68,68,0.6)',
                background: 'rgba(239,68,68,0.18)',
                color: '#fecaca',
                cursor: cancelling ? 'not-allowed' : 'pointer',
                opacity: cancelling ? 0.5 : 1,
                fontFamily: 'inherit',
              }}
            >
              {cancelling ? 'מבטל…' : 'בטל ריצה'}
            </button>
          ) : null}
          <RunSubPanels run={run} />
        </div>
      ) : null}
    </div>
  );
}

// ── Run sub-panels (Session 6.E) ─────────────────────────────
//
// Inside an expanded run we surface five views Paperclip's own UI
// shows: Log (text stream), Events (typed lifecycle events), Issues
// touched, Workspace operations, and an "Invocation" synthetic panel
// that just pretty-prints the run summary fields. Each tab loads
// lazily — switching to a tab fires its fetch the first time.

type RunSubTab = 'log' | 'events' | 'issues' | 'workspace' | 'invocation';

const RUN_SUBTAB_LABELS: Record<RunSubTab, string> = {
  log: 'Log',
  events: 'Events',
  issues: 'Issues Touched',
  workspace: 'Workspace',
  invocation: 'Invocation',
};

const RUN_SUBTABS: RunSubTab[] = [
  'log',
  'events',
  'issues',
  'workspace',
  'invocation',
];

function RunSubPanels({ run }: { run: PaperclipHeartbeatRunSummary }) {
  const [tab, setTab] = useState<RunSubTab>('log');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        style={{
          display: 'flex',
          gap: 2,
          borderBlockEnd: '1px solid rgba(255,255,255,0.08)',
          paddingBlockEnd: 4,
          flexWrap: 'wrap',
        }}
      >
        {RUN_SUBTABS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            style={{
              padding: '3px 8px',
              borderRadius: 5,
              border: 'none',
              background: tab === id ? 'rgba(99,102,241,0.3)' : 'transparent',
              color: tab === id ? '#e0e7ff' : '#94a3b8',
              fontWeight: 700,
              fontSize: 10,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            {RUN_SUBTAB_LABELS[id]}
          </button>
        ))}
      </div>
      {tab === 'log' ? (
        <RunLog runId={run.id} />
      ) : tab === 'events' ? (
        <RunEventsPanel runId={run.id} />
      ) : tab === 'issues' ? (
        <RunIssuesPanel runId={run.id} />
      ) : tab === 'workspace' ? (
        <RunWorkspacePanel runId={run.id} />
      ) : (
        <RunInvocationPanel run={run} />
      )}
    </div>
  );
}

function RunEventsPanel({ runId }: { runId: string }) {
  const [events, setEvents] = useState<PaperclipRunEvent[] | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchRunEvents(runId).then((e) => {
      if (cancelled) return;
      setEvents(e);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [runId]);
  if (loading) return <RunSubLoadingHint>טוען events…</RunSubLoadingHint>;
  if (!events || events.length === 0)
    return <RunSubLoadingHint>אין events לריצה הזו.</RunSubLoadingHint>;
  return (
    <RunSubScroll>
      {events.map((ev) => (
        <div
          key={ev.id}
          style={{
            display: 'flex',
            gap: 8,
            padding: '4px 0',
            borderBlockEnd: '1px solid rgba(255,255,255,0.05)',
            fontSize: 11,
          }}
        >
          <span
            style={{
              color: '#64748b',
              fontFamily:
                "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
              flexShrink: 0,
              width: 30,
            }}
          >
            #{ev.seq}
          </span>
          <span
            style={{
              fontWeight: 700,
              color: ev.color || '#cbd5e1',
              flexShrink: 0,
              minWidth: 90,
            }}
          >
            {ev.eventType}
          </span>
          {ev.stream ? (
            <span
              style={{
                color: '#94a3b8',
                fontSize: 10,
                padding: '0 4px',
                borderRadius: 3,
                background: 'rgba(255,255,255,0.06)',
                flexShrink: 0,
              }}
            >
              {ev.stream}
            </span>
          ) : null}
          <span style={{ color: '#e2e8f0', flex: 1, minWidth: 0 }}>
            {ev.message ?? ''}
          </span>
          <span
            style={{ color: '#64748b', fontSize: 10, flexShrink: 0 }}
            title={ev.createdAt}
          >
            {new Date(ev.createdAt).toLocaleTimeString('he-IL')}
          </span>
        </div>
      ))}
    </RunSubScroll>
  );
}

function RunIssuesPanel({ runId }: { runId: string }) {
  const [issues, setIssues] = useState<PaperclipRunIssue[] | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchRunIssuesTouched(runId).then((r) => {
      if (cancelled) return;
      setIssues(r);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [runId]);
  if (loading) return <RunSubLoadingHint>טוען issues…</RunSubLoadingHint>;
  if (!issues || issues.length === 0)
    return <RunSubLoadingHint>הריצה לא נגעה ב-issues.</RunSubLoadingHint>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {issues.map((iss) => (
        <div
          key={iss.issueId}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 8px',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: 6,
          }}
        >
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
            {iss.identifier ?? iss.issueId.slice(0, 8)}
          </span>
          <span
            style={{
              fontSize: 12,
              color: '#e2e8f0',
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={iss.title}
          >
            {iss.title}
          </span>
          <span style={{ fontSize: 10, color: '#94a3b8', flexShrink: 0 }}>
            {iss.status}
          </span>
        </div>
      ))}
    </div>
  );
}

function RunWorkspacePanel({ runId }: { runId: string }) {
  const [ops, setOps] = useState<PaperclipWorkspaceOperation[] | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchRunWorkspaceOperations(runId).then((o) => {
      if (cancelled) return;
      setOps(o);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [runId]);
  if (loading) return <RunSubLoadingHint>טוען workspace operations…</RunSubLoadingHint>;
  if (!ops || ops.length === 0)
    return (
      <RunSubLoadingHint>אין workspace operations לריצה הזו.</RunSubLoadingHint>
    );
  return (
    <RunSubScroll>
      {ops.map((op) => (
        <div
          key={op.id}
          style={{
            display: 'flex',
            gap: 8,
            padding: '4px 0',
            borderBlockEnd: '1px solid rgba(255,255,255,0.05)',
            fontSize: 11,
          }}
        >
          <span
            style={{
              fontWeight: 700,
              color: '#cbd5e1',
              flexShrink: 0,
              minWidth: 110,
            }}
          >
            {op.operation}
          </span>
          {op.status ? (
            <span
              style={{
                fontSize: 10,
                padding: '0 4px',
                borderRadius: 3,
                background: 'rgba(255,255,255,0.06)',
                color: '#94a3b8',
                flexShrink: 0,
              }}
            >
              {op.status}
            </span>
          ) : null}
          <span style={{ color: '#e2e8f0', flex: 1, minWidth: 0 }}>
            {op.message ?? ''}
          </span>
          <span
            style={{ color: '#64748b', fontSize: 10, flexShrink: 0 }}
            title={op.createdAt}
          >
            {new Date(op.createdAt).toLocaleTimeString('he-IL')}
          </span>
        </div>
      ))}
    </RunSubScroll>
  );
}

// Invocation — synthetic panel from the run summary. No new endpoint
// because Paperclip's own UI sources this from the run row itself.
function RunInvocationPanel({ run }: { run: PaperclipHeartbeatRunSummary }) {
  const fields: { label: string; value: string }[] = [];
  const push = (label: string, v: unknown) => {
    if (v == null || v === '') return;
    fields.push({ label, value: String(v) });
  };
  push('Run id', run.id);
  push('Status', run.status);
  push('Invocation source', run.invocationSource);
  push('Trigger detail', run.triggerDetail);
  push('Started', run.startedAt ? new Date(run.startedAt).toLocaleString('he-IL') : '');
  push('Finished', run.finishedAt ? new Date(run.finishedAt).toLocaleString('he-IL') : '');
  push('Model', run.model);
  push('Provider', run.provider);
  if (typeof run.inputTokens === 'number') push('Input tokens', run.inputTokens.toLocaleString());
  if (typeof run.outputTokens === 'number') push('Output tokens', run.outputTokens.toLocaleString());
  if (typeof run.costCents === 'number')
    push('עלות', `$${(run.costCents / 100).toFixed(2)}`);
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'max-content 1fr',
        gap: '4px 12px',
        fontSize: 11,
        padding: '6px 8px',
        background: 'rgba(0,0,0,0.25)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 6,
      }}
    >
      {fields.map((f) => (
        <React.Fragment key={f.label}>
          <span style={{ color: '#94a3b8' }}>{f.label}</span>
          <span
            style={{
              color: '#e2e8f0',
              fontFamily:
                f.label === 'Run id'
                  ? "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace"
                  : 'inherit',
              fontSize: f.label === 'Run id' ? 10 : 11,
            }}
          >
            {f.value}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

function RunSubLoadingHint({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, color: '#94a3b8', padding: '8px 0' }}>
      {children}
    </div>
  );
}

function RunSubScroll({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        maxHeight: 260,
        overflow: 'auto',
        background: 'rgba(0,0,0,0.25)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 6,
        padding: '4px 8px',
      }}
    >
      {children}
    </div>
  );
}

function RunMetrics({ run }: { run: PaperclipHeartbeatRunSummary }) {
  const rows: { label: string; value: string }[] = [];
  if (run.startedAt)
    rows.push({ label: 'התחיל', value: new Date(run.startedAt).toLocaleString('he-IL') });
  if (run.finishedAt)
    rows.push({ label: 'הסתיים', value: new Date(run.finishedAt).toLocaleString('he-IL') });
  if (run.provider) rows.push({ label: 'Provider', value: run.provider });
  if (typeof run.inputTokens === 'number')
    rows.push({ label: 'Input tokens', value: run.inputTokens.toLocaleString() });
  if (typeof run.outputTokens === 'number')
    rows.push({ label: 'Output tokens', value: run.outputTokens.toLocaleString() });
  if (typeof run.costCents === 'number')
    rows.push({ label: 'עלות', value: `$${(run.costCents / 100).toFixed(2)}` });
  if (rows.length === 0) return null;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
        gap: 6,
        fontSize: 11,
      }}
    >
      {rows.map((r) => (
        <div key={r.label} style={{ display: 'flex', gap: 4 }}>
          <span style={{ color: '#94a3b8' }}>{r.label}:</span>
          <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{r.value}</span>
        </div>
      ))}
    </div>
  );
}

function RunLog({ runId }: { runId: string }) {
  const [log, setLog] = useState<PaperclipRunLogChunk[] | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchRunLog(runId).then((l) => {
      if (cancelled) return;
      setLog(l);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [runId]);
  if (loading) {
    return <div style={{ fontSize: 11, color: '#94a3b8' }}>טוען לוג…</div>;
  }
  if (!log || log.length === 0) {
    return <div style={{ fontSize: 11, color: '#94a3b8' }}>אין לוג זמין.</div>;
  }
  return (
    <div
      style={{
        background: 'rgba(0,0,0,0.4)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 6,
        padding: 8,
        maxHeight: 220,
        overflow: 'auto',
        fontFamily:
          "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 10,
        lineHeight: 1.5,
        color: '#cbd5e1',
        whiteSpace: 'pre-wrap',
      }}
    >
      {log.map((c, i) => (
        <div key={i}>
          <span style={{ color: '#64748b' }}>[{c.stream}]</span> {c.chunk}
        </div>
      ))}
    </div>
  );
}

// ── Dashboard tab ────────────────────────────────────────────────

function DashboardTab({ agent }: { agent: PaperclipAgentDetail }) {
  // Compute direct-reports list by scanning company agents for
  // `reportsTo === agent.id`. One fetch on mount; refreshes on any
  // agent.* activity event.
  const [companyAgents, setCompanyAgents] = useState<PaperclipAgentSummary[]>(
    [],
  );
  const [runs, setRuns] = useState<PaperclipHeartbeatRunSummary[]>([]);
  const [budgetEntry, setBudgetEntry] =
    useState<PaperclipBudgetOverviewEntry | null>(null);
  const [recentIssues, setRecentIssues] = useState<PaperclipIssue[]>([]);

  useEffect(() => {
    let cancelled = false;
    void fetchCompanyAgents().then((a) => {
      if (!cancelled) setCompanyAgents(a);
    });
    void fetchAgentRuns(agent.id, 10).then((r) => {
      if (!cancelled) setRuns(r);
    });
    void fetchBudgetOverview().then((o) => {
      if (cancelled || !o) return;
      const entry =
        o.entries.find(
          (e) => e.scopeType === 'agent' && e.scopeId === agent.id,
        ) ?? null;
      setBudgetEntry(entry);
    });
    // Recent Issues — every issue this agent participated in (assignee,
    // creator, commenter, activity actor). Limit to 10 most-recently
    // touched via client-side sort + slice (the endpoint already caps
    // server-side, this is just defensive ordering).
    void fetchParticipantIssues(agent.id).then((issues) => {
      if (cancelled) return;
      const sorted = [...issues].sort((a, b) =>
        (b.updatedAt ?? b.createdAt ?? '').localeCompare(
          a.updatedAt ?? a.createdAt ?? '',
        ),
      );
      setRecentIssues(sorted.slice(0, 10));
    });
    return () => {
      cancelled = true;
    };
  }, [agent.id]);

  const manager = companyAgents.find((a) => a.id === agent.reportsTo);
  const reports = companyAgents.filter((a) => a.reportsTo === agent.id);
  const recentRun = runs[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: 10,
        }}
      >
        <StatCard label="סטטוס" value={agent.status ?? '—'} />
        <StatCard label="Adapter" value={agent.adapterType ?? '—'} />
        <StatCard label="Model" value={agent.model ?? '—'} />
        <StatCard
          label="ריצות מקבילות מקסימום"
          value={
            agent.maxConcurrentRuns != null
              ? String(agent.maxConcurrentRuns)
              : '—'
          }
        />
      </div>

      {budgetEntry ? (
        <div
          style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 8,
            padding: 10,
          }}
        >
          <div style={{ ...labelStyle, marginBlockEnd: 6 }}>תקציב חודשי</div>
          <BudgetGauge entry={budgetEntry} />
        </div>
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 10,
        }}
      >
        <RelationCard
          label="כפוף ל"
          items={manager ? [manager.name] : []}
          empty="—"
        />
        <RelationCard
          label="כפיפים ישירים"
          items={reports.map((r) => r.name)}
          empty="אין"
        />
      </div>

      {recentRun ? (
        <div
          style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 8,
            padding: 10,
            fontSize: 12,
            color: '#cbd5e1',
          }}
        >
          <div style={{ ...labelStyle, marginBlockEnd: 6 }}>ריצה אחרונה</div>
          <div>
            סטטוס: <strong>{recentRun.status}</strong>
            {recentRun.finishedAt
              ? ` · ${new Date(recentRun.finishedAt).toLocaleString('he-IL')}`
              : ''}
          </div>
        </div>
      ) : null}

      {/* Recent Issues — every issue the agent participated in
          (assignee / commenter / activity actor). Pulled from
          `fetchParticipantIssues` (same endpoint feeding the chat
          panel's forest). Limited to 10 most-recently-touched. */}
      {recentIssues.length > 0 ? (
        <div
          style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 8,
            padding: 10,
          }}
        >
          <div
            style={{
              ...labelStyle,
              marginBlockEnd: 8,
              display: 'flex',
              alignItems: 'baseline',
              gap: 6,
            }}
          >
            <span>Recent Issues</span>
            <span style={{ fontSize: 10, opacity: 0.7 }}>
              ({recentIssues.length})
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {recentIssues.map((iss) => (
              <RecentIssueRow key={iss.id} issue={iss} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RecentIssueRow({ issue }: { issue: PaperclipIssue }) {
  // Status dot color mirrors the chat panel's issue-status palette so
  // the eye reads the two views as related.
  const dotColor =
    issue.status === 'done'
      ? '#22c55e'
      : issue.status === 'in_progress'
        ? '#0ea5e9'
        : issue.status === 'in_review'
          ? '#a855f7'
          : issue.status === 'blocked' || issue.status === 'cancelled'
            ? '#ef4444'
            : '#94a3b8';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 6,
      }}
      title={`${issue.identifier ?? '—'} · ${issue.title}`}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: dotColor,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontSize: 10,
          fontFamily:
            "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
          background: 'rgba(0,0,0,0.35)',
          padding: '1px 5px',
          borderRadius: 3,
          color: '#cbd5e1',
          flexShrink: 0,
        }}
      >
        {issue.identifier ?? '—'}
      </span>
      <span
        style={{
          fontSize: 12,
          color: '#e2e8f0',
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {issue.title}
      </span>
      <span style={{ fontSize: 10, color: '#94a3b8', flexShrink: 0 }}>
        {issue.updatedAt
          ? new Date(issue.updatedAt).toLocaleDateString('he-IL')
          : ''}
      </span>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: 10,
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 8,
      }}
    >
      <div style={{ ...labelStyle, marginBlockEnd: 2 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0' }}>
        {value}
      </div>
    </div>
  );
}

function RelationCard({
  label,
  items,
  empty,
}: {
  label: string;
  items: string[];
  empty: string;
}) {
  return (
    <div
      style={{
        padding: 10,
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 8,
      }}
    >
      <div style={{ ...labelStyle, marginBlockEnd: 6 }}>{label}</div>
      {items.length === 0 ? (
        <div style={{ fontSize: 12, color: '#94a3b8' }}>{empty}</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {items.map((n) => (
            <span
              key={n}
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 999,
                background: 'rgba(99,102,241,0.18)',
                color: '#c7d2fe',
              }}
            >
              {n}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Budget tab ───────────────────────────────────────────────────

function BudgetTab({ agent }: { agent: PaperclipAgentDetail }) {
  const [entry, setEntry] = useState<PaperclipBudgetOverviewEntry | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [monthlyCents, setMonthlyCents] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const o = await fetchBudgetOverview();
    if (!o) {
      setError('לא ניתן לטעון נתוני תקציב.');
      setLoading(false);
      return;
    }
    const found =
      o.entries.find(
        (e) => e.scopeType === 'agent' && e.scopeId === agent.id,
      ) ?? null;
    setEntry(found);
    setMonthlyCents(
      found
        ? String(found.monthlyCents)
        : agent.budgetMonthlyCents != null
          ? String(agent.budgetMonthlyCents)
          : '',
    );
    setError(null);
    setLoading(false);
  }, [agent.id, agent.budgetMonthlyCents]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const submit = async () => {
    const n = Number(monthlyCents);
    if (!Number.isFinite(n) || n < 0) {
      setError('הקלד מספר חיובי בסנט.');
      return;
    }
    setSaving(true);
    const ok = await upsertBudgetPolicy({
      scopeType: 'agent',
      scopeId: agent.id,
      monthlyCents: Math.round(n),
    });
    setSaving(false);
    if (!ok) {
      setError('שמירת התקציב נכשלה.');
      return;
    }
    setError(null);
    setSavedAt(Date.now());
    await reload();
  };

  if (loading) {
    return (
      <div style={{ fontSize: 13, color: '#94a3b8', padding: '20px 0' }}>
        טוען נתוני תקציב…
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {entry ? (
        <div
          style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 8,
            padding: 10,
          }}
        >
          <div style={{ ...labelStyle, marginBlockEnd: 6 }}>שימוש החודש</div>
          <BudgetGauge entry={entry} />
        </div>
      ) : (
        <div
          style={{
            fontSize: 12,
            color: '#94a3b8',
            background: 'rgba(255,255,255,0.04)',
            border: '1px dashed rgba(255,255,255,0.12)',
            borderRadius: 8,
            padding: 12,
          }}
        >
          לא הוגדרה מדיניות תקציב לסוכן הזה. קבע מגבלה חודשית בשדה למטה.
        </div>
      )}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={labelStyle}>תקציב חודשי חדש (בסנט)</span>
        <input
          type="number"
          min={0}
          value={monthlyCents}
          onChange={(e) => setMonthlyCents(e.target.value)}
          disabled={saving}
          style={fieldStyle}
        />
        <span style={{ fontSize: 10, color: '#64748b' }}>
          לדוגמה: 5000 = $50 לחודש
        </span>
      </label>
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
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          justifyContent: 'flex-end',
        }}
      >
        {savedAt && Date.now() - savedAt < 4000 ? (
          <span style={{ fontSize: 11, color: '#86efac' }}>נשמר ✓</span>
        ) : null}
        <button
          type="button"
          onClick={() => void submit()}
          disabled={saving}
          style={{
            ...primaryBtn,
            opacity: saving ? 0.5 : 1,
            cursor: saving ? 'not-allowed' : 'pointer',
          }}
        >
          {saving ? 'שומר…' : 'שמור תקציב'}
        </button>
      </div>
    </div>
  );
}

function BudgetGauge({ entry }: { entry: PaperclipBudgetOverviewEntry }) {
  const cap = Math.max(1, entry.monthlyCents);
  const pct = Math.min(100, Math.round((entry.spentThisMonthCents / cap) * 100));
  const barColor =
    pct >= 90 ? '#ef4444' : pct >= 70 ? '#f59e0b' : '#22c55e';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        style={{
          width: '100%',
          height: 10,
          background: 'rgba(0,0,0,0.35)',
          borderRadius: 999,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: barColor,
            transition: 'width 0.25s ease',
          }}
        />
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 11,
          color: '#cbd5e1',
        }}
      >
        <span>
          ${(entry.spentThisMonthCents / 100).toFixed(2)} / ${(entry.monthlyCents / 100).toFixed(2)}
        </span>
        <span style={{ color: pct >= 90 ? '#fecaca' : '#94a3b8' }}>
          {pct}% · {entry.status}
        </span>
      </div>
    </div>
  );
}

// ── Placeholder for tabs implemented in later phases ─────────────

function ComingSoon({ tab }: { tab: AgentMgmtTab }) {
  return (
    <div
      style={{
        fontSize: 13,
        color: '#94a3b8',
        padding: '40px 20px',
        textAlign: 'center',
        background: 'rgba(255,255,255,0.04)',
        border: '1px dashed rgba(255,255,255,0.12)',
        borderRadius: 8,
      }}
    >
      <div style={{ fontSize: 20, marginBlockEnd: 6 }}>🚧</div>
      לשונית "{TAB_LABELS[tab]}" — בקרוב.
    </div>
  );
}

// Re-export the secondary button style for callers that need it.
export { secondaryBtn };
