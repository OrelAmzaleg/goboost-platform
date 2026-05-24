import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createIssue,
  fetchAgentById,
  fetchCompanyAgents,
  fetchHeartbeatRun,
  fetchIssueApprovals,
  fetchIssueAttachments,
  fetchIssueComments,
  fetchIssueThreadInteractions,
  getAgentName,
  numericIdForAgentUuid,
  postIssueComment,
  subscribeActivity,
  subscribeHeartbeatEvents,
  updateIssueAssignee,
  uploadIssueAttachment,
  uuidForNumericAgentId,
  type PaperclipAgentSummary,
  type PaperclipApproval,
  type PaperclipAttachment,
  type PaperclipComment,
  type PaperclipHeartbeatEvent,
  type PaperclipIssue,
  type PaperclipIssueWorkMode,
  type PaperclipThreadInteraction,
} from '../paperclipApi.js';
import type { BookmarkScope } from '../bookmarks.js';
import {
  buildAgentForest,
  findNodeInForest,
  type IssueTreeNode,
} from '../paperclipTree.js';
import { validateAttachmentSize } from './attachmentHelpers.js';
import { statusColor } from './issuePresentation.js';
import { IssueTreePicker } from './IssueTreePicker.js';
import {
  newLocalFileId,
  PendingFileChip,
  type PendingFile,
} from './PendingFileChip.js';
import { ApprovalCard } from './ApprovalCard.js';
import { AttachmentChip } from './AttachmentChip.js';
import { DebriefAccordion, isDebriefComment } from './DebriefAccordion.js';
import { InteractionCard } from './InteractionCard.js';
import { aggregateRuns } from './LiveRunCard.js';
import { MarkdownText } from './MarkdownText.js';
import { RunsAccordion } from './RunsAccordion.js';
import { SystemNoticeCard } from './SystemNoticeCard.js';
import { TasksPanel } from './TasksPanel.js';
import {
  TIMELINE_TICK_ACTIONS,
  TimelineTick,
  type TimelineTickEvent,
} from './TimelineTick.js';

/**
 * GoBoost WhatsApp Chat Panel.
 *
 * Iteration 2.B.1 — basic chat with selected agent's most-recent issue.
 * Iteration 2.B.2.A — UX polish: collapsible, font scale, font family,
 *   minimal icon-only controls in the header.
 *
 * Layered in 2.B.2.B/.C/.D (separate sub-iterations):
 *   - Session navigator (multi-issue picker)
 *   - Message type separation (system events tab)
 *   - Tasks Panel (issue tree + criteria)
 */
export interface WhatsAppPanelProps {
  /** Pixel-agents numeric id of the selected agent, or null when none. */
  selectedAgentId: number | null;
  /** Display name of the selected agent (from useExtensionMessages). */
  selectedAgentName?: string | null;
  /** Active project-bookmark scope — filters the agent's issue forest. */
  activeScope: BookmarkScope;
  /** Pin the current chat issue as a new issue-scope bookmark. */
  onPinIssue: (issue: PaperclipIssue) => void;
}

// ── User preferences (persisted in localStorage) ────────────────────────────

const LS_COLLAPSED = 'goboost.panel.collapsed';
const LS_FONT_SCALE = 'goboost.panel.fontScale';

// Font scale levels — 7 steps for fine-grained control, including a smaller
// option (0.7) per user request. Center = 1.0.
const FONT_SCALES = [0.7, 0.85, 1.0, 1.15, 1.3, 1.5, 1.7] as const;
const DEFAULT_FONT_SCALE = 1.0;

// Single font family — Heebo. The earlier multi-font cycler was removed:
// in practice Heebo covers every legibility case and the toggle didn't
// add operational value.
const PANEL_FONT_STACK = "'Heebo', system-ui, -apple-system, sans-serif";

function readBoolPref(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return raw === '1';
  } catch {
    return fallback;
  }
}
function readScalePref(): number {
  try {
    const raw = localStorage.getItem(LS_FONT_SCALE);
    const n = raw == null ? NaN : Number.parseFloat(raw);
    return FONT_SCALES.includes(n as (typeof FONT_SCALES)[number])
      ? n
      : DEFAULT_FONT_SCALE;
  } catch {
    return DEFAULT_FONT_SCALE;
  }
}
// ── Helpers ─────────────────────────────────────────────────────────────────

// Bubble classification for the chat timeline.
//
// `system_notice` is its own kind — it short-circuits all other tests and
// triggers the rich alert card (SystemNoticeCard). The check is BEFORE the
// agent/user logic so we don't misclassify an agent-authored notice as a
// regular agent bubble just because the run that emitted it had an agentId.
//
// `system_legacy` is the fallback for `authorType === 'system'` comments
// without a `presentation.kind` field — older Paperclip rows from before
// the presentation contract existed. Rendered as the small centered pill.
//
// `agent` / `human` are the two dialog bubble variants.
interface BubbleAuthor {
  type: 'human' | 'agent' | 'system_notice' | 'system_legacy';
  name: string;
}

