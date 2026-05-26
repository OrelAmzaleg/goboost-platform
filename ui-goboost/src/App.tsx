import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  activeChatScope,
  activeScopeBookmarks,
  autoPinRootIssue,
  getScopeArrangement,
  loadArrangement,
  pinIssue as pinIssueInArrangement,
  reorderPins,
  saveArrangement,
  seedArrangement,
  setActivePin,
  setActiveScope,
  unpinIssue,
  type BookmarkArrangement,
  type ProjectScope,
} from './bookmarks.js';
import { toMajorMinor } from './changelogData.js';
import { BookmarksBar } from './components/BookmarksBar.js';
import { AgentManagementModal } from './components/AgentManagementModal.js';
import { AssignTaskModal } from './components/AssignTaskModal.js';
import { CompanyOnboardingWizard } from './components/CompanyOnboardingWizard.js';
import { CompanySettingsModal } from './components/CompanySettingsModal.js';
import { GoalsModal } from './components/GoalsModal.js';
import { OrgChartModal } from './components/OrgChartModal.js';
import { RoutinesModal } from './components/RoutinesModal.js';
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher.js';
import { BottomToolbar } from './components/BottomToolbar.js';
import { ProjectCreateModal } from './components/ProjectCreateModal.js';
import { ProjectEditModal } from './components/ProjectEditModal.js';
import { WhatsAppPanel } from './components/WhatsAppPanel.js';
import { ChangelogModal } from './components/ChangelogModal.js';
import { DebugView } from './components/DebugView.js';
import { EditActionBar } from './components/EditActionBar.js';
import { MigrationNotice } from './components/MigrationNotice.js';
import { SettingsModal } from './components/SettingsModal.js';
import { Tooltip } from './components/Tooltip.js';
import { Modal } from './components/ui/Modal.js';
import { VersionIndicator } from './components/VersionIndicator.js';
import { ZoomControls } from './components/ZoomControls.js';
import { useEditorActions } from './hooks/useEditorActions.js';
import { useEditorKeyboard } from './hooks/useEditorKeyboard.js';
import { useExtensionMessages } from './hooks/useExtensionMessages.js';
import { startAgentSpeechBridge } from './office/agentSpeechBridge.js';
import { OfficeCanvas } from './office/components/OfficeCanvas.js';
import { AgentActionToolbar } from './office/components/AgentActionToolbar.js';
import { AgentStatusBadges } from './office/components/AgentStatusBadges.js';
import { ToolOverlay } from './office/components/ToolOverlay.js';
import { EditorState } from './office/editor/editorState.js';
import { EditorToolbar } from './office/editor/EditorToolbar.js';
import { OfficeState } from './office/engine/officeState.js';
import { isRotatable } from './office/layout/furnitureCatalog.js';
import { EditTool } from './office/types.js';
import {
  deleteCompany,
  fetchCompanies,
  fetchCompanyProjects,
  fetchCompanyStats,
  fetchIssueById,
  fetchIssueDescendants,
  fetchParticipantIssues,
  getActiveCompanyId,
  resetPaperclipApiState,
  subscribeActivity,
  uuidForNumericAgentId,
  type PaperclipCompany,
  type PaperclipCompanyStats,
  type PaperclipIssue,
  type PaperclipProject,
} from './paperclipApi.js';
import { isBrowserRuntime } from './runtime.js';
import { vscode } from './vscodeApi.js';

// Height of the connection banner (#gb-bootstrap-banner, fixed at top).
const CONNECTION_BANNER_HEIGHT = 38;
// Height of the bookmarks bar (px).
const BOOKMARKS_BAR_HEIGHT = 38;
// The whole interface (office canvas + overlays) starts below the banner
// and the bookmarks bar. Fixed panels use the same offset for their `top`.
const CONTENT_TOP_OFFSET = CONNECTION_BANNER_HEIGHT + BOOKMARKS_BAR_HEIGHT;

// Game state lives outside React — updated imperatively by message handlers
const officeStateRef = { current: null as OfficeState | null };
const editorState = new EditorState();

function getOfficeState(): OfficeState {
  if (!officeStateRef.current) {
    officeStateRef.current = new OfficeState();
  }
  return officeStateRef.current;
}

// localStorage key for the last-chosen company id. Survives reloads
// so the user returns to the same workspace they left.
const LS_ACTIVE_COMPANY_ID = 'goboost.activeCompanyId';

function readStoredCompanyId(): string | null {
  try {
    return localStorage.getItem(LS_ACTIVE_COMPANY_ID);
  } catch {
    return null;
  }
}