function authorFor(
  comment: PaperclipComment,
  /**
   * True when a fetched heartbeat run reported it *produced* this
   * comment (via `issueCommentSatisfiedByCommentId`). Definitive: the
   * comment is agent content regardless of what `authorType` says.
   */
  isAgentProduced: boolean,
  /**
   * The name to render on an agent bubble. The CALLER resolves this
   * per-comment (via `authorAgentId` or a `createdByRunId` lookup) so a
   * multi-agent thread shows each bubble attributed to its actual author
   * instead of all collapsing onto the chat-selected agent.
   */
  resolvedAgentName: string,
): BubbleAuthor {
  // 1. Explicit system notice — strongest signal. Render rich card.
  if (
    comment.authorType === 'system' &&
    comment.presentation?.kind === 'system_notice'
  ) {
    return { type: 'system_notice', name: 'מערכת' };
  }
  // 2. Definitive agent signals — `authorAgentId` set, a fetched run
  //    confirmed this comment as its output, or `authorType === 'agent'`.
  //    These override everything else.
  if (
    comment.authorAgentId ||
    isAgentProduced ||
    comment.authorType === 'agent'
  ) {
    return { type: 'agent', name: resolvedAgentName };
  }
  // 3. Real user dialogue with NO run association — definitely a human
  //    typed it (no heartbeat ever touched this comment).
  if (
    (comment.authorUserId || comment.authorType === 'user') &&
    !comment.createdByRunId
  ) {
    return { type: 'human', name: 'אני' };
  }
  // 4. Has a run id — default to agent. In local_trusted mode
  //    agent-produced replies arrive as `authorType: 'user'` +
  //    `createdByRunId` because no agent JWT is injected. Treating these
  //    as agent by default matches the original good behavior; the rare
  //    real-user wake-trigger case is corrected when the
  //    `issueCommentSatisfiedByCommentId` back-fill confirms a different
  //    comment was the run's actual output.
  if (comment.createdByRunId) {
    return { type: 'agent', name: resolvedAgentName };
  }
  // 5. Fallback user.
  if (comment.authorUserId || comment.authorType === 'user') {
    return { type: 'human', name: 'אני' };
  }
  // 6. Legacy system row (no presentation contract). Compact pill.
  return { type: 'system_legacy', name: 'מערכת' };
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

// `statusColor` / `statusLabel` now live in ./issuePresentation.ts —
// shared with TasksPanel and the issue-tree picker.

// Header icon button — small, minimal, white-on-purple-gradient.
function IconButton({
  title,
  onClick,
  children,
  disabled,
  active,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  /** When true, render in a depressed/highlighted state — useful for toggles. */
  active?: boolean;
}) {
  const restingBg = active ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.12)';
  const hoverBg = active ? 'rgba(255,255,255,0.32)' : 'rgba(255,255,255,0.22)';
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 28,
        height: 28,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: restingBg,
        color: '#fff',
        border: 'none',
        borderRadius: 7,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        fontFamily: 'inherit',
        fontSize: 13,
        fontWeight: 700,
        lineHeight: 1,
        transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => {
        if (!disabled) (e.currentTarget as HTMLButtonElement).style.background = hoverBg;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = restingBg;
      }}
    >
      {children}
    </button>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export function WhatsAppPanel({
  selectedAgentId,
  selectedAgentName,
  activeScope,
  onPinIssue,
}: WhatsAppPanelProps) {
  // Chat state.
  //
  // The active `issue` is the single source of truth for what the chat
  // shows. The focused agent (`selectedAgentId` prop) only selects WHICH
  // forest of issue-trees to display — `forest`. Navigating to an issue
  // owned by a different agent re-homes the office (see `onSelectNode`),
  // so the focused agent always equals the perspective.
  const [issue, setIssue] = useState<PaperclipIssue | null>(null);
  const [forest, setForest] = useState<IssueTreeNode[]>([]);
  const [forestLoading, setForestLoading] = useState(false);
  // When navigating cross-agent, the office re-homes (selectedAgentId
  // changes) and the forest rebuilds. This holds the issue id to select
  // once that rebuild lands, instead of the default lit-issue pick.
  const [pendingIssueTarget, setPendingIssueTarget] = useState<string | null>(
    null,
  );
  const [comments, setComments] = useState<PaperclipComment[]>([]);
  // 2.B.4 / 2.B.7 — interactions + attachments per issue.
  const [interactions, setInteractions] = useState<PaperclipThreadInteraction[]>([]);
  const [attachments, setAttachments] = useState<PaperclipAttachment[]>([]);
  // 2.B.4 follow-up — approvals are surfaced inline in the chat flow
  // (not just in the Tasks Panel) so the operator can act on them
  // without leaving the conversation.
  const [approvals, setApprovals] = useState<PaperclipApproval[]>([]);
  // 2.B.5 — timeline ticks. Activity rows that match TIMELINE_TICK_ACTIONS
  // for the active issue, captured live from subscribeActivity. Bootstrap-
  // wise we start empty (no historical activity endpoint) and grow as
  // events arrive — acceptable since these are low-noise drift events
  // that the user catches in real time anyway.
  const [ticks, setTicks] = useState<TimelineTickEvent[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  // Assignee picker (per design discussion 2026-05): chip next to the
  // composer that shows the active Issue's current assignee. Default
  // matches whichever agent is currently assigned on the Issue. Picking
  // a different agent calls PATCH /issues/:id with `{assigneeAgentId}` —
  // Paperclip then logs `issue.assignee_changed` and wakes up the new
  // assignee. The previous assignee stops getting wake-ups on this Issue.
  const [companyAgents, setCompanyAgents] = useState<PaperclipAgentSummary[]>([]);
  const [assigneePickerOpen, setAssigneePickerOpen] = useState(false);
  // Pending reassignment — the picker no longer fires `updateIssueAssignee`
  // on selection. Instead, it stages the target here; the actual PATCH
  // rides with the NEXT comment the operator sends (the message is the
  // context for the handoff). Two-stage confirm:
  //   • `pendingReassignAgentId` set, `pendingReassignConfirmed` false →
  //     the user picked a different agent; the banner asks for approval.
  //   • both set → the reassignment is armed and will be sent with the
  //     next message.
  const [pendingReassignAgentId, setPendingReassignAgentId] = useState<
    string | null
  >(null);
  const [pendingReassignConfirmed, setPendingReassignConfirmed] =
    useState(false);
  const [reassigning, setReassigning] = useState(false);
  const assigneePickerWrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!assigneePickerOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (
        assigneePickerWrapRef.current &&
        target &&
        !assigneePickerWrapRef.current.contains(target)
      ) {
        setAssigneePickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [assigneePickerOpen]);
  // Load the full agent roster for the picker. We re-attempt whenever the
  // active issue changes because `fetchCompanyAgents` depends on
  // `moduleCompanyId` being populated by startPaperclipApi — which races
  // against this component mounting on a cold start. By the time an issue
  // is in focus, the WS handshake has long completed and the company id
  // is definitely set. The condition `companyAgents.length === 0` keeps
  // us from refetching on every issue switch when we already have data.
  useEffect(() => {
    if (companyAgents.length > 0 || !issue) return;
    let cancelled = false;
    void fetchCompanyAgents().then((agents) => {
      if (!cancelled) setCompanyAgents(agents);
    });
    return () => {
      cancelled = true;
    };
  }, [issue, companyAgents.length]);
  // `agentPaused` state declared here (early) so the JSX header can
  // reference it; the effect that populates it lives AFTER agentUuid
  // is declared (lower in the file) to avoid a TDZ ReferenceError.
  const [agentPaused, setAgentPaused] = useState(false);

  // (Goals fetch removed — the header chip that consumed it was
  // dropped in Session 1 follow-up; the standalone GoalsModal manages
  // its own fetching.)
  // Picking an agent STAGES the reassignment instead of firing it
  // immediately. The user then approves the staged change, and the
  // actual PATCH rides with the next message they send.
  const onChangeAssignee = useCallback(
    (next: PaperclipAgentSummary) => {
      if (!issue) return;
      setAssigneePickerOpen(false);
      // Picking the current assignee clears any pending stage.
      if (next.id === issue.assigneeAgentId) {
        setPendingReassignAgentId(null);
        setPendingReassignConfirmed(false);
        return;
      }
      // Different agent — stage it; await operator approval.
      setPendingReassignAgentId(next.id);
      setPendingReassignConfirmed(false);
    },
    [issue],
  );

  // Cancel any staged reassignment.
  const cancelPendingReassign = useCallback(() => {
    setPendingReassignAgentId(null);
    setPendingReassignConfirmed(false);
  }, []);
  const confirmPendingReassign = useCallback(() => {
    setPendingReassignConfirmed(true);
  }, []);
  // Clear the staged reassignment whenever the active issue changes —
  // the staged change was scoped to that conversation.
  useEffect(() => {
    setPendingReassignAgentId(null);
    setPendingReassignConfirmed(false);
  }, [issue?.id]);

  // UX preferences (persisted)
  const [collapsed, setCollapsed] = useState(() => readBoolPref(LS_COLLAPSED, false));
  const [fontScale, setFontScale] = useState<number>(() => readScalePref());

  // Tasks Panel (2.B.2.D) — drawer that slides in next to the chat panel
  // showing the issue tree + steps + criteria for the active issue.
  const [tasksOpen, setTasksOpen] = useState(false);
  const onToggleTasks = useCallback(() => setTasksOpen((o) => !o), []);

  // Ephemeral "thinking" feed (2.B.2.E rework of 2.B.2.C) — heartbeat run
  // events arrive from the WS and represent the agent's internal lifecycle
  // ("inner voice"). Rather than persistent bubbles in a separate tab,
  // these are rendered as a single transient strip above the input —
  // showing only the LATEST event, swapping in place — exactly like a
  // "Thinking…" indicator in Claude Code. We keep a small ring of recent
  // ones in state so a brief hover or scroll-back can reveal context.
  const [heartbeatEvents, setHeartbeatEvents] = useState<PaperclipHeartbeatEvent[]>([]);

  // Clear the feed on context switch.
  useEffect(() => {
    setHeartbeatEvents([]);
  }, [selectedAgentId, issue?.id]);

  // The subscription + timeline merge depend on `agentUuid`, which is
  // declared just below as a useMemo over selectedAgentId. We can't
  // forward-reference `agentUuid` in this block, so the actual
  // subscribe useEffect and the timeline useMemo live AFTER agentUuid.

  // Issue-tree picker — dropdown showing the focused agent's issue
  // forest. Closes on outside-click or when a node is selected.
  // The `onSelectNode` handler is declared lower (it needs `agentUuid`).
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerWrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (pickerWrapRef.current && target && !pickerWrapRef.current.contains(target)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pickerOpen]);

  // "+ שיחה חדשה" — transparent flow per user spec (2.B.2.E #1): visible
  // only when an agent is selected; click immediately creates a fresh
  // issue assigned to that agent and switches the chat thread to it.
  // No modal, no fields — the operator's mental model is "start a new
  // conversation", not "fill an issue form". Title is auto-generated;
  // can be edited later in Paperclip's classic UI if needed.
  // onNewConversation is declared LOWER — after agentUuid/agentName,
  // which are computed in the agent-resolution block below. Keeping it
  // up here would forward-reference and trip TS source-order checks.
  const [creatingConversation, setCreatingConversation] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(LS_COLLAPSED, collapsed ? '1' : '0'); } catch {}
  }, [collapsed]);
  useEffect(() => {
    try { localStorage.setItem(LS_FONT_SCALE, String(fontScale)); } catch {}
  }, [fontScale]);

  // Convenience size function — all measured-text sizes pass through this so
  // the scale control applies uniformly.
  const size = useCallback((base: number) => Math.round(base * fontScale), [fontScale]);

  const scaleIndex = FONT_SCALES.indexOf(fontScale as (typeof FONT_SCALES)[number]);
  const canScaleDown = scaleIndex > 0;
  const canScaleUp = scaleIndex >= 0 && scaleIndex < FONT_SCALES.length - 1;
  const onScaleDown = useCallback(() => {
    const i = FONT_SCALES.indexOf(fontScale as (typeof FONT_SCALES)[number]);
    if (i > 0) setFontScale(FONT_SCALES[i - 1]);
  }, [fontScale]);
  const onScaleUp = useCallback(() => {
    const i = FONT_SCALES.indexOf(fontScale as (typeof FONT_SCALES)[number]);
    if (i >= 0 && i < FONT_SCALES.length - 1) setFontScale(FONT_SCALES[i + 1]);
  }, [fontScale]);
  const onToggleCollapsed = useCallback(() => setCollapsed((c) => !c), []);

  const agentName = selectedAgentName ?? 'סוכן';
  // Name shown on the assignee chip — falls back to the agent the user
  // clicked into the chat with, since on a fresh Issue the assignee
  // typically matches that anyway.
  const currentAssigneeName =
    (issue?.assigneeAgentId && getAgentName(issue.assigneeAgentId)) ?? agentName;
  const agentInitial = useMemo(() => {
    const trimmed = agentName.trim();
    return trimmed.length > 0 ? trimmed.charAt(0) : '?';
  }, [agentName]);

  const agentUuid = useMemo(
    () => (selectedAgentId == null ? null : uuidForNumericAgentId(selectedAgentId)),
    [selectedAgentId],
  );

  // Track the selected agent's paused state so the header can render
  // a "מושהה" pill. Placed AFTER `agentUuid` is declared (TDZ-safe:
  // the deps array `[agentUuid]` runs synchronously during render and
  // would throw if the binding hadn't been initialized yet).
  useEffect(() => {
    if (!agentUuid) {
      setAgentPaused(false);
      return;
    }
    let cancelled = false;
    const load = () => {
      void fetchAgentById(agentUuid).then((a) => {
        if (!cancelled) setAgentPaused(a?.status === 'paused');
      });
    };
    load();
    const unsub = subscribeActivity((payload) => {
      const et = String(payload.entityType ?? '');
      const eid = String(payload.entityId ?? '');
      if (et !== 'agent' || eid !== agentUuid) return;
      if (!cancelled) load();
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [agentUuid]);

  // Rebuild the issue forest for the focused agent, scoped by the active
  // project bookmark. Used by the load effect, the live-activity handler,
  // and after creating a new issue.
  const refreshForest = useCallback(async () => {
    if (!agentUuid) {
      setForest([]);
      return;
    }
    setForestLoading(true);
    const next = await buildAgentForest(agentUuid, activeScope);
    setForest(next);
    setForestLoading(false);
  }, [agentUuid, activeScope]);

  // Navigate to an issue node. Two paths:
  //   • the node is owned by the focused agent (or unassigned) → just
  //     set it as the active issue.
  //   • the node is owned by a DIFFERENT agent → re-home the visual
  //     office to that owner (dispatch `agentSelected`), and stash the
  //     issue id in `pendingIssueTarget` so the forest rebuild that
  //     follows selects it instead of the default.
  const onSelectNode = useCallback(
    (target: PaperclipIssue) => {
      setPickerOpen(false);
      const ownerUuid = target.assigneeAgentId;
      if (ownerUuid && ownerUuid !== agentUuid) {
        const ownerNumericId = numericIdForAgentUuid(ownerUuid);
        if (ownerNumericId != null) {
          setPendingIssueTarget(target.id);
          // Re-home the office — flows back as a new `selectedAgentId`.
          window.dispatchEvent(
            new MessageEvent('message', {
              data: { type: 'agentSelected', id: ownerNumericId },
            }),
          );
          return;
        }
      }
      // Same-owner or unassigned — open in place.
      setIssue(target);
    },
    [agentUuid],
  );

  // Total node count across the forest — shown on the picker chip.
  const forestNodeCount = useMemo(() => {
    let n = 0;
    const walk = (node: IssueTreeNode) => {
      n += 1;
      for (const c of node.children) walk(c);
    };
    for (const root of forest) walk(root);
    return n;
  }, [forest]);

  // "+ שיחה חדשה" — declared HERE because it depends on agentUuid/agentName.
  //
  // UX (per design discussion 2026-05): clicking the button does NOT create
  // an Issue immediately. It opens a small inline form with two fields:
  // title (required) and description (optional). On submit we create the
  // Issue assigned to the active agent and switch the thread.
  //
  // Why this matters: an Issue in Paperclip = a unit of work. Auto-titling
  // every conversation as "שיחה · {agent} · {timestamp}" produces a flat
  // graph of meaningless "task" rows — operator can't find anything later.
  // Making the user name the conversation up-front forces a one-line
  // summary that doubles as the task's purpose.
  const [newFormOpen, setNewFormOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  // Status + priority match Paperclip's "New issue" composer. We expose
  // the common set; uncommon values (e.g. custom status enums) require
  // editing in Paperclip's classic UI.
  const [newStatus, setNewStatus] = useState<string>('todo');
  const [newPriority, setNewPriority] = useState<string>('medium');
  // Issue work mode — Paperclip's "standard" vs "planning" distinction.
  // Default standard so the form match's backend's default; toggling to
  // planning sends an explicit workMode in the create payload.
  const [newWorkMode, setNewWorkMode] = useState<PaperclipIssueWorkMode>('standard');
  // Files staged for upload as part of the new issue. Each entry is a
  // PendingFile (local id + file + uploading/error flags). On submit we
  // create the issue first, then upload each file scoped to it.
  const [newFiles, setNewFiles] = useState<PendingFile[]>([]);
  // Files staged in the composer for the *next* comment. Sent after the
  // comment POST returns so we can bind each attachment to its
  // issueCommentId — Paperclip then renders them inline under the bubble.
  const [composerFiles, setComposerFiles] = useState<PendingFile[]>([]);
  const closeNewForm = useCallback(() => {
    setNewFormOpen(false);
    setNewTitle('');
    setNewDescription('');
    setNewStatus('todo');
    setNewPriority('medium');
    setNewWorkMode('standard');
    setNewFiles([]);
  }, []);
  const onOpenNewForm = useCallback(() => {
    setNewFormOpen(true);
    setNewTitle('');
    setNewDescription('');
    setNewStatus('todo');
    setNewPriority('medium');
    setNewWorkMode('standard');
    setNewFiles([]);
  }, []);

  // Generic file-staging helper used by both the new-conversation form
  // and the composer drop zones. Runs client-side size validation and
  // surfaces a per-chip error rather than blocking the whole add.
  const stageFiles = useCallback(
    (
      setter: React.Dispatch<React.SetStateAction<PendingFile[]>>,
      files: FileList | File[] | null | undefined,
    ) => {
      if (!files) return;
      const arr = Array.from(files);
      if (arr.length === 0) return;
      const staged: PendingFile[] = arr.map((file) => {
        const check = validateAttachmentSize(file);
        return {
          localId: newLocalFileId(),
          file,
          error: check.ok ? null : check.error ?? 'קובץ לא תקין',
          uploading: false,
        };
      });
      setter((prev) => [...prev, ...staged]);
    },
    [],
  );

  const onSubmitNewConversation = useCallback(async () => {
    if (!agentUuid || creatingConversation) return;
    const trimmedTitle = newTitle.trim();
    if (!trimmedTitle) return;
    // Block submit if any staged file has a client-side error.
    if (newFiles.some((f) => f.error != null)) return;
    setCreatingConversation(true);
    try {
      const created = await createIssue({
        title: trimmedTitle,
        description: newDescription.trim(),
        assigneeAgentId: agentUuid,
        status: newStatus,
        priority: newPriority,
        // Only send workMode when the user picked planning; otherwise
        // let the server fall back to its own default ("standard").
        ...(newWorkMode !== 'standard' ? { workMode: newWorkMode } : {}),
      });
      if (!created) return;

      // Upload staged files in parallel. Failures don't abort the issue
      // creation — the issue is already on the server. We mark individual
      // chips with errors so the user can retry from there if they care.
      if (newFiles.length > 0) {
        setNewFiles((prev) =>
          prev.map((f) => ({ ...f, uploading: f.error == null })),
        );
        const results = await Promise.all(
          newFiles.map(async (pf) => {
            if (pf.error != null) return { pf, ok: false } as const;
            const att = await uploadIssueAttachment(created.id, pf.file);
            return { pf, ok: att != null } as const;
          }),
        );
        const failed = results.filter((r) => !r.ok);
        if (failed.length > 0) {
          // Persist the form open so the user sees the errors.
          setNewFiles((prev) =>
            prev.map((f) => {
              const failure = results.find((r) => r.pf.localId === f.localId);
              if (failure && !failure.ok && f.error == null) {
                return { ...f, uploading: false, error: 'העלאה נכשלה. נסה שוב.' };
              }
              return { ...f, uploading: false };
            }),
          );
          // Still switch to the new issue — the dialogue can continue
          // while the user decides what to do with the failed uploads.
          setIssue(created);
          void refreshForest();
          return;
        }
      }

      setIssue(created);
      setPickerOpen(false);
      closeNewForm();
      // Pull the new root issue into the forest.
      void refreshForest();
    } finally {
      setCreatingConversation(false);
    }
  }, [
    agentUuid,
    newTitle,
    newDescription,
    newStatus,
    newPriority,
    newWorkMode,
    newFiles,
    creatingConversation,
    closeNewForm,
    refreshForest,
  ]);

  // Subscribe to heartbeat events whenever there's an agent in focus.
  // Declared here (not next to setHeartbeatEvents above) because it
  // needs `agentUuid` which is computed just above. We cap the ring at
  // 30 events to avoid unbounded growth — the "thinking" indicator only
  // shows the most recent one anyway.
  useEffect(() => {
    if (!agentUuid) return;
    // Accept heartbeat events for either:
    //   • the agent the user clicked into the chat with, OR
    //   • the active issue's current assignee.
    // The two diverge when the user reassigns mid-conversation: the
    // chat is still anchored on the clicked agent, but new runs flow
    // from the new assignee. Including both keeps the RunsAccordion
    // populated across handoffs.
    const issueAssigneeId = issue?.assigneeAgentId ?? null;
    const unsubscribe = subscribeHeartbeatEvents((event) => {
      if (event.agentId !== agentUuid && event.agentId !== issueAssigneeId) return;
      setHeartbeatEvents((prev) => {
        const next = [...prev, event];
        return next.length > 30 ? next.slice(next.length - 30) : next;
      });
    });
    return unsubscribe;
  }, [agentUuid, issue?.assigneeAgentId]);

  // Heartbeat events are projected into `liveRuns` via `aggregateRuns`
  // and rendered inside the collapsible RunsAccordion below the chat.
  // The old transient "thinking strip" below the bubbles has been
  // removed — the per-run transient line inside each LiveRunCard now
  // covers that affordance.

  // Merged timeline used by the bubble renderer below.
  //
  // Order:
  //   1. The issue itself, rendered as a SYNTHETIC first bubble. The
  //      issue's description is the opening context of the conversation —
  //      this used to live only in the Tasks Panel, but operators kept
  //      missing it. By prepending it here the chat reads end-to-end:
  //      "what was asked → agent responses → user follow-ups".
  //   2. issue_comments (always).
  //   3. heartbeat events — system "inner voice" — surfaced as compact
  //      centered badges (2c). NOTE: as of 2.B.2.E the persistent tab
  //      toggle has been removed; events render inline as badges in the
  //      regular flow, plus a transient "thinking…" indicator below the
  //      bubble area (4).
  type TimelineItem =
    | { kind: 'origin'; key: string; createdAt: string }
    | {
        kind: 'comment';
        key: string;
        createdAt: string;
        comment: PaperclipComment;
        /** Inline attachments owned by this comment, oldest first. */
        commentAttachments: PaperclipAttachment[];
      }
    | {
        kind: 'interaction';
        key: string;
        createdAt: string;
        interaction: PaperclipThreadInteraction;
      }
    | {
        kind: 'approval';
        key: string;
        createdAt: string;
        approval: PaperclipApproval;
      }
    | {
        kind: 'tick';
        key: string;
        createdAt: string;
        event: TimelineTickEvent;
      }
    | {
        kind: 'attachment';
        key: string;
        createdAt: string;
        attachment: PaperclipAttachment;
      };

  // Aggregate live heartbeat events into LiveRun objects, scoped to the
  // active agent (the subscription is already filtered at write-time).
  const liveRuns = useMemo(() => aggregateRuns(heartbeatEvents), [heartbeatEvents]);

  // Multi-agent attribution: build `runId → agentUuid` from THREE signals
  // (in order of cost / authority):
  //   1. Live heartbeat events — synchronous, free, every event carries
  //      `agentId` per `runId`.
  //   2. Same-comment pairings — any comment that has both
  //      `authorAgentId` AND `createdByRunId` pins the run to its agent.
  //   3. `GET /heartbeat-runs/:runId` — async back-fill for the rest.
  //      Required in local_trusted mode where substantive agent comments
  //      arrive with `authorAgentId: null` (no JWT injected) and their
  //      run id never appears with an explicit agent in #1 or #2.
  //
  // Without #3, the chat had to fall back to the generic "סוכן" label.
  // With it, every comment that came from a heartbeat run gets the real
  // author's name — matching Paperclip's dashboard.
  const [runAgentMap, setRunAgentMap] = useState<Map<string, string>>(
    () => new Map(),
  );
  // commentId → agentUuid for comments where a fetched run reports it
  // *produced* this comment (via `issueCommentSatisfiedByCommentId`).
  // Critical for classification: a comment with `authorType: 'user'`
  // could be either a real user-typed wake trigger OR an agent-emitted
  // reply that Paperclip misattributed due to a missing JWT — only this
  // map distinguishes them.
  const [commentAgentById, setCommentAgentById] = useState<
    Map<string, string>
  >(() => new Map());
  // Effect A: seed from heartbeat events + same-comment pairings (sync).
  useEffect(() => {
    setRunAgentMap((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const ev of heartbeatEvents) {
        if (ev.runId && ev.agentId && !next.has(ev.runId)) {
          next.set(ev.runId, ev.agentId);
          changed = true;
        }
      }
      for (const c of comments) {
        if (
          c.createdByRunId &&
          c.authorAgentId &&
          !next.has(c.createdByRunId)
        ) {
          next.set(c.createdByRunId, c.authorAgentId);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [heartbeatEvents, comments]);
  // Effect B: back-fill anything still missing via the API. One call
  // per unknown runId, in parallel; only fires for genuinely-new ids.
  //
  // NOTE: writes are idempotent (Map.set), and a stale write from a
  // previous render is still correct data — so we deliberately do NOT
  // use a `cancelled` flag here. If the effect re-runs while a fetch is
  // in flight, the cleanup must NOT abort the .then(): doing so would
  // also skip the `inFlightRunsRef.delete()` cleanup, permanently
  // leaking those runIds and stranding their comments on the "סוכן"
  // fallback. (This was the original bug — every WebSocket heartbeat
  // event mutated `runAgentMap`, re-firing this effect and cancelling
  // the back-fill fetches scheduled on mount.)
  const inFlightRunsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const unknown: string[] = [];
    const seen = new Set<string>();
    for (const c of comments) {
      const rid = c.createdByRunId;
      if (!rid) continue;
      if (seen.has(rid)) continue;
      seen.add(rid);
      if (runAgentMap.has(rid) || inFlightRunsRef.current.has(rid)) continue;
      unknown.push(rid);
    }
    if (unknown.length === 0) return;
    for (const rid of unknown) inFlightRunsRef.current.add(rid);
    void Promise.all(unknown.map((rid) => fetchHeartbeatRun(rid))).then(
      (results) => {
        // Always free the inFlight slots first — even on partial failure.
        for (const rid of unknown) inFlightRunsRef.current.delete(rid);
        const runAdditions: [string, string][] = [];
        const commentAdditions: [string, string][] = [];
        for (const run of results) {
          if (!run) continue;
          runAdditions.push([run.id, run.agentId]);
          // Definitive attribution: the run reports which comment it
          // produced. That comment is by `run.agentId` regardless of
          // what `authorType` says.
          if (run.issueCommentSatisfiedByCommentId) {
            commentAdditions.push([
              run.issueCommentSatisfiedByCommentId,
              run.agentId,
            ]);
          }
        }
        if (runAdditions.length > 0) {
          setRunAgentMap((prev) => {
            const next = new Map(prev);
            for (const [k, v] of runAdditions) next.set(k, v);
            return next;
          });
        }
        if (commentAdditions.length > 0) {
          setCommentAgentById((prev) => {
            const next = new Map(prev);
            for (const [k, v] of commentAdditions) next.set(k, v);
            return next;
          });
        }
      },
    );
  }, [comments, runAgentMap]);

  // Resolve the display name for a single comment's author. Order:
  //   • `authorAgentId` set → look it up.
  //   • else, infer from `createdByRunId` via the map above.
  //   • else, a generic "סוכן" rather than faking the chat agent.
  const resolveAgentName = useCallback(
    (c: PaperclipComment): string => {
      // Most authoritative: a fetched run reported it produced this
      // comment — that run's agentId IS the author.
      const direct = commentAgentById.get(c.id);
      if (direct) return getAgentName(direct) ?? 'סוכן';
      if (c.authorAgentId) {
        return getAgentName(c.authorAgentId) ?? 'סוכן';
      }
      if (c.createdByRunId) {
        const inferred = runAgentMap.get(c.createdByRunId);
        if (inferred) return getAgentName(inferred) ?? 'סוכן';
      }
      return 'סוכן';
    },
    [runAgentMap, commentAgentById],
  );

  // Comments that look like heartbeat self-debriefs (self-echo guards,
  // disposition notes, "exiting cleanly" reports). They're routed to the
  // DebriefAccordion below the chat so they don't drown the dialogue.
  const debriefComments = useMemo(
    () => comments.filter(isDebriefComment),
    [comments],
  );

  const timeline = useMemo<TimelineItem[]>(() => {
    // While the operator switches between agents/issues, `setIssue(null)`
    // fires *before* the effect that clears comments/interactions/etc.
    // can run. Any descendant that dereferences `issue!.id` during that
    // tick will throw (`Cannot read properties of null (reading 'id')`)
    // and React will tear down the whole panel — which then cleans up
    // App.tsx's WS effect and disconnects Paperclip. Guarding here is
    // the cheapest place to short-circuit the race.
    if (!issue) return [];
    const items: TimelineItem[] = [];
    if (issue.description?.trim() || issue.title) {
      items.push({
        kind: 'origin',
        key: `o:${issue.id}`,
        createdAt: issue.createdAt,
      });
    }
    // Index attachments owned by a comment, so each comment item can carry
    // its inline tail. Standalone attachments (issueCommentId === null) are
    // pushed into the timeline as their own item.
    const byComment = new Map<string, PaperclipAttachment[]>();
    const standaloneAttachments: PaperclipAttachment[] = [];
    for (const a of attachments) {
      if (a.issueCommentId) {
        const list = byComment.get(a.issueCommentId) ?? [];
        list.push(a);
        byComment.set(a.issueCommentId, list);
      } else {
        standaloneAttachments.push(a);
      }
    }
    for (const c of comments) {
      // Heartbeat self-reflection comments (self-echo, disposition,
      // "exiting cleanly" etc.) get routed to the DebriefAccordion
      // instead of cluttering the dialogue stream.
      if (isDebriefComment(c)) continue;
      items.push({
        kind: 'comment',
        key: `c:${c.id}`,
        createdAt: c.createdAt,
        comment: c,
        commentAttachments: byComment.get(c.id) ?? [],
      });
    }
    for (const ix of interactions) {
      items.push({
        kind: 'interaction',
        key: `i:${ix.id}`,
        createdAt: ix.createdAt,
        interaction: ix,
      });
    }
    for (const ap of approvals) {
      items.push({
        kind: 'approval',
        key: `ap:${ap.id}`,
        createdAt: ap.createdAt,
        approval: ap,
      });
    }
    for (const t of ticks) {
      items.push({
        kind: 'tick',
        key: `t:${t.id}`,
        createdAt: t.createdAt,
        event: t,
      });
    }
    // Runs are NOT merged into the timeline anymore — they live in a
    // separate collapsible container at the bottom of the chat (rendered
    // below `timeline.map`). This keeps the message flow uncluttered when
    // the agent is doing a lot of background work.
    for (const a of standaloneAttachments) {
      items.push({
        kind: 'attachment',
        key: `a:${a.id}`,
        createdAt: a.createdAt,
        attachment: a,
      });
    }
    return items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }, [comments, interactions, approvals, ticks, attachments, liveRuns, issue]);

  // Reset state when a different agent is selected. NOTE: `issue` is
  // deliberately NOT cleared here — when a cross-agent navigation
  // re-homes the office, we want the chat to hold its position until
  // the new forest resolves and selects the pending target. Effect A
  // handles the final issue selection.
  useEffect(() => {
    setComments([]);
    setDraft('');
    setErrorText(null);
  }, [selectedAgentId]);

  // Effect A: when the focused agent OR the active project scope changes,
  // rebuild the issue FOREST and choose a default active issue.
  //
  // Default-issue selection order:
  //   1. `pendingIssueTarget` — set by a cross-agent navigation; if the
  //      issue is present in the new forest, select it (and clear the
  //      pending flag).
  //   2. the most-recently-updated LIT issue (agent owns it).
  //   3. the first node in the forest.
  //   4. null — agent has no issues in scope.
  useEffect(() => {
    if (!agentUuid) {
      setForest([]);
      setIssue(null);
      return;
    }
    let cancelled = false;
    setForestLoading(true);
    (async () => {
      const next = await buildAgentForest(agentUuid, activeScope);
      if (cancelled) return;
      setForest(next);
      setForestLoading(false);

      // 1. Pending cross-agent target.
      if (pendingIssueTarget) {
        const hit = findNodeInForest(next, pendingIssueTarget);
        setPendingIssueTarget(null);
        if (hit) {
          setIssue(hit.issue);
          return;
        }
      }
      // 2/3. Most-recent lit issue, else first node.
      const flat = next.flatMap(function collect(n): IssueTreeNode[] {
        return [n, ...n.children.flatMap(collect)];
      });
      const lit = flat
        .filter((n) => n.lit)
        .sort((a, b) => (a.issue.updatedAt < b.issue.updatedAt ? 1 : -1));
      const pick = lit[0] ?? flat[0] ?? null;
      setIssue(pick ? pick.issue : null);
    })();
    return () => {
      cancelled = true;
    };
    // `pendingIssueTarget` intentionally omitted — it is consumed inside
    // and re-running on its change would double-fire the forest build.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentUuid, activeScope]);

  // Effect A2: keep the forest live. When an issue is created, re-parented,
  // moved, or reassigned anywhere in the company, the focused agent's
  // forest may gain/lose a node or flip a lit/off state. Debounce a
  // rebuild so a burst of activity (e.g. a decomposition creating several
  // sub-issues) collapses into one refresh.
  useEffect(() => {
    if (!agentUuid) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeActivity((payload) => {
      const entityType = String(payload.entityType ?? '');
      const action = String(payload.action ?? '');
      if (entityType !== 'issue') return;
      // Ignore noise that doesn't change tree shape or lit/off state —
      // comments/attachments/etc. fire constantly and would rebuild the
      // forest needlessly.
      if (/comment|attachment|document|interaction|approval/i.test(action)) {
        return;
      }
      // Tree-shape / ownership changes only.
      if (!/created|parent|moved|assignee/i.test(action)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void refreshForest();
      }, 800);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [agentUuid, refreshForest]);

  // Effect B: whenever the active issue changes (auto-selected or
  // operator-picked from the session navigator), fetch its comments,
  // interactions, and attachments. Ticks have no historical endpoint —
  // they accumulate live via the activity subscription below.
  useEffect(() => {
    if (!issue) {
      setComments([]);
      setInteractions([]);
      setAttachments([]);
      setApprovals([]);
      setTicks([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setTicks([]); // reset live ticks on issue switch
    (async () => {
      const [c, ix, att, ap] = await Promise.all([
        fetchIssueComments(issue.id),
        fetchIssueThreadInteractions(issue.id),
        fetchIssueAttachments(issue.id),
        fetchIssueApprovals(issue.id),
      ]);
      if (cancelled) return;
      setComments(c);
      setInteractions(ix);
      setAttachments(att);
      setApprovals(ap);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [issue]);

  // Refresh streams on relevant activity events for our current issue.
  // The action vocabulary determines which stream we refetch.
  useEffect(() => {
    if (!issue) return;
    const unsubscribe = subscribeActivity((payload) => {
      const entityType = String(payload.entityType ?? '');
      const entityId = String(payload.entityId ?? '');
      const action = String(payload.action ?? '');
      const issueIdInPayload = String(payload.issueId ?? '');
      const matchesIssue =
        (entityType === 'issue' && entityId === issue.id) ||
        issueIdInPayload === issue.id;

      // Approvals are a special case: when the user approves/rejects in
      // Paperclip's dashboard, the activity fires with
      //   { entityType: "approval", entityId: <approvalId>,
      //     details: { linkedIssueIds: [...] } }
      // i.e. NOT scoped to any single issue — `matchesIssue` would be
      // false. Refetch on any `approval.*` action whose linkedIssueIds
      // contains our active issue id. We cheat slightly and just
      // refetch on every approval action, since the round-trip is
      // cheap and false-positives are silently dropped by setState.
      const isApprovalAction = action.startsWith('approval.');
      if (isApprovalAction) {
        const details = (payload.details ?? {}) as { linkedIssueIds?: unknown };
        const linkedIds = Array.isArray(details.linkedIssueIds)
          ? (details.linkedIssueIds as unknown[])
          : [];
        const linkedHere = linkedIds.includes(issue.id);
        if (linkedHere || linkedIds.length === 0) {
          void fetchIssueApprovals(issue.id).then(setApprovals);
        }
      }

      if (!matchesIssue) return;

      // Comments (existing behavior — kept liberal).
      if (/comment|reply|message/i.test(action)) {
        void fetchIssueComments(issue.id).then(setComments);
      }
      // Interactions — refetch on any thread_interaction_* action.
      if (/thread_interaction/i.test(action)) {
        void fetchIssueThreadInteractions(issue.id).then(setInteractions);
      }
      // Attachments.
      if (/attachment/i.test(action)) {
        void fetchIssueAttachments(issue.id).then(setAttachments);
      }
      // Approval link/unlink — these DO fire against the issue. The
      // generic approval.* block above already handled approval.created
      // /approved/rejected (which fire against the approval entity).
      if (/approval_linked|approval_unlinked/i.test(action)) {
        void fetchIssueApprovals(issue.id).then(setApprovals);
      }
      // Timeline ticks — capture inline (no historical fetch).
      if (TIMELINE_TICK_ACTIONS.has(action)) {
        const createdAt =
          (typeof payload.createdAt === 'string' ? payload.createdAt : null) ??
          new Date().toISOString();
        const activityId =
          typeof payload.id === 'string' || typeof payload.id === 'number'
            ? String(payload.id)
            : `${action}:${createdAt}`;
        setTicks((prev) => {
          if (prev.some((t) => t.id === activityId)) return prev;
          return [
            ...prev,
            {
              id: activityId,
              action,
              createdAt,
              payload: (payload.metadata as Record<string, unknown>) ?? payload,
              actorAgentId:
                typeof payload.actorAgentId === 'string'
                  ? (payload.actorAgentId as string)
                  : null,
              actorUserId:
                typeof payload.actorUserId === 'string'
                  ? (payload.actorUserId as string)
                  : null,
            },
          ];
        });
      }
    });
    return unsubscribe;
  }, [issue]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [comments]);

  const handleSend = useCallback(async () => {
    if (!issue) return;
    const text = draft.trim();
    // A text message is mandatory. Attachments may ride along with a
    // message but cannot be sent on their own — sending bare files
    // would post an empty/placeholder bubble, which the operator
    // explicitly does not want. Files-only goes through the Tasks
    // Panel's "מסמכים מצורפים" uploader instead (no comment, no wake).
    if (!text) return;
    // Block if any staged file has a client-side error (size cap).
    if (composerFiles.some((f) => f.error != null)) return;
    const validFiles = composerFiles.filter((f) => f.error == null);

    setSending(true);
    setErrorText(null);
    const created = await postIssueComment(issue.id, text);
    if (!created) {
      setSending(false);
      setErrorText('שליחת ההודעה נכשלה. ודא ש-Paperclip זמין ונסה שוב.');
      return;
    }
    setDraft('');
    setComments((prev) => [...prev, created]);

    // Upload staged files in parallel, bound to the comment we just
    // posted. Successful uploads land in `attachments` state — the
    // existing `byComment` index in the timeline merge then renders
    // them as inline chips under the new bubble.
    if (validFiles.length > 0) {
      setComposerFiles((prev) =>
        prev.map((f) => (f.error == null ? { ...f, uploading: true } : f)),
      );
      const results = await Promise.all(
        validFiles.map(async (pf) => {
          const att = await uploadIssueAttachment(issue.id, pf.file, {
            issueCommentId: created.id,
          });
          return { pf, att };
        }),
      );
      const succeededAttachments = results
        .filter((r) => r.att != null)
        .map((r) => r.att!) as PaperclipAttachment[];
      const failedLocalIds = new Set(
        results.filter((r) => r.att == null).map((r) => r.pf.localId),
      );
      const succeededLocalIds = new Set(
        results.filter((r) => r.att != null).map((r) => r.pf.localId),
      );
      if (succeededAttachments.length > 0) {
        setAttachments((prev) => [...prev, ...succeededAttachments]);
      }
      // Drop chips that uploaded; mark this run's failures with an
      // error so the user can retry. Chips that already carried a
      // client-side validation error (size cap) are left as-is.
      setComposerFiles((prev) =>
        prev.flatMap((f) => {
          if (succeededLocalIds.has(f.localId)) return [];
          if (failedLocalIds.has(f.localId)) {
            return [{ ...f, uploading: false, error: 'העלאה נכשלה. נסה שוב.' }];
          }
          return [{ ...f, uploading: false }];
        }),
      );
    }

    // Staged reassignment rides with the just-posted message — that
    // message is the context the new assignee will read on wake.
    if (
      pendingReassignAgentId &&
      pendingReassignConfirmed &&
      pendingReassignAgentId !== issue.assigneeAgentId
    ) {
      setReassigning(true);
      const updated = await updateIssueAssignee(
        issue.id,
        pendingReassignAgentId,
      );
      setReassigning(false);
      if (updated) {
        setIssue(updated);
        setPendingReassignAgentId(null);
        setPendingReassignConfirmed(false);
        // Forest's lit/off refreshes via the issue.assignee_changed
        // activity handler — no manual refresh needed.
      } else {
        setErrorText(
          'ההודעה נשלחה, אבל העברת האחריות נכשלה. אפשר לנסות שוב מהדרופדאון.',
        );
      }
    }
    setSending(false);
  }, [
    issue,
    draft,
    composerFiles,
    pendingReassignAgentId,
    pendingReassignConfirmed,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  const empty = !selectedAgentId || !agentUuid;

  // ── Collapsed strip ────────────────────────────────────────────────────────
  if (collapsed) {
    return (
      <>
      <aside
        dir="rtl"
        className="gb-chat-panel-scope"
        style={
          {
            position: 'fixed',
            // 38 connection banner + 38 bookmarks bar.
            top: 76,
            right: 0,
            bottom: 0,
            width: 44,
            background: 'rgba(15, 23, 42, 0.92)',
            backdropFilter: 'blur(8px)',
            borderInlineStart: '1px solid rgba(255,255,255,0.08)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            paddingBlockStart: 10,
            gap: 10,
            zIndex: 100,
            boxShadow: '-2px 0 12px rgba(0,0,0,0.35)',
            // CSS variable read by `.gb-chat-panel-scope` in index.css — the
            // scope class beats the global `*` rule that would otherwise force
            // every descendant to FS Pixel Sans.
            ['--gb-chat-font' as string]: PANEL_FONT_STACK,
          } as React.CSSProperties
        }
      >
        <button
          type="button"
          onClick={onToggleCollapsed}
          title="הצג פאנל"
          aria-label="הצג פאנל"
          style={{
            width: 28,
            height: 28,
            background: 'linear-gradient(135deg, #4f46e5, #7c3aed)',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontSize: 16,
            fontWeight: 700,
            lineHeight: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          ‹
        </button>
        <div
          title={empty ? 'אין סוכן נבחר' : agentName}
          style={{
            width: 28,
            height: 28,
            background: empty ? '#475569' : '#16a34a',
            color: '#fff',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 13,
            fontWeight: 700,
            border: '1px solid rgba(255,255,255,0.2)',
          }}
        >
          {agentInitial}
        </div>
        {comments.length > 0 && !empty ? (
          <div
            title={`${comments.length} הודעות`}
            style={{
              fontSize: 10,
              color: '#94a3b8',
              fontWeight: 600,
            }}
          >
            {comments.length}
          </div>
        ) : null}
      </aside>
      <TasksPanel
        issue={issue}
        isOpen={tasksOpen}
        onClose={() => setTasksOpen(false)}
        chatCollapsed={true}
        size={size}
        onNavigateToIssue={onSelectNode}
      />
      </>
    );
  }

  // ── Expanded panel ────────────────────────────────────────────────────────
  return (
    <>
    <aside
      dir="rtl"
      className="gb-chat-panel-scope"
      style={
        {
          position: 'fixed',
          // 38 connection banner + 38 bookmarks bar.
          top: 76,
          right: 0,
          bottom: 0,
          width: 420,
          background: 'rgba(15, 23, 42, 0.92)',
          backdropFilter: 'blur(8px)',
          borderInlineStart: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          flexDirection: 'column',
          color: '#e2e8f0',
          fontSize: size(15),
          zIndex: 100,
          boxShadow: '-2px 0 12px rgba(0,0,0,0.35)',
          transition: 'width 0.2s ease-in-out',
          // CSS variable read by `.gb-chat-panel-scope` in index.css.
          ['--gb-chat-font' as string]: PANEL_FONT_STACK,
        } as React.CSSProperties
      }
    >
      {/* Header */}
      <header
        style={{
          padding: '12px 14px',
          background: 'linear-gradient(90deg, #4f46e5 0%, #7c3aed 100%)',
          color: '#fff',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {/* Top row: title + minimal controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              fontWeight: 700,
              fontSize: size(18),
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {empty ? 'בחר סוכן במשרד' : agentName}
            {agentPaused && !empty ? (
              <span
                title="הסוכן מושהה — Heartbeat לא ירוץ עד שיופעל מחדש"
                style={{
                  marginInlineStart: 8,
                  fontSize: size(11),
                  fontWeight: 700,
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: 'rgba(245,158,11,0.32)',
                  color: '#fde68a',
                  verticalAlign: 'middle',
                }}
              >
                ⏸ מושהה
              </span>
            ) : null}
          </div>
          <div style={{ display: 'inline-flex', gap: 4, flexShrink: 0 }}>
            <IconButton
              title="פרטי המשימה"
              onClick={onToggleTasks}
              disabled={empty || !issue}
              active={tasksOpen}
            >
              📋
            </IconButton>
            <IconButton
              title="הקטן גופנים"
              onClick={onScaleDown}
              disabled={!canScaleDown}
            >
              A−
            </IconButton>
            <IconButton
              title="הגדל גופנים"
              onClick={onScaleUp}
              disabled={!canScaleUp}
            >
              A+
            </IconButton>
            <IconButton title="קפל פאנל" onClick={onToggleCollapsed}>
              ›
            </IconButton>
          </div>
        </div>
        {/* Sub-row: session picker chip + "+ שיחה חדשה" button.
            When no agent is selected we show a hint. Otherwise the chip
            (if there's an active issue) and the new-conversation button
            sit side by side; the button is the operator's one-click way
            to start a fresh chat with the selected agent — under the
            hood it creates a new issue and switches the thread. */}
        <div
          style={{ position: 'relative', display: 'flex', gap: 6, alignItems: 'stretch' }}
          ref={pickerWrapRef}
        >
          {empty ? (
            <div style={{ fontSize: size(13), opacity: 0.9, flex: 1 }}>
              לחץ על דמות במשרד כדי לפתוח שיחה
            </div>
          ) : (
            <>
              {issue ? (
                <button
                  type="button"
                  onClick={() => setPickerOpen((o) => !o)}
                  title={`${issue.identifier ?? '—'} · ${issue.title}`}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                padding: '6px 10px',
                background: 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 8,
                color: '#fff',
                cursor: 'pointer',
                textAlign: 'start',
                fontFamily: 'inherit',
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  'rgba(255,255,255,0.15)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  'rgba(255,255,255,0.08)';
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: statusColor(issue.status),
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  fontSize: size(12),
                  fontWeight: 700,
                  background: 'rgba(0,0,0,0.25)',
                  padding: '2px 6px',
                  borderRadius: 4,
                  flexShrink: 0,
                  letterSpacing: 0.5,
                }}
              >
                {issue.identifier ?? '—'}
              </span>
              <span
                style={{
                  fontSize: size(13),
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {issue.title}
              </span>
              <span style={{ fontSize: size(11), opacity: 0.7, flexShrink: 0 }}>
                {forestNodeCount > 1
                  ? `${forestNodeCount} ${pickerOpen ? '▲' : '▼'}`
                  : ''}
              </span>
            </button>
              ) : null}
              {/* Goal chip removed (Session 1 follow-up) — operator
                  found it redundant alongside the issues picker. Goal
                  context is available in the GoalsModal (🎯 button in
                  the bookmarks bar) when needed. */}
              {/* 📌 Pin the active issue as a project-bookmark — for an
                  issue that is the parent of a sub-task set. Visible only
                  when an issue is open. */}
              {issue ? (
                <button
                  type="button"
                  onClick={() => onPinIssue(issue)}
                  title="נעץ את המשימה כסימנייה"
                  aria-label="נעץ את המשימה כסימנייה"
                  style={{
                    flexShrink: 0,
                    width: 32,
                    height: 32,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'rgba(255,255,255,0.12)',
                    border: '1px solid rgba(255,255,255,0.18)',
                    borderRadius: 8,
                    color: '#fff',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    fontSize: 15,
                    lineHeight: 1,
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      'rgba(255,255,255,0.22)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      'rgba(255,255,255,0.12)';
                  }}
                >
                  📌
                </button>
              ) : null}
              {/* + שיחה חדשה — icon-only round button with hover tooltip.
                  Click opens the inline title+description form below the
                  header. Green-tinted to match the user-action affordance
                  in the header row. */}
              <button
                type="button"
                onClick={onOpenNewForm}
                disabled={creatingConversation || newFormOpen}
                title={creatingConversation ? 'פותח…' : 'שיחה חדשה'}
                aria-label="פתח שיחה חדשה עם הסוכן"
                style={{
                  flexShrink: 0,
                  width: 32,
                  height: 32,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'rgba(34,197,94,0.22)',
                  border: '1px solid rgba(34,197,94,0.55)',
                  borderRadius: 8,
                  color: '#dcfce7',
                  cursor: creatingConversation ? 'not-allowed' : 'pointer',
                  opacity: creatingConversation ? 0.6 : 1,
                  fontFamily: 'inherit',
                  fontSize: 22,
                  fontWeight: 700,
                  lineHeight: 1,
                  transition: 'background 0.15s, transform 0.1s',
                }}
                onMouseEnter={(e) => {
                  if (!creatingConversation)
                    (e.currentTarget as HTMLButtonElement).style.background =
                      'rgba(34,197,94,0.34)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background =
                    'rgba(34,197,94,0.22)';
                }}
              >
                {creatingConversation ? '…' : '+'}
              </button>
            </>
          )}

          {/* Dropdown: the focused agent's issue FOREST — root issues
              with nested sub-issues. Replaces the old flat list.
              Anchored below the chip. */}
          {pickerOpen ? (
            <div
              style={{
                position: 'absolute',
                top: 'calc(100% + 6px)',
                insetInlineStart: 0,
                insetInlineEnd: 0,
                maxHeight: 380,
                overflowY: 'auto',
                background: '#1e293b',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 10,
                boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
                zIndex: 200,
                color: '#e2e8f0',
              }}
            >
              <IssueTreePicker
                forest={forest}
                loading={forestLoading}
                activeIssueId={issue?.id ?? null}
                size={size}
                onSelect={(node) => onSelectNode(node.issue)}
              />
            </div>
          ) : null}
        </div>
      </header>

      {/* New-conversation inline form (collapsible). Shown above the
          message list when the user clicks "שיחה חדשה" in the header.
          Two fields: title (required) + description (optional). Submit
          creates the Issue and switches the active thread to it. */}
      {newFormOpen && !empty ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={(e) => {
            e.preventDefault();
            stageFiles(setNewFiles, e.dataTransfer.files);
          }}
          style={{
            padding: '12px 14px',
            background: 'rgba(15, 23, 42, 0.85)',
            borderBlockEnd: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div
            style={{
              fontSize: size(11),
              fontWeight: 700,
              letterSpacing: 0.3,
              opacity: 0.8,
              color: '#dcfce7',
            }}
          >
            שיחה חדשה — תן כותרת קצרה ותיאור (אופציונלי)
          </div>
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="כותרת — נושא השיחה או המשימה"
            disabled={creatingConversation}
            style={{
              padding: '8px 10px',
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(255,255,255,0.06)',
              color: '#f1f5f9',
              fontFamily: 'inherit',
              fontSize: size(14),
              outline: 'none',
            }}
            autoFocus
          />
          <textarea
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            placeholder="תיאור — הקשר, רקע, מה מצופה מהסוכן (אופציונלי)"
            disabled={creatingConversation}
            rows={3}
            style={{
              padding: '8px 10px',
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(255,255,255,0.06)',
              color: '#f1f5f9',
              fontFamily: 'inherit',
              fontSize: size(13),
              outline: 'none',
              resize: 'vertical',
              minHeight: 60,
              maxHeight: 200,
            }}
          />
          {/* Compact selectors row — status + priority. Paperclip's
              "New issue" composer has additional fields (project, parent,
              attachments) which we omit for v1; the common case is a
              fresh top-level conversation. */}
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                fontSize: size(11),
                color: '#cbd5e1',
              }}
            >
              <span style={{ opacity: 0.8 }}>סטטוס:</span>
              <select
                value={newStatus}
                onChange={(e) => setNewStatus(e.target.value)}
                disabled={creatingConversation}
                style={{
                  padding: '4px 8px',
                  borderRadius: 6,
                  border: '1px solid rgba(255,255,255,0.12)',
                  background: '#1e293b',
                  color: '#f1f5f9',
                  fontFamily: 'inherit',
                  fontSize: size(11),
                  outline: 'none',
                  colorScheme: 'dark',
                }}
              >
                <option value="backlog" style={{ background: '#1e293b', color: '#f1f5f9' }}>תור</option>
                <option value="todo" style={{ background: '#1e293b', color: '#f1f5f9' }}>לעשות</option>
                <option value="in_progress" style={{ background: '#1e293b', color: '#f1f5f9' }}>בעבודה</option>
                <option value="in_review" style={{ background: '#1e293b', color: '#f1f5f9' }}>בבדיקה</option>
                <option value="done" style={{ background: '#1e293b', color: '#f1f5f9' }}>הושלם</option>
              </select>
            </label>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                fontSize: size(11),
                color: '#cbd5e1',
              }}
            >
              <span style={{ opacity: 0.8 }}>עדיפות:</span>
              <select
                value={newPriority}
                onChange={(e) => setNewPriority(e.target.value)}
                disabled={creatingConversation}
                style={{
                  padding: '4px 8px',
                  borderRadius: 6,
                  border: '1px solid rgba(255,255,255,0.12)',
                  background: '#1e293b',
                  color: '#f1f5f9',
                  fontFamily: 'inherit',
                  fontSize: size(11),
                  outline: 'none',
                  colorScheme: 'dark',
                }}
              >
                <option value="low" style={{ background: '#1e293b', color: '#f1f5f9' }}>נמוכה</option>
                <option value="medium" style={{ background: '#1e293b', color: '#f1f5f9' }}>בינונית</option>
                <option value="high" style={{ background: '#1e293b', color: '#f1f5f9' }}>גבוהה</option>
                <option value="urgent" style={{ background: '#1e293b', color: '#f1f5f9' }}>דחופה</option>
              </select>
            </label>
            {/* Goal picker removed (Session 1.1) — issues inherit goal
                via parent issue. The header chip still displays the
                inherited goal, but composing the link at create-time
                proved redundant in operator review. */}
            <span
              style={{
                fontSize: size(10),
                opacity: 0.55,
                marginInlineStart: 'auto',
              }}
            >
              מוקצה לסוכן: {agentName}
            </span>
          </div>

          {/* Issue work mode — Standard (default executable task) vs.
              Planning (ideation/decomposition unit). Pill toggle. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: size(11),
              color: '#cbd5e1',
            }}
          >
            <span style={{ opacity: 0.8, marginInlineEnd: 4 }}>סוג:</span>
            {(['standard', 'planning'] as PaperclipIssueWorkMode[]).map((mode) => {
              const active = newWorkMode === mode;
              const label = mode === 'planning' ? 'תכנון' : 'רגיל';
              const hint =
                mode === 'planning'
                  ? 'משימת תכנון — הסוכן יפרק/יתכנן, לא יבצע ישירות'
                  : 'משימה רגילה — הסוכן יבצע באופן ישיר';
              return (
                <button
                  key={mode}
                  type="button"
                  title={hint}
                  onClick={() => setNewWorkMode(mode)}
                  disabled={creatingConversation}
                  style={{
                    padding: '4px 12px',
                    borderRadius: 999,
                    border: active
                      ? '1px solid rgba(74,222,128,0.55)'
                      : '1px solid rgba(255,255,255,0.12)',
                    background: active
                      ? 'rgba(34,197,94,0.18)'
                      : 'transparent',
                    color: active ? '#dcfce7' : '#cbd5e1',
                    fontFamily: 'inherit',
                    fontSize: size(11),
                    fontWeight: 700,
                    cursor: creatingConversation ? 'not-allowed' : 'pointer',
                    transition: 'background 0.15s, color 0.15s',
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* File upload zone — paperclip button + chip strip. The
              surrounding form div is itself a drop target so the user
              can drag files anywhere over the panel. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: size(11),
                color: '#cbd5e1',
              }}
            >
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '4px 10px',
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 7,
                  cursor: creatingConversation ? 'not-allowed' : 'pointer',
                  opacity: creatingConversation ? 0.5 : 1,
                  fontSize: size(11),
                  fontWeight: 600,
                }}
                title="צרף קבצים — גם drag-and-drop נתמך לכל אזור הטופס"
              >
                <span aria-hidden style={{ fontSize: size(13) }}>📎</span>
                <span>צרף קבצים</span>
                <input
                  type="file"
                  multiple
                  hidden
                  disabled={creatingConversation}
                  onChange={(e) => {
                    stageFiles(setNewFiles, e.target.files);
                    // Reset so the same file can be re-selected.
                    e.target.value = '';
                  }}
                />
              </label>
              {newFiles.length > 0 ? (
                <span style={{ opacity: 0.6, fontSize: size(10) }}>
                  {newFiles.length} קבצים · אפשר לגרור גם לאזור הטופס
                </span>
              ) : (
                <span style={{ opacity: 0.45, fontSize: size(10) }}>
                  או גרור קבצים לאזור הטופס
                </span>
              )}
            </div>
            {newFiles.length > 0 ? (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 4,
                }}
              >
                {newFiles.map((pf) => (
                  <PendingFileChip
                    key={pf.localId}
                    pending={pf}
                    size={size}
                    onRemove={() =>
                      setNewFiles((prev) =>
                        prev.filter((f) => f.localId !== pf.localId),
                      )
                    }
                    // Retry on the form: rebuild the chip with cleared
                    // error so the next submit will try again. The
                    // actual upload happens at submit time.
                    onRetry={() =>
                      setNewFiles((prev) =>
                        prev.map((f) =>
                          f.localId === pf.localId
                            ? { ...f, error: null }
                            : f,
                        ),
                      )
                    }
                  />
                ))}
              </div>
            ) : null}
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={closeNewForm}
              disabled={creatingConversation}
              style={{
                padding: '6px 12px',
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'transparent',
                color: '#cbd5e1',
                fontSize: size(12),
                fontWeight: 600,
                fontFamily: 'inherit',
                cursor: creatingConversation ? 'not-allowed' : 'pointer',
                opacity: creatingConversation ? 0.6 : 1,
              }}
            >
              ביטול
            </button>
            <button
              type="button"
              onClick={() => void onSubmitNewConversation()}
              disabled={creatingConversation || newTitle.trim().length === 0}
              style={{
                padding: '6px 14px',
                borderRadius: 8,
                border: '1px solid rgba(34,197,94,0.6)',
                background: 'rgba(34,197,94,0.28)',
                color: '#dcfce7',
                fontSize: size(12),
                fontWeight: 700,
                fontFamily: 'inherit',
                cursor:
                  creatingConversation || newTitle.trim().length === 0
                    ? 'not-allowed'
                    : 'pointer',
                opacity:
                  creatingConversation || newTitle.trim().length === 0 ? 0.5 : 1,
              }}
            >
              {creatingConversation ? 'יוצר…' : 'פתח שיחה'}
            </button>
          </div>
        </div>
      ) : null}

      {/* Bubbles */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {empty ? null : loading ? (
          <div
            style={{
              textAlign: 'center',
              color: '#94a3b8',
              fontSize: size(14),
              marginTop: 28,
            }}
          >
            טוען היסטוריה…
          </div>
        ) : timeline.length === 0 ? (
          <div
            style={{
              textAlign: 'center',
              color: '#94a3b8',
              fontSize: size(14),
              marginTop: 28,
              lineHeight: 1.6,
            }}
          >
            {issue
              ? 'אין הודעות עדיין בשיחה הזו. שלח את הראשונה.'
              : 'אין שיחה פעילה. לחץ "+ שיחה חדשה" למעלה כדי להתחיל.'}
          </div>
        ) : (
          timeline.map((item) => {
            // ── Origin bubble: the issue's own title + description, shown
            // as the conversation opener. Side/color matches who created
            // the issue (user → green outgoing, agent → gray incoming). ──
            if (item.kind === 'origin' && issue) {
              const fromUser = !!issue.createdByUserId && !issue.createdByAgentId;
              return (
                <div
                  key={item.key}
                  style={{
                    alignSelf: fromUser ? 'flex-start' : 'flex-end',
                    maxWidth: '85%',
                    background: fromUser ? '#16a34a' : '#cbd5e1',
                    color: fromUser ? '#fff' : '#0f172a',
                    padding: '10px 13px',
                    borderRadius: 12,
                    borderTopRightRadius: fromUser ? 12 : 3,
                    borderTopLeftRadius: fromUser ? 3 : 12,
                    fontSize: size(15),
                    lineHeight: 1.55,
                    boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  <div
                    style={{
                      fontSize: size(11),
                      opacity: 0.75,
                      marginBottom: 4,
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <span
                      style={{
                        background: 'rgba(0,0,0,0.18)',
                        padding: '1px 5px',
                        borderRadius: 3,
                        letterSpacing: 0.4,
                      }}
                    >
                      {issue.identifier ?? '—'}
                    </span>
                    <span>פתיחת השיחה</span>
                  </div>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>{issue.title}</div>
                  {issue.description?.trim() ? (
                    <MarkdownText text={issue.description} />
                  ) : null}
                  <div
                    style={{
                      fontSize: size(11),
                      opacity: 0.6,
                      marginTop: 6,
                      textAlign: 'start',
                    }}
                  >
                    {formatTime(issue.createdAt)}
                  </div>
                </div>
              );
            }
            // ── Interaction card (Stream 2 / Primitive #4). ──
            if (item.kind === 'interaction') {
              return (
                <InteractionCard
                  key={item.key}
                  interaction={item.interaction}
                  issueId={issue!.id}
                  size={size}
                  formatTime={formatTime}
                  onResolved={(next) =>
                    setInteractions((prev) =>
                      prev.map((p) => (p.id === next.id ? next : p)),
                    )
                  }
                />
              );
            }

            // ── Approval card (acts inline; Approve/Reject buttons). ──
            if (item.kind === 'approval') {
              return (
                <ApprovalCard
                  key={item.key}
                  approval={item.approval}
                  size={size}
                  formatTime={formatTime}
                  onResolved={(next) =>
                    setApprovals((prev) =>
                      prev.map((p) => (p.id === next.id ? next : p)),
                    )
                  }
                />
              );
            }

            // ── Timeline tick (Stream 3 / Primitive #5). ──
            if (item.kind === 'tick') {
              return (
                <TimelineTick
                  key={item.key}
                  event={item.event}
                  size={size}
                  formatTime={formatTime}
                />
              );
            }

            // (Live run cards have moved to the collapsible Runs container
            //  rendered below `timeline.map` — they no longer interleave
            //  with comments.)

            // ── Standalone attachment (Stream 5 / Primitive #9). ──
            if (item.kind === 'attachment') {
              return (
                <AttachmentChip
                  key={item.key}
                  attachment={item.attachment}
                  mode="standalone"
                  size={size}
                  formatTime={formatTime}
                />
              );
            }

            if (item.kind !== 'comment') return null;

            const c = item.comment;
            // Multi-agent fidelity: resolve the author's REAL name per
            // comment rather than defaulting to the chat-selected agent.
            // `isAgentProduced` flips user-misattributed agent comments
            // back to agent bubbles once the run back-fill confirms.
            const isAgentProduced = commentAgentById.has(c.id);
            const author = authorFor(c, isAgentProduced, resolveAgentName(c));
            const inlineAttachments = item.commentAttachments;
            const isHuman = author.type === 'human';

            // ── System notice — rich alert card (Primitive #3, Stream 1).
            // Comments with `presentation.kind === "system_notice"` are
            // structured notices the agent (or system) wanted to surface
            // as one coherent block: tone color + title + body + metadata
            // rows. Rendered by SystemNoticeCard. ──
            if (author.type === 'system_notice') {
              return (
                <SystemNoticeCard
                  key={item.key}
                  comment={c}
                  size={size}
                  formatTime={formatTime}
                />
              );
            }

            // ── Legacy system row — small centered pill with hover tooltip.
            // Backwards-compatibility for older Paperclip rows that don't
            // carry the presentation contract. Once the backfill lands all
            // system rows will route through SystemNoticeCard above. ──
            if (author.type === 'system_legacy') {
              return (
                <div
                  key={item.key}
                  title={c.body}
                  style={{
                    alignSelf: 'center',
                    maxWidth: '88%',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    background: 'rgba(71,85,105,0.55)',
                    color: '#e2e8f0',
                    padding: '4px 10px',
                    borderRadius: 999,
                    fontSize: size(11),
                    lineHeight: 1.4,
                    cursor: 'help',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: '50%',
                      background: 'rgba(255,255,255,0.18)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: size(10),
                      fontWeight: 700,
                    }}
                  >
                    ⓘ
                  </span>
                  <span
                    style={{
                      maxWidth: 240,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {c.body}
                  </span>
                  <span
                    style={{
                      fontSize: size(10),
                      opacity: 0.65,
                      marginInlineStart: 4,
                    }}
                  >
                    {formatTime(c.createdAt)}
                  </span>
                </div>
              );
            }

            // ── Regular dialog bubble (human/agent). ──
            return (
              <div
                key={item.key}
                style={{
                  alignSelf: isHuman ? 'flex-start' : 'flex-end',
                  maxWidth: '85%',
                  background: isHuman ? '#16a34a' : '#cbd5e1',
                  color: isHuman ? '#fff' : '#0f172a',
                  padding: '10px 13px',
                  borderRadius: 12,
                  borderTopRightRadius: isHuman ? 12 : 3,
                  borderTopLeftRadius: isHuman ? 3 : 12,
                  fontSize: size(15),
                  lineHeight: 1.55,
                  boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                <div
                  style={{
                    fontSize: size(12),
                    opacity: 0.75,
                    marginBottom: 3,
                    fontWeight: 700,
                  }}
                >
                  {author.name}
                </div>
                <MarkdownText text={c.body} />
                {inlineAttachments.length > 0 ? (
                  <div
                    style={{
                      marginTop: 6,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    {inlineAttachments.map((a) => (
                      <AttachmentChip
                        key={a.id}
                        attachment={a}
                        mode="inline"
                        size={size}
                      />
                    ))}
                  </div>
                ) : null}
                <div
                  style={{
                    fontSize: size(11),
                    opacity: 0.6,
                    marginTop: 6,
                    textAlign: 'start',
                  }}
                >
                  {formatTime(c.createdAt)}
                </div>
              </div>
            );
          })
        )}

        {/* Debrief accordion — collapsible container holding the agent's
            heartbeat self-reflection comments (self-echo, disposition,
            "exiting cleanly", etc). These get filtered out of the main
            timeline above and re-rendered here so the dialogue stays
            clean while the audit trail remains available. */}
        {!empty && debriefComments.length > 0 ? (
          <DebriefAccordion
            comments={debriefComments}
            size={size}
            formatTime={formatTime}
            resolveAgentName={resolveAgentName}
          />
        ) : null}

        {/* Runs accordion — a single collapsible container holding all
            LiveRunCards for the active issue, anchored below the last
            bubble. Collapsed by default; the header shows a summary
            (count + latest event line). Replaces both the timeline-merged
            run cards and the global "thinking strip" that used to live
            below the message list. */}
        {!empty && liveRuns.length > 0 ? (
          <RunsAccordion
            runs={liveRuns}
            size={size}
            formatTime={formatTime}
          />
        ) : null}
      </div>

      {/* Error strip */}
      {errorText ? (
        <div
          style={{
            background: '#7f1d1d',
            color: '#fecaca',
            fontSize: size(14),
            padding: '8px 14px',
          }}
        >
          {errorText}
        </div>
      ) : null}

      {/* Input */}
      <footer
        onDragOver={(e) => {
          if (!issue) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={(e) => {
          if (!issue) return;
          e.preventDefault();
          stageFiles(setComposerFiles, e.dataTransfer.files);
        }}
        style={{
          padding: 12,
          borderBlockStart: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {/* Assignee row — chip showing the active Issue's current assignee.
            Click → dropdown of all company agents. Selecting a different
            agent PATCH-es the Issue (Paperclip then fires assignee_changed
            activity + wakes the new assignee). Default matches the Issue's
            current assigneeAgentId, falling back to the chat-selected
            agent's name. */}
        {issue ? (
          <div
            ref={assigneePickerWrapRef}
            style={{
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: size(11),
            }}
          >
            <span style={{ opacity: 0.7 }}>הקצאה:</span>
            <button
              type="button"
              onClick={() => setAssigneePickerOpen((v) => !v)}
              disabled={reassigning || companyAgents.length === 0}
              title="שנה את הסוכן שמטפל ב-Issue הזה"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '3px 9px',
                background: 'rgba(99,102,241,0.22)',
                border: '1px solid rgba(129,140,248,0.45)',
                borderRadius: 999,
                color: '#e0e7ff',
                fontSize: size(11),
                fontWeight: 700,
                fontFamily: 'inherit',
                cursor:
                  reassigning || companyAgents.length === 0
                    ? 'not-allowed'
                    : 'pointer',
                opacity:
                  reassigning || companyAgents.length === 0 ? 0.6 : 1,
                lineHeight: 1.3,
              }}
            >
              <span aria-hidden>👤</span>
              <span
                style={{
                  maxWidth: 160,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {reassigning ? '…' : currentAssigneeName}
              </span>
              <span style={{ opacity: 0.7 }}>
                {assigneePickerOpen ? '▲' : '▼'}
              </span>
            </button>
            {assigneePickerOpen && companyAgents.length > 0 ? (
              <div
                style={{
                  position: 'absolute',
                  bottom: 'calc(100% + 6px)',
                  insetInlineStart: 0,
                  maxHeight: 240,
                  overflowY: 'auto',
                  background: '#1e293b',
                  border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 10,
                  boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
                  zIndex: 200,
                  padding: 6,
                  minWidth: 220,
                  color: '#e2e8f0',
                }}
              >
                {companyAgents.map((a) => {
                  const active = a.id === issue.assigneeAgentId;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => void onChangeAssignee(a)}
                      title={a.title ?? a.name}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 10px',
                        background: active
                          ? 'rgba(99,102,241,0.25)'
                          : 'transparent',
                        border: active
                          ? '1px solid rgba(129,140,248,0.6)'
                          : '1px solid transparent',
                        borderRadius: 7,
                        color: '#e2e8f0',
                        cursor: 'pointer',
                        textAlign: 'start',
                        fontFamily: 'inherit',
                        marginBlockEnd: 2,
                      }}
                      onMouseEnter={(e) => {
                        if (!active)
                          (e.currentTarget as HTMLButtonElement).style.background =
                            'rgba(255,255,255,0.06)';
                      }}
                      onMouseLeave={(e) => {
                        if (!active)
                          (e.currentTarget as HTMLButtonElement).style.background =
                            'transparent';
                      }}
                    >
                      <span aria-hidden>👤</span>
                      <span
                        style={{
                          fontSize: size(12),
                          fontWeight: 600,
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {a.name}
                      </span>
                      {a.title ? (
                        <span style={{ fontSize: size(10), opacity: 0.6 }}>
                          {a.title}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Pending-reassignment banner.
            Picker selection no longer fires the PATCH immediately — it
            stages the target here. The banner asks for approval; once
            approved, the actual reassignment rides with the next message
            (which is the context the new assignee will read on wake). */}
        {pendingReassignAgentId && issue ? (() => {
          const pendingName =
            getAgentName(pendingReassignAgentId) ?? 'סוכן';
          return (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                padding: '8px 10px',
                background: pendingReassignConfirmed
                  ? 'rgba(34,197,94,0.12)'
                  : 'rgba(245,158,11,0.12)',
                border: pendingReassignConfirmed
                  ? '1px solid rgba(74,222,128,0.5)'
                  : '1px solid rgba(251,191,36,0.5)',
                borderRadius: 8,
                fontSize: size(11),
                color: '#e2e8f0',
              }}
            >
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <span aria-hidden style={{ fontSize: size(13) }}>
                  {pendingReassignConfirmed ? '✓' : '🔁'}
                </span>
                <span style={{ flex: 1, lineHeight: 1.5 }}>
                  {pendingReassignConfirmed ? (
                    <>
                      ההקצאה תוצמד להודעה הבאה — תועבר אל{' '}
                      <strong>{pendingName}</strong>.
                    </>
                  ) : (
                    <>
                      שים לב — אתה מבקש להעביר אחריות למשימה אל{' '}
                      <strong>{pendingName}</strong>.
                    </>
                  )}
                </span>
              </div>
              {!pendingReassignConfirmed ? (
                <div
                  style={{
                    fontSize: size(10),
                    opacity: 0.75,
                    lineHeight: 1.5,
                  }}
                >
                  לאחר השליחה המערכת תעריך את הבקשה לפי ההקשר. אם תזהה
                  שעדיף שהמשימה תישאר אצל{' '}
                  <strong>{currentAssigneeName}</strong> — תוצג לך הודעה
                  בהתאם והאחריות עשויה להישאר אצלו.
                </div>
              ) : null}
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={cancelPendingReassign}
                  disabled={reassigning}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 6,
                    border: '1px solid rgba(255,255,255,0.15)',
                    background: 'transparent',
                    color: '#cbd5e1',
                    cursor: reassigning ? 'not-allowed' : 'pointer',
                    fontFamily: 'inherit',
                    fontSize: size(11),
                    fontWeight: 700,
                  }}
                >
                  בטל
                </button>
                {!pendingReassignConfirmed ? (
                  <button
                    type="button"
                    onClick={confirmPendingReassign}
                    style={{
                      padding: '4px 12px',
                      borderRadius: 6,
                      border: '1px solid rgba(74,222,128,0.55)',
                      background: 'rgba(34,197,94,0.22)',
                      color: '#dcfce7',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      fontSize: size(11),
                      fontWeight: 700,
                    }}
                  >
                    אשר
                  </button>
                ) : null}
              </div>
            </div>
          );
        })() : null}

        {/* Pending-files strip — shown only when files are staged.
            Drag-drop on the footer adds to this list. Each chip can be
            removed or, if marked with an error, retried by clearing
            the error so the next Send tries again. */}
        {composerFiles.length > 0 ? (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 4,
              padding: '4px 0',
            }}
          >
            {composerFiles.map((pf) => (
              <PendingFileChip
                key={pf.localId}
                pending={pf}
                size={size}
                onRemove={() =>
                  setComposerFiles((prev) =>
                    prev.filter((f) => f.localId !== pf.localId),
                  )
                }
                onRetry={() =>
                  setComposerFiles((prev) =>
                    prev.map((f) =>
                      f.localId === pf.localId ? { ...f, error: null } : f,
                    ),
                  )
                }
              />
            ))}
            {/* Hint — files alone can't be sent; a message is required. */}
            {draft.trim().length === 0 ? (
              <span
                style={{
                  fontSize: size(10),
                  color: '#fbbf24',
                  alignSelf: 'center',
                  marginInlineStart: 4,
                }}
              >
                כתוב הודעה כדי לשלוח את הצרופות
              </span>
            ) : null}
          </div>
        ) : null}
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
        <label
          title="צרף קבצים (גם drag-and-drop)"
          aria-label="צרף קבצים"
          style={{
            width: 44,
            minHeight: 44,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 10,
            color: '#cbd5e1',
            cursor: empty || !issue || sending ? 'not-allowed' : 'pointer',
            opacity: empty || !issue || sending ? 0.4 : 1,
            fontSize: size(18),
            flexShrink: 0,
          }}
        >
          📎
          <input
            type="file"
            multiple
            hidden
            disabled={empty || !issue || sending}
            onChange={(e) => {
              stageFiles(setComposerFiles, e.target.files);
              e.target.value = '';
            }}
          />
        </label>
        <textarea
          dir="rtl"
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            empty ? 'בחר סוכן…' : issue ? 'כתוב הודעה…' : 'אין שיחה פעילה'
          }
          disabled={empty || !issue || sending}
          style={{
            flex: 1,
            resize: 'none',
            minHeight: 44,
            maxHeight: 140,
            padding: '10px 12px',
            borderRadius: 10,
            border: '1px solid rgba(255,255,255,0.12)',
            background: 'rgba(255,255,255,0.06)',
            color: '#f1f5f9',
            fontFamily: 'inherit',
            fontSize: size(15),
            lineHeight: 1.45,
            outline: 'none',
          }}
        />
        {(() => {
          // Send requires a non-empty text message. Attachments may
          // accompany it but never substitute for it. A staged file
          // with a client-side error also blocks the send until it's
          // removed or retried.
          const hasFileErrors = composerFiles.some((f) => f.error != null);
          const sendDisabled =
            empty ||
            !issue ||
            sending ||
            hasFileErrors ||
            draft.trim().length === 0;
          return (
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={sendDisabled}
              style={{
                background: '#16a34a',
                color: '#fff',
                border: 'none',
                borderRadius: 10,
                padding: '10px 18px',
                fontSize: size(15),
                fontWeight: 700,
                cursor: sendDisabled ? 'not-allowed' : 'pointer',
                opacity: sendDisabled ? 0.5 : 1,
                fontFamily: 'inherit',
              }}
            >
              {sending ? '…' : 'שלח'}
            </button>
          );
        })()}
        </div>
      </footer>
    </aside>
    <TasksPanel
      issue={issue}
      isOpen={tasksOpen}
      onClose={() => setTasksOpen(false)}
      chatCollapsed={false}
      size={size}
      onNavigateToIssue={onSelectNode}
    />
    </>
  );
}