function App() {
  // ── Projects / bookmarks state ────────────────────────────────────────────
  // `paperclipReady` flips true once the WS handshake completes — only then
  // is `getActiveCompanyId()` populated, so project loading waits on it.
  const [paperclipReady, setPaperclipReady] = useState(false);
  const [projects, setProjects] = useState<PaperclipProject[]>([]);

  // ── Workspace (company) state — Session 8 ─────────────────────────────────
  // `activeCompanyId` is the SOURCE OF TRUTH for which company we're
  // bound to. Changing it triggers the bootstrap effect to tear down
  // the current API connection and re-bootstrap with the new id.
  const [activeCompanyId, setActiveCompanyId] = useState<string | null>(
    () => readStoredCompanyId(),
  );
  const [companies, setCompanies] = useState<PaperclipCompany[]>([]);
  const [companyStats, setCompanyStats] = useState<
    Record<string, PaperclipCompanyStats>
  >({});
  const [connectionState, setConnectionState] = useState<string>('connecting');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardFirstRun, setWizardFirstRun] = useState(false);
  // Which company's settings are currently open. Null = closed. Stored
  // separately from `activeCompanyId` because per-row ⚙ in the switcher
  // can open settings for ANY company, not just the active one.
  const [companySettingsCompanyId, setCompanySettingsCompanyId] = useState<
    string | null
  >(null);

  // Refresh companies list after any change (create / archive / settings
  // edit). Called from the wizard's onLaunch + the settings modal's
  // onChanged / onArchived / onDeleted.
  const reloadCompanies = useCallback(async () => {
    const [list, stats] = await Promise.all([
      fetchCompanies(),
      fetchCompanyStats(),
    ]);
    setCompanies(list);
    setCompanyStats(stats);
  }, []);

  const switchToCompany = useCallback((companyId: string) => {
    // Persist + change active id. The bootstrap effect re-runs (its
    // cleanup tears down state, then it boots fresh with this id as
    // `preferredCompanyId`).
    try {
      localStorage.setItem(LS_ACTIVE_COMPANY_ID, companyId);
    } catch {
      // localStorage might fail in private mode — non-fatal.
    }
    setActiveCompanyId(companyId);
  }, []);
  // The per-company bookmark arrangement (order / pins / issue-pins / active).
  // Loaded from localStorage once the company id is known.
  const [arrangement, setArrangement] = useState<BookmarkArrangement | null>(
    null,
  );

  // Browser runtime (dev or static dist): load static assets via browserMock,
  // then connect to Paperclip via paperclipApi for live agent events.
  // The two are complementary: browserMock loads sprites/floors/walls/layout
  // (which never come from Paperclip), and paperclipApi loads live agents.
  //
  // React StrictMode invokes effects twice in dev. Without cleanup, two
  // paperclipApi instances run in parallel — each opens its own WebSocket
  // and overwrites the module-level IdMapper, which races against the chat
  // panel's UUID lookups. The cleanup below stops the first instance before
  // the second initializes.
  useEffect(() => {
    if (!isBrowserRuntime) return;

    let stopped = false;
    let handle: import('./paperclipApi.js').PaperclipApiHandle | null = null;
    let stopSpeechBridge: (() => void) | null = null;

    setPaperclipReady(false);
    setConnectionState('connecting');

    void (async () => {
      const { dispatchMockMessages } = await import('./browserMock.js');
      if (stopped) return;
      dispatchMockMessages();
      const { startPaperclipApi } = await import('./paperclipApi.js');
      if (stopped) return;
      const baseUrl =
        (import.meta.env.VITE_PAPERCLIP_API_URL as string | undefined) ?? undefined;
      handle = await startPaperclipApi({
        baseUrl,
        // Pass the localStorage-derived preference so re-bootstraps
        // after a workspace switch land on the new company instead of
        // falling back to "first company in the list".
        preferredCompanyId: activeCompanyId,
        onStatusChange: (status) => {
          setConnectionState(status.state);
          // Once connected, the company id is populated — unblock the
          // bookmarks/projects load + fetch the companies list for
          // the WorkspaceSwitcher dropdown.
          if (status.state === 'connected') {
            setPaperclipReady(true);
            // Sync local activeCompanyId with whatever startPaperclipApi
            // actually picked (e.g. when the stored id was archived
            // and it fell back to firstActive).
            const picked = getActiveCompanyId();
            if (picked && picked !== activeCompanyId) {
              try {
                localStorage.setItem(LS_ACTIVE_COMPANY_ID, picked);
              } catch {
                /* noop */
              }
              setActiveCompanyId(picked);
            }
            // Load the companies list for the switcher dropdown.
            void reloadCompanies();
            // Boot the speech bridge once — it subscribes to global
            // heartbeat/activity streams and dispatches text bubbles
            // onto the office canvas. Idempotent guard: only start the
            // first time we hit `connected` for this effect.
            if (!stopSpeechBridge && !stopped) {
              stopSpeechBridge = startAgentSpeechBridge(getOfficeState);
            }
          }
          if (status.state === 'no-company') {
            // No companies on the Paperclip server → first-run wizard.
            setWizardFirstRun(true);
            setWizardOpen(true);
          }
        },
      });
      // If cleanup ran while we were awaiting startPaperclipApi, stop the
      // handle we just got.
      if (stopped && handle) handle.stop();
    })();

    return () => {
      stopped = true;
      if (handle) handle.stop();
      if (stopSpeechBridge) {
        stopSpeechBridge();
        stopSpeechBridge = null;
      }
      // Workspace tear-down: wipe module-level caches so the next
      // bootstrap (after a company switch) starts with a clean slate.
      // Also clear the visible office characters so we don't show
      // ghosts from the previous workspace during the transition.
      resetPaperclipApiState();
      try {
        getOfficeState().clearAgents();
      } catch {
        /* office may not be initialized yet */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCompanyId]);

  // ── Bookmarks: load projects + arrangement once Paperclip is connected ────
  // A first-time user (no stored arrangement) gets every project seeded
  // into the bar; from then on the bar is curated by hand.
  useEffect(() => {
    if (!paperclipReady) return;
    const companyId = getActiveCompanyId();
    if (!companyId) return;
    let cancelled = false;
    const stored = loadArrangement(companyId);
    void fetchCompanyProjects().then((list) => {
      if (cancelled) return;
      setProjects(list);
      if (stored) {
        setArrangement(stored);
      } else {
        // First time in this company → dashboard view, no pins yet.
        // ROOT issues created from this moment forward will auto-pin
        // into the matching scope as `issue.created` events arrive.
        const seeded = seedArrangement();
        setArrangement(seeded);
        saveArrangement(companyId, seeded);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [paperclipReady]);

  // Live project updates — refetch on any `project.*` activity.
  useEffect(() => {
    if (!paperclipReady) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeActivity((payload) => {
      if (String(payload.entityType ?? '') !== 'project') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void fetchCompanyProjects().then(setProjects);
      }, 800);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [paperclipReady]);

  // Auto-pin ROOT issues (parentId === null) into their matching
  // scope on `issue.created`. Forward-only — Session 9.2 spec
  // explicitly opts out of backfilling historical ROOTs. If the
  // operator previously removed an auto-pin for this issue, the
  // suppression list (`removedAutoPins`) keeps it off the bar.
  //
  // Activity details don't carry `parentId`/`projectId`, so we fetch
  // the issue record once before deciding. The functional setState
  // guards against the load-vs-event race: if arrangement isn't
  // loaded yet, we skip rather than seed a fresh one and clobber
  // the upcoming load.
  useEffect(() => {
    if (!paperclipReady) return;
    const unsubscribe = subscribeActivity((payload) => {
      if (String(payload.entityType ?? '') !== 'issue') return;
      if (String(payload.action ?? '') !== 'issue.created') return;
      const issueId = String(payload.entityId ?? '');
      if (!issueId) return;
      void fetchIssueById(issueId).then((issue) => {
        if (!issue || issue.parentId != null) return;
        setArrangement((cur) => {
          if (!cur) return cur;
          const next = autoPinRootIssue(cur, {
            id: issue.id,
            title: issue.title,
            identifier: issue.identifier,
            projectId: issue.projectId,
          });
          if (next === cur) return cur;
          const companyId = getActiveCompanyId();
          if (companyId) saveArrangement(companyId, next);
          return next;
        });
      });
    });
    return unsubscribe;
  }, [paperclipReady]);

  // A safe fallback arrangement for the window before the real one
  // loads — dashboard mode, no scopes populated yet.
  const effectiveArrangement: BookmarkArrangement = arrangement ?? seedArrangement();

  // Pin tabs visible to the right of the selector — ALWAYS just the
  // active scope's pins. Swaps automatically when the operator
  // changes the selector.
  const pinnedBookmarks = useMemo(
    () => activeScopeBookmarks(effectiveArrangement),
    [effectiveArrangement],
  );
  const activePinId = useMemo(() => {
    const here = getScopeArrangement(
      effectiveArrangement,
      effectiveArrangement.activeScope,
    );
    return here.activePinId;
  }, [effectiveArrangement]);

  // What the chat panel reads — either the active pin's issue scope
  // or the active project scope itself. CRITICAL: we key the memo on
  // PRIMITIVE fields, not on `effectiveArrangement` as a whole.
  //
  // Why this matters: WhatsAppPanel's forest-load effect depends on
  // `activeScope` identity. If we re-create the activeScope object on
  // every arrangement update (e.g. when auto-pin fires or any pin is
  // added in any scope), the child effect re-fires, the agent forest
  // gets refetched, the active issue gets reset to default, the chat
  // composer's draft is lost, and inflight messages appear to "vanish".
  // Memoizing on (kind, projectId, activePinId) keeps the reference
  // stable as long as the chat-relevant scope hasn't actually changed.
  const _scopeKind = effectiveArrangement.activeScope.kind;
  const _scopeProjectId =
    effectiveArrangement.activeScope.kind === 'project'
      ? effectiveArrangement.activeScope.projectId
      : null;
  const activeScope = useMemo(() => {
    return activeChatScope(effectiveArrangement);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_scopeKind, _scopeProjectId, activePinId]);

  // ── Arrangement mutators ─────────────────────────────────────────
  // All use the functional setState form so they never capture a
  // stale closure, and persist on every change. The bookmarks module
  // exports pure helpers — App just wires them to React state.

  const persist = useCallback(
    (updater: (cur: BookmarkArrangement) => BookmarkArrangement) => {
      setArrangement((cur) => {
        const base = cur ?? seedArrangement();
        const next = updater(base);
        const companyId = getActiveCompanyId();
        if (companyId) saveArrangement(companyId, next);
        return next;
      });
    },
    [],
  );

  const onSelectScope = useCallback(
    (scope: ProjectScope) => {
      persist((cur) => setActiveScope(cur, scope));
    },
    [persist],
  );
  const onSelectPin = useCallback(
    (issueId: string | null) => {
      persist((cur) => setActivePin(cur, cur.activeScope, issueId));
    },
    [persist],
  );
  const onReorderPins = useCallback(
    (orderedIssueIds: string[]) => {
      persist((cur) => reorderPins(cur, cur.activeScope, orderedIssueIds));
    },
    [persist],
  );
  const onRemovePin = useCallback(
    (issueId: string) => {
      persist((cur) => unpinIssue(cur, cur.activeScope, issueId));
    },
    [persist],
  );

  // Manual pin from the chat panel (📌). Goes into the CURRENT scope,
  // not the issue's project scope — operator is explicitly bookmarking
  // it for their current context.
  const pinIssueAsBookmark = useCallback(
    (issue: PaperclipIssue) => {
      const label = `${issue.identifier ?? '—'} · ${issue.title}`;
      persist((cur) =>
        pinIssueInArrangement(cur, cur.activeScope, {
          issueId: issue.id,
          label,
        }),
      );
    },
    [persist],
  );

  // ── Project create / edit modals ──────────────────────────────────────────
  // `editingProjectId` non-null → edit modal open; `creatingProject` →
  // create modal open. Wired to the bar's ✏ and + → "new project".
  const [creatingProject, setCreatingProject] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(
    null,
  );
  // Goals modal — independent of bookmarks; opened by the 🎯 button.
  const [goalsOpen, setGoalsOpen] = useState(false);
  // Org-chart modal — opened by the 🏢 button.
  const [orgChartOpen, setOrgChartOpen] = useState(false);
  // Agent management modal — driven by the ⚙ button in AgentActionToolbar
  // or by clicking a node in OrgChartModal. `null` = closed; otherwise
  // the agent's UUID.
  const [agentMgmtUuid, setAgentMgmtUuid] = useState<string | null>(null);
  // Routines modal (Session 7) — opened by the 🔁 button in
  // AgentActionToolbar. Filtered to routines whose assignee is this
  // agent. `null` = closed.
  const [routinesAgentUuid, setRoutinesAgentUuid] = useState<string | null>(
    null,
  );
  // Assign-task modal — driven by the ➕ button in AgentActionToolbar
  // AND by the "Ask CEO" path in NewAgentDialog (which reuses this
  // modal for the issue draft instead of carrying its own form).
  const [assignTaskUuid, setAssignTaskUuid] = useState<string | null>(null);
  const [assignTaskPrefill, setAssignTaskPrefill] = useState<{
    title?: string;
    description?: string;
    contextHint?: string;
  } | null>(null);
  // Refetch projects + (when a project is created) select it on the
  // project selector so the operator lands inside the new project's
  // empty pin space immediately.
  const onProjectsChanged = useCallback(
    (focusProjectId?: string) => {
      void fetchCompanyProjects().then((list) => {
        setProjects(list);
        if (focusProjectId) {
          onSelectScope({ kind: 'project', projectId: focusProjectId });
        }
      });
    },
    [onSelectScope],
  );

  const editor = useEditorActions(getOfficeState, editorState);

  const isEditDirty = useCallback(
    () => editor.isEditMode && editor.isDirty,
    [editor.isEditMode, editor.isDirty],
  );

  const {
    agents,
    selectedAgent,
    agentTools,
    agentStatuses,
    subagentTools,
    subagentCharacters,
    layoutReady,
    layoutWasReset,
    loadedAssets,
    workspaceFolders,
    externalAssetDirectories,
    lastSeenVersion,
    extensionVersion,
    watchAllSessions,
    setWatchAllSessions,
    alwaysShowLabels,
    hooksEnabled,
    setHooksEnabled,
    hooksInfoShown,
  } = useExtensionMessages(getOfficeState, editor.setLastSavedLayout, isEditDirty);

  // ── Session 9.3 — scope-driven agent visibility ─────────────────
  //
  // When the active scope changes (or when a relevant issue activity
  // fires), recompute which agents are "involved" in the scope and
  // push the visibility decision into OfficeState. The engine's tick
  // lerps each character's `displayAlpha` toward `targetAlpha` over
  // ~500ms — see `ALPHA_LERP_PER_SECOND` in characters.ts.
  //
  // Involvement per scope:
  //   • dashboard → everyone (short-circuit, no network call)
  //   • general   → agents whose participant-issues include any
  //                 with `projectId == null`
  //   • project   → agents whose participant-issues include any in
  //                 that project
  //   • issue     → agents whose assignee/creator id appears on the
  //                 pinned issue OR its descendants (v1 — comment-
  //                 author participation in this scope is deferred;
  //                 the participant filter already covers it for
  //                 project/general)
  //
  // The currently-selected agent is ALWAYS visible regardless — the
  // operator just clicked them, whisking them away would feel hostile.
  //
  // Activity invalidation: any `issue.*` event that could move an
  // agent in or out of the scope (assignee changed, project moved,
  // parent re-parented, created) triggers a debounced recompute.
  // Comment/attachment/document noise is ignored — those don't shift
  // assignee/creator/project membership.
  useEffect(() => {
    if (!paperclipReady) return;
    let cancelled = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const recompute = async () => {
      const uuidPairs = agents
        .map((id) => ({ id, uuid: uuidForNumericAgentId(id) }))
        .filter((p): p is { id: number; uuid: string } => !!p.uuid);

      if (activeScope.kind === 'dashboard') {
        if (cancelled) return;
        getOfficeState().clearAgentVisibility();
        return;
      }

      let involved: Set<string>;
      if (activeScope.kind === 'issue') {
        const issueId = activeScope.issueId;
        const [head, descendants] = await Promise.all([
          fetchIssueById(issueId),
          fetchIssueDescendants(issueId),
        ]);
        if (cancelled) return;
        const all = [head, ...descendants].filter(
          (i): i is PaperclipIssue => i != null,
        );
        involved = new Set<string>();
        for (const i of all) {
          if (i.assigneeAgentId) involved.add(i.assigneeAgentId);
          if (i.createdByAgentId) involved.add(i.createdByAgentId);
        }
      } else {
        // general / project — per-agent participant probe, in parallel.
        const results = await Promise.all(
          uuidPairs.map(async ({ uuid }) => {
            const opts =
              activeScope.kind === 'project'
                ? { projectId: activeScope.projectId }
                : undefined;
            const issues = await fetchParticipantIssues(uuid, opts);
            const filtered =
              activeScope.kind === 'general'
                ? issues.filter((i) => i.projectId == null)
                : issues;
            return { uuid, hit: filtered.length > 0 };
          }),
        );
        if (cancelled) return;
        involved = new Set(
          results.filter((r) => r.hit).map((r) => r.uuid),
        );
      }

      const visibleIds = new Set<number>();
      for (const { id, uuid } of uuidPairs) {
        if (involved.has(uuid)) visibleIds.add(id);
      }
      if (selectedAgent != null) visibleIds.add(selectedAgent);
      getOfficeState().applyVisibilityFromSet(visibleIds);
    };

    // Light debounce on the initial run so a scope change + WS replay
    // burst fold into one recompute.
    debounce = setTimeout(() => void recompute(), 120);

    const unsubscribe = subscribeActivity((payload) => {
      const entityType = String(payload.entityType ?? '');
      if (entityType !== 'issue') return;
      const action = String(payload.action ?? '');
      if (/comment|attachment|document/i.test(action)) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void recompute(), 250);
    });

    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      unsubscribe();
    };
    // `agents` deliberately omitted: re-running on every agents-array
    // identity change (which can happen on routine UI events) would
    // produce a recompute storm. New agents enter at full alpha by
    // default and the next scope change picks them up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperclipReady, activeScope, selectedAgent]);

  // Show migration notice once layout reset is detected
  const [migrationNoticeDismissed, setMigrationNoticeDismissed] = useState(false);
  const showMigrationNotice = layoutWasReset && !migrationNoticeDismissed;

  const [isChangelogOpen, setIsChangelogOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHooksInfoOpen, setIsHooksInfoOpen] = useState(false);
  const [hooksTooltipDismissed, setHooksTooltipDismissed] = useState(false);
  const [isDebugMode, setIsDebugMode] = useState(false);
  const [alwaysShowOverlay, setAlwaysShowOverlay] = useState(false);

  const currentMajorMinor = toMajorMinor(extensionVersion);

  const handleWhatsNewDismiss = useCallback(() => {
    vscode.postMessage({ type: 'setLastSeenVersion', version: currentMajorMinor });
  }, [currentMajorMinor]);

  const handleOpenChangelog = useCallback(() => {
    setIsChangelogOpen(true);
    vscode.postMessage({ type: 'setLastSeenVersion', version: currentMajorMinor });
  }, [currentMajorMinor]);

  // Sync alwaysShowOverlay from persisted settings
  useEffect(() => {
    setAlwaysShowOverlay(alwaysShowLabels);
  }, [alwaysShowLabels]);

  const handleToggleDebugMode = useCallback(() => setIsDebugMode((prev) => !prev), []);
  const handleToggleAlwaysShowOverlay = useCallback(() => {
    setAlwaysShowOverlay((prev) => {
      const newVal = !prev;
      vscode.postMessage({ type: 'setAlwaysShowLabels', enabled: newVal });
      return newVal;
    });
  }, []);

  const handleSelectAgent = useCallback((id: number) => {
    vscode.postMessage({ type: 'focusAgent', id });
  }, []);

  const containerRef = useRef<HTMLDivElement>(null);

  const [editorTickForKeyboard, setEditorTickForKeyboard] = useState(0);
  useEditorKeyboard(
    editor.isEditMode,
    editorState,
    editor.handleDeleteSelected,
    editor.handleRotateSelected,
    editor.handleToggleState,
    editor.handleUndo,
    editor.handleRedo,
    useCallback(() => setEditorTickForKeyboard((n) => n + 1), []),
    editor.handleToggleEditMode,
  );

  const handleCloseAgent = useCallback((id: number) => {
    vscode.postMessage({ type: 'closeAgent', id });
  }, []);

  const handleClick = useCallback((agentId: number) => {
    // If clicked agent is a sub-agent, focus the parent's terminal instead
    const os = getOfficeState();
    const meta = os.subagentMeta.get(agentId);
    const focusId = meta ? meta.parentAgentId : agentId;
    vscode.postMessage({ type: 'focusAgent', id: focusId });
    // GoBoost: in browser mode the vscode.postMessage above is a no-op stub —
    // pixel-agents was designed so the VS Code extension would observe the
    // focusAgent message, focus the Claude Code terminal, then reply with
    // `agentSelected` which updates React state. Without an extension on the
    // other end, selectedAgent never moves. We dispatch agentSelected locally
    // so the chat panel reacts to clicks.
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'agentSelected', id: focusId } }),
    );
  }, []);

  const officeState = getOfficeState();

  // Force dependency on editorTickForKeyboard to propagate keyboard-triggered re-renders
  void editorTickForKeyboard;

  // Show "Press R to rotate" hint when a rotatable item is selected or being placed
  const showRotateHint =
    editor.isEditMode &&
    (() => {
      if (editorState.selectedFurnitureUid) {
        const item = officeState
          .getLayout()
          .furniture.find((f) => f.uid === editorState.selectedFurnitureUid);
        if (item && isRotatable(item.type)) return true;
      }
      if (
        editorState.activeTool === EditTool.FURNITURE_PLACE &&
        isRotatable(editorState.selectedFurnitureType)
      ) {
        return true;
      }
      return false;
    })();

  if (!layoutReady) {
    return <div className="w-full h-full flex items-center justify-center ">Loading...</div>;
  }

  // GoBoost: name of the selected agent, read directly from the office state
  // (folderName was set on addAgent). OfficeState is imperative, not React
  // state, so this is a fresh read on every render — fine since names are
  // assigned at agent creation and don't change.
  const selectedAgentName =
    selectedAgent != null
      ? officeState.characters.get(selectedAgent)?.folderName ?? null
      : null;

  return (
    <div
      ref={containerRef}
      className="overflow-hidden"
      style={{
        // The interface begins below the connection banner + bookmarks
        // bar — neither of which should ever overlap the office canvas
        // or the chat panel. `absolute` keeps it a positioned ancestor so
        // descendants' `inset-0` still resolve against this box.
        position: 'absolute',
        top: CONTENT_TOP_OFFSET,
        left: 0,
        right: 0,
        bottom: 0,
      }}
    >
      <OfficeCanvas
        officeState={officeState}
        onClick={handleClick}
        isEditMode={editor.isEditMode}
        editorState={editorState}
        onEditorTileAction={editor.handleEditorTileAction}
        onEditorEraseAction={editor.handleEditorEraseAction}
        onEditorSelectionChange={editor.handleEditorSelectionChange}
        onDeleteSelected={editor.handleDeleteSelected}
        onRotateSelected={editor.handleRotateSelected}
        onDragMove={editor.handleDragMove}
        editorTick={editor.editorTick}
        zoom={editor.zoom}
        onZoomChange={editor.handleZoomChange}
        panRef={editor.panRef}
      />

      {/* GoBoost project bookmarks — Session 9.2 redesign. First slot
          is a ProjectSelector chip; the strip to its left shows the
          ACTIVE scope's pinned issues. Switching scopes swaps the pin
          set; per-scope arrangement persists per company. */}
      <BookmarksBar
        activeScope={effectiveArrangement.activeScope}
        projects={projects}
        pinnedBookmarks={pinnedBookmarks}
        activePinId={activePinId}
        height={BOOKMARKS_BAR_HEIGHT}
        onSelectScope={onSelectScope}
        onSelectPin={onSelectPin}
        onReorderPins={onReorderPins}
        onRemovePin={onRemovePin}
        onEditProject={(projectId) => setEditingProjectId(projectId)}
        onCreateProject={() => setCreatingProject(true)}
        onOpenGoals={() => setGoalsOpen(true)}
        onOpenOrgChart={() => setOrgChartOpen(true)}
      />

      {/* GoBoost WhatsApp Chat Panel — Iteration 2.B.1.
          Fixed right-side overlay; binds to currently-selected agent.

          `key={activeCompanyId}` forces a full unmount/remount when the
          workspace switches. The panel caches per-company state (agent
          roster for the assignee picker, active issue, comments) that
          MUST NOT survive across companies — leaking the previous org's
          agents into the new org's picker was a real bug. The remount
          keeps every effect's initial load clean against the new
          company's data. */}
      <WhatsAppPanel
        key={activeCompanyId ?? 'no-company'}
        selectedAgentId={selectedAgent}
        selectedAgentName={selectedAgentName}
        activeScope={activeScope}
        onPinIssue={pinIssueAsBookmark}
      />

      {/* Project create / edit modals. The legacy ProjectAddModal
          ("+ add existing project to bar") was retired in 9.2 — every
          project is now automatically available in the selector
          dropdown; the add flow is just create-new. */}
      {creatingProject ? (
        <ProjectCreateModal
          onClose={() => setCreatingProject(false)}
          onCreated={(project) => {
            setCreatingProject(false);
            onProjectsChanged(project.id);
          }}
        />
      ) : null}
      {editingProjectId ? (
        <ProjectEditModal
          projectId={editingProjectId}
          onClose={() => setEditingProjectId(null)}
          onChanged={() => onProjectsChanged()}
          onArchived={(archivedId) => {
            setEditingProjectId(null);
            // If the archived project was the active scope, fall back
            // to dashboard so the operator never lands on a phantom
            // selector entry.
            if (
              effectiveArrangement.activeScope.kind === 'project' &&
              effectiveArrangement.activeScope.projectId === archivedId
            ) {
              onSelectScope({ kind: 'dashboard' });
            }
            onProjectsChanged();
          }}
        />
      ) : null}
      {goalsOpen ? (
        <GoalsModal onClose={() => setGoalsOpen(false)} />
      ) : null}
      {orgChartOpen ? (
        <OrgChartModal
          onClose={() => setOrgChartOpen(false)}
          onSelectAgent={(uuid, numericId) => {
            setOrgChartOpen(false);
            // Mirror the canvas-click flow so the office, chat, and
            // forest all re-home onto this agent (same MessageEvent
            // shape used by handleClick).
            window.dispatchEvent(
              new MessageEvent('message', {
                data: { type: 'agentSelected', id: numericId },
              }),
            );
            // Phase 3.E cross-link: opening the org chart and clicking
            // a node lands the operator straight into that agent's
            // management modal.
            setAgentMgmtUuid(uuid);
          }}
          onAskCeo={(ceoUuid, ceoName) => {
            // Reuse AssignTaskModal for the "Ask CEO" issue draft —
            // same full-featured composer that the ➕ agent toolbar
            // button uses (priority, goal, project, etc.). NewAgentDialog
            // closes itself; OrgChartModal stays behind so the operator
            // returns to the chart after submitting.
            setAssignTaskUuid(ceoUuid);
            setAssignTaskPrefill({
              title: 'יצירת סוכן חדש',
              description:
                '(תאר כאן איזה סוכן אתה רוצה — תפקיד, כישורים, כלים שדרושים)',
              contextHint: `המשימה תוקצה ל-${ceoName ?? 'CEO'} שיחליט מי לגייס ואיך לאתחל את הסוכן.`,
            });
          }}
        />
      ) : null}
      {agentMgmtUuid ? (
        <AgentManagementModal
          agentUuid={agentMgmtUuid}
          onClose={() => setAgentMgmtUuid(null)}
        />
      ) : null}
      {assignTaskUuid ? (
        <AssignTaskModal
          agentUuid={assignTaskUuid}
          initialTitle={assignTaskPrefill?.title}
          initialDescription={assignTaskPrefill?.description}
          contextHint={assignTaskPrefill?.contextHint}
          onClose={() => {
            setAssignTaskUuid(null);
            setAssignTaskPrefill(null);
          }}
        />
      ) : null}
      {routinesAgentUuid ? (
        <RoutinesModal
          agentUuid={routinesAgentUuid}
          onClose={() => setRoutinesAgentUuid(null)}
        />
      ) : null}

      {/* Workspace switcher — portal-mounted into #gb-bootstrap-banner.
          Renders always (even when companies list is empty) so the
          user can always pop the "+ workspace חדש" CTA from the dropdown. */}
      <WorkspaceSwitcher
        companies={companies}
        activeCompanyId={activeCompanyId}
        stats={companyStats}
        connectionState={connectionState}
        onSwitch={switchToCompany}
        onCreateNew={() => {
          setWizardFirstRun(false);
          setWizardOpen(true);
        }}
        onOpenSettings={(companyId) =>
          setCompanySettingsCompanyId(companyId)
        }
        onDeleteCompany={async (companyId) => {
          const target = companies.find((c) => c.id === companyId);
          const name = target?.name ?? 'החברה';
          const confirmed = window.confirm(
            `למחוק לצמיתות את "${name}"?\n\nפעולה זו לא ניתנת לביטול: כל הסוכנים, המשימות והנתונים של החברה יאבדו.`,
          );
          if (!confirmed) return;
          const ok = await deleteCompany(companyId);
          if (!ok) {
            window.alert(
              `מחיקת "${name}" נכשלה. ייתכן שאינך admin/board ב-Paperclip, או שהשרת לא זמין.`,
            );
            return;
          }
          await reloadCompanies();
          // If the deleted company was the active one, switch to the
          // next available active workspace; otherwise stay put.
          if (companyId === activeCompanyId) {
            const next = companies.find(
              (c) => c.id !== companyId && c.status !== 'archived',
            );
            if (next) {
              switchToCompany(next.id);
            } else {
              try {
                localStorage.removeItem(LS_ACTIVE_COMPANY_ID);
              } catch {
                /* noop */
              }
              setActiveCompanyId(null);
            }
          }
        }}
      />

      {wizardOpen ? (
        <CompanyOnboardingWizard
          isFirstRun={wizardFirstRun}
          onClose={() => {
            // First-run wizard is non-dismissible — guard regardless.
            if (wizardFirstRun) return;
            setWizardOpen(false);
          }}
          onLaunch={(company) => {
            setWizardOpen(false);
            setWizardFirstRun(false);
            // Refresh the companies list, THEN switch — switch triggers
            // tear-down + rebootstrap which then re-reloads companies
            // anyway, but doing it eagerly here means the switcher has
            // the new entry the moment the wizard closes.
            void reloadCompanies();
            switchToCompany(company.id);
          }}
        />
      ) : null}

      {companySettingsCompanyId ? (
        <CompanySettingsModal
          companyId={companySettingsCompanyId}
          onClose={() => setCompanySettingsCompanyId(null)}
          onChanged={async () => {
            await reloadCompanies();
          }}
          onArchived={async () => {
            const archivedId = companySettingsCompanyId;
            await reloadCompanies();
            setCompanySettingsCompanyId(null);
            // If the archived company was the active one, switch to
            // another active company (or null → triggers no-company
            // flow which auto-opens the wizard).
            if (archivedId === activeCompanyId) {
              const next = companies.find(
                (c) => c.id !== archivedId && c.status !== 'archived',
              );
              if (next) {
                switchToCompany(next.id);
              } else {
                try {
                  localStorage.removeItem(LS_ACTIVE_COMPANY_ID);
                } catch {
                  /* noop */
                }
                setActiveCompanyId(null);
              }
            }
          }}
          onDeleted={async () => {
            const deletedId = companySettingsCompanyId;
            await reloadCompanies();
            setCompanySettingsCompanyId(null);
            if (deletedId === activeCompanyId) {
              const next = companies.find(
                (c) => c.id !== deletedId && c.status !== 'archived',
              );
              if (next) {
                switchToCompany(next.id);
              } else {
                try {
                  localStorage.removeItem(LS_ACTIVE_COMPANY_ID);
                } catch {
                  /* noop */
                }
                setActiveCompanyId(null);
              }
            }
          }}
        />
      ) : null}

      {!isDebugMode ? (
        <>
          <ZoomControls zoom={editor.zoom} onZoomChange={editor.handleZoomChange} />

          {/* Vignette overlay */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{ background: 'var(--vignette)' }}
          />

          {editor.isEditMode && editor.isDirty && (
            <EditActionBar editor={editor} editorState={editorState} />
          )}

          {showRotateHint && (
            <div
              className="absolute left-1/2 -translate-x-1/2 z-11 bg-accent-bright text-white text-sm py-3 px-8 rounded-none border-2 border-accent shadow-pixel pointer-events-none whitespace-nowrap"
              style={{ top: editor.isDirty ? 64 : 8 }}
            >
              Rotate (R)
            </div>
          )}

          {editor.isEditMode &&
            (() => {
              const selUid = editorState.selectedFurnitureUid;
              const selColor = selUid
                ? (officeState.getLayout().furniture.find((f) => f.uid === selUid)?.color ?? null)
                : null;
              return (
                <EditorToolbar
                  activeTool={editorState.activeTool}
                  selectedTileType={editorState.selectedTileType}
                  selectedFurnitureType={editorState.selectedFurnitureType}
                  selectedFurnitureUid={selUid}
                  selectedFurnitureColor={selColor}
                  floorColor={editorState.floorColor}
                  wallColor={editorState.wallColor}
                  selectedWallSet={editorState.selectedWallSet}
                  onToolChange={editor.handleToolChange}
                  onTileTypeChange={editor.handleTileTypeChange}
                  onFloorColorChange={editor.handleFloorColorChange}
                  onWallColorChange={editor.handleWallColorChange}
                  onWallSetChange={editor.handleWallSetChange}
                  onSelectedFurnitureColorChange={editor.handleSelectedFurnitureColorChange}
                  onFurnitureTypeChange={editor.handleFurnitureTypeChange}
                  loadedAssets={loadedAssets}
                />
              );
            })()}

          <ToolOverlay
            officeState={officeState}
            agents={agents}
            agentTools={agentTools}
            subagentCharacters={subagentCharacters}
            containerRef={containerRef}
            zoom={editor.zoom}
            panRef={editor.panRef}
            onCloseAgent={handleCloseAgent}
            alwaysShowOverlay={alwaysShowOverlay}
          />
          {/* Always-visible per-agent status badges (Session 9.1):
              💤 idle / ⚙️ working / ❗ waiting / 🚨 failed / ⏸ paused.
              Sits above ToolOverlay/AgentActionToolbar in DOM order so
              the badges stay readable when a hover overlay opens. */}
          <AgentStatusBadges
            officeState={officeState}
            agents={agents}
            containerRef={containerRef}
            zoom={editor.zoom}
            panRef={editor.panRef}
          />
          {/* Agent action toolbar — floats above the selected agent's
              ToolOverlay. Distinct layer so the metadata strip below
              stays untouched. */}
          <AgentActionToolbar
            officeState={officeState}
            containerRef={containerRef}
            zoom={editor.zoom}
            panRef={editor.panRef}
            onOpenSettings={(uuid) => setAgentMgmtUuid(uuid)}
            onAssignTask={(uuid) => setAssignTaskUuid(uuid)}
            onOpenRoutines={(uuid) => setRoutinesAgentUuid(uuid)}
            onPinIssue={pinIssueAsBookmark}
          />
        </>
      ) : (
        <DebugView
          agents={agents}
          selectedAgent={selectedAgent}
          agentTools={agentTools}
          agentStatuses={agentStatuses}
          subagentTools={subagentTools}
          onSelectAgent={handleSelectAgent}
        />
      )}

      {/* Hooks first-run tooltip */}
      {!hooksInfoShown && !hooksTooltipDismissed && (
        <Tooltip
          title="Instant Detection Active"
          position="top-right"
          onDismiss={() => {
            setHooksTooltipDismissed(true);
            vscode.postMessage({ type: 'setHooksInfoShown' });
          }}
        >
          <span className="text-sm text-text leading-none">
            Your agents now respond in real-time.{' '}
            <span
              className="text-accent cursor-pointer underline"
              onClick={() => {
                setIsHooksInfoOpen(true);
                setHooksTooltipDismissed(true);
                vscode.postMessage({ type: 'setHooksInfoShown' });
              }}
            >
              View more
            </span>
          </span>
        </Tooltip>
      )}

      {/* Hooks info modal */}
      <Modal
        isOpen={isHooksInfoOpen}
        onClose={() => setIsHooksInfoOpen(false)}
        title="Instant Detection is ON"
        zIndex={52}
      >
        <div className="text-base text-text px-10" style={{ lineHeight: 1.4 }}>
          <p className="mb-8">Your Pixel Agents office now reacts in real-time:</p>
          <ul className="mb-8 pl-18 list-disc m-0">
            <li className="text-sm mb-2">Permission prompts appear instantly</li>
            <li className="text-sm mb-2">Turn completions detected the moment they happen</li>
            <li className="text-sm mb-2">Sound notifications play immediately</li>
          </ul>
          <p className="mb-12 text-text-muted">
            This works through Claude Code Hooks, small event listeners that notify Pixel Agents
            whenever something happens in your Claude sessions.
          </p>
          <div className="text-center">
            <button
              onClick={() => setIsHooksInfoOpen(false)}
              className="py-4 px-20 text-lg bg-accent text-white border-2 border-accent rounded-none cursor-pointer shadow-pixel"
            >
              Got it
            </button>
          </div>
          <p className="mt-8 text-xs text-text-muted text-center">
            To disable, go to Settings {'>'} Instant Detection
          </p>
        </div>
      </Modal>

      <BottomToolbar
        isEditMode={editor.isEditMode}
        onOpenClaude={editor.handleOpenClaude}
        onToggleEditMode={editor.handleToggleEditMode}
        isSettingsOpen={isSettingsOpen}
        onToggleSettings={() => setIsSettingsOpen((v) => !v)}
        workspaceFolders={workspaceFolders}
      />

      <VersionIndicator
        currentVersion={extensionVersion}
        lastSeenVersion={lastSeenVersion}
        onDismiss={handleWhatsNewDismiss}
        onOpenChangelog={handleOpenChangelog}
      />

      <ChangelogModal
        isOpen={isChangelogOpen}
        onClose={() => setIsChangelogOpen(false)}
        currentVersion={extensionVersion}
      />

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        isDebugMode={isDebugMode}
        onToggleDebugMode={handleToggleDebugMode}
        alwaysShowOverlay={alwaysShowOverlay}
        onToggleAlwaysShowOverlay={handleToggleAlwaysShowOverlay}
        externalAssetDirectories={externalAssetDirectories}
        watchAllSessions={watchAllSessions}
        onToggleWatchAllSessions={() => {
          const newVal = !watchAllSessions;
          setWatchAllSessions(newVal);
          vscode.postMessage({ type: 'setWatchAllSessions', enabled: newVal });
        }}
        hooksEnabled={hooksEnabled}
        onToggleHooksEnabled={() => {
          const newVal = !hooksEnabled;
          setHooksEnabled(newVal);
          vscode.postMessage({ type: 'setHooksEnabled', enabled: newVal });
        }}
      />

      {showMigrationNotice && (
        <MigrationNotice onDismiss={() => setMigrationNoticeDismissed(true)} />
      )}
    </div>
  );
}

export default App;
