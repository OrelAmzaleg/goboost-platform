import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  activeScopeOf,
  availableProjects,
  GENERAL_BOOKMARK_ID,
  issueBookmarkId,
  loadArrangement,
  projectBookmarkId,
  reconcileBookmarks,
  saveArrangement,
  seedArrangement,
  type BookmarkArrangement,
} from './bookmarks.js';
import { toMajorMinor } from './changelogData.js';
import { BookmarksBar } from './components/BookmarksBar.js';
import { AgentManagementModal } from './components/AgentManagementModal.js';
import { AssignTaskModal } from './components/AssignTaskModal.js';
import { GoalsModal } from './components/GoalsModal.js';
import { OrgChartModal } from './components/OrgChartModal.js';
import { BottomToolbar } from './components/BottomToolbar.js';
import { ProjectAddModal } from './components/ProjectAddModal.js';
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
import { ToolOverlay } from './office/components/ToolOverlay.js';
import { EditorState } from './office/editor/editorState.js';
import { EditorToolbar } from './office/editor/EditorToolbar.js';
import { OfficeState } from './office/engine/officeState.js';
import { isRotatable } from './office/layout/furnitureCatalog.js';
import { EditTool } from './office/types.js';
import {
  fetchCompanyProjects,
  getActiveCompanyId,
  subscribeActivity,
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

function App() {
  // ── Projects / bookmarks state ────────────────────────────────────────────
  // `paperclipReady` flips true once the WS handshake completes — only then
  // is `getActiveCompanyId()` populated, so project loading waits on it.
  const [paperclipReady, setPaperclipReady] = useState(false);
  const [projects, setProjects] = useState<PaperclipProject[]>([]);
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
        onStatusChange: (status) => {
          // Once connected, the company id is populated — unblock the
          // bookmarks/projects load.
          if (status.state === 'connected') {
            setPaperclipReady(true);
            // Boot the speech bridge once — it subscribes to global
            // heartbeat/activity streams and dispatches text bubbles
            // onto the office canvas. Idempotent guard: only start the
            // first time we hit `connected` for this effect.
            if (!stopSpeechBridge && !stopped) {
              stopSpeechBridge = startAgentSpeechBridge(getOfficeState);
            }
          }
          // Reflect connection status into the bootstrap banner so the operator
          // can see at a glance whether Paperclip is connected. Banner element
          // is defined in index.html (#gb-bootstrap-banner .gb-left).
          const el = document.querySelector('#gb-bootstrap-banner .gb-left');
          if (!el) return;
          const dot =
            status.state === 'connected'
              ? '🟢'
              : status.state === 'connecting'
                ? '🟡'
                : status.state === 'disconnected'
                  ? '🔴'
                  : status.state === 'no-paperclip'
                    ? '⚫'
                    : '⚪';
          el.textContent = `${dot} ${status.message}`;
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
    };
  }, []);

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
        const seeded = seedArrangement(list);
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

  // A safe fallback arrangement for the window before the real one loads.
  const effectiveArrangement: BookmarkArrangement = arrangement ?? {
    order: [GENERAL_BOOKMARK_ID],
    issuePins: [],
    activeId: GENERAL_BOOKMARK_ID,
  };

  const bookmarks = useMemo(
    () => reconcileBookmarks(effectiveArrangement, projects),
    [effectiveArrangement, projects],
  );
  const addableProjects = useMemo(
    () => availableProjects(effectiveArrangement, projects),
    [effectiveArrangement, projects],
  );
  const activeBookmarkId = effectiveArrangement.activeId;
  const activeScope = useMemo(
    () => activeScopeOf(effectiveArrangement, bookmarks),
    [effectiveArrangement, bookmarks],
  );

  // All arrangement mutators use the functional setState form so they
  // never capture a stale closure, and persist on every change.
  const onSelectBookmark = useCallback(
    (id: string) => {
      setArrangement((cur) => {
        const base = cur ?? effectiveArrangement;
        const next = { ...base, activeId: id };
        const companyId = getActiveCompanyId();
        if (companyId) saveArrangement(companyId, next);
        return next;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const onReorderBookmarks = useCallback((orderedIds: string[]) => {
    setArrangement((cur) => {
      if (!cur) return cur;
      const next = { ...cur, order: orderedIds };
      const companyId = getActiveCompanyId();
      if (companyId) saveArrangement(companyId, next);
      return next;
    });
  }, []);
  const onRemoveBookmark = useCallback((id: string) => {
    setArrangement((cur) => {
      if (!cur) return cur;
      const next: BookmarkArrangement = {
        order: cur.order.filter((o) => o !== id),
        issuePins: cur.issuePins.filter(
          (p) => issueBookmarkId(p.issueId) !== id,
        ),
        activeId:
          cur.activeId === id ? GENERAL_BOOKMARK_ID : cur.activeId,
      };
      const companyId = getActiveCompanyId();
      if (companyId) saveArrangement(companyId, next);
      return next;
    });
  }, []);
  // Add an existing project's tab to the bar (and select it).
  const onAddProject = useCallback((projectId: string) => {
    setArrangement((cur) => {
      if (!cur) return cur;
      const id = projectBookmarkId(projectId);
      if (cur.order.includes(id)) {
        return { ...cur, activeId: id };
      }
      const next = { ...cur, order: [...cur.order, id], activeId: id };
      const companyId = getActiveCompanyId();
      if (companyId) saveArrangement(companyId, next);
      return next;
    });
  }, []);

  // Pin the chat's active issue as a new issue-scope bookmark.
  const pinIssueAsBookmark = useCallback((issue: PaperclipIssue) => {
    setArrangement((cur) => {
      if (!cur) return cur;
      const id = issueBookmarkId(issue.id);
      let next: BookmarkArrangement;
      if (cur.issuePins.some((p) => p.issueId === issue.id)) {
        next = { ...cur, activeId: id };
      } else {
        const label = `${issue.identifier ?? '—'} · ${issue.title}`;
        next = {
          order: [...cur.order, id],
          issuePins: [...cur.issuePins, { issueId: issue.id, label }],
          activeId: id,
        };
      }
      const companyId = getActiveCompanyId();
      if (companyId) saveArrangement(companyId, next);
      return next;
    });
  }, []);

  // ── Project create / edit modals ──────────────────────────────────────────
  // `editingProjectId` non-null → edit modal open; `creatingProject` →
  // create modal open. Wired to the bar's ✏ and + → "new project".
  const [creatingProject, setCreatingProject] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(
    null,
  );
  // The "+" add-project modal (list of addable projects + create-new).
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  // Goals modal — independent of bookmarks; opened by the 🎯 button.
  const [goalsOpen, setGoalsOpen] = useState(false);
  // Org-chart modal — opened by the 🏢 button.
  const [orgChartOpen, setOrgChartOpen] = useState(false);
  // Agent management modal — driven by the ⚙ button in AgentActionToolbar
  // or by clicking a node in OrgChartModal. `null` = closed; otherwise
  // the agent's UUID.
  const [agentMgmtUuid, setAgentMgmtUuid] = useState<string | null>(null);
  // Assign-task modal — driven by the ➕ button in AgentActionToolbar
  // AND by the "Ask CEO" path in NewAgentDialog (which reuses this
  // modal for the issue draft instead of carrying its own form).
  const [assignTaskUuid, setAssignTaskUuid] = useState<string | null>(null);
  const [assignTaskPrefill, setAssignTaskPrefill] = useState<{
    title?: string;
    description?: string;
    contextHint?: string;
  } | null>(null);
  // Refetch projects + (for create) drop the new tab into the bar.
  const onProjectsChanged = useCallback(
    (focusProjectId?: string) => {
      void fetchCompanyProjects().then((list) => {
        setProjects(list);
        if (focusProjectId) onAddProject(focusProjectId);
      });
    },
    [onAddProject],
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

      {/* GoBoost project bookmarks — full-width scope strip below the
          connection banner. Switching a tab re-filters every agent's
          issue forest in the chat panel. */}
      <BookmarksBar
        bookmarks={bookmarks}
        activeId={activeBookmarkId}
        height={BOOKMARKS_BAR_HEIGHT}
        onSelect={onSelectBookmark}
        onReorder={onReorderBookmarks}
        onRemove={onRemoveBookmark}
        onEditProject={(projectId) => setEditingProjectId(projectId)}
        onOpenAddMenu={() => setAddMenuOpen(true)}
        onOpenGoals={() => setGoalsOpen(true)}
        onOpenOrgChart={() => setOrgChartOpen(true)}
      />

      {/* GoBoost WhatsApp Chat Panel — Iteration 2.B.1.
          Fixed right-side overlay; binds to currently-selected agent. */}
      <WhatsAppPanel
        selectedAgentId={selectedAgent}
        selectedAgentName={selectedAgentName}
        activeScope={activeScope}
        onPinIssue={pinIssueAsBookmark}
      />

      {/* Project add / create / edit modals. */}
      {addMenuOpen ? (
        <ProjectAddModal
          availableProjects={addableProjects}
          onClose={() => setAddMenuOpen(false)}
          onAddProject={(projectId) => {
            setAddMenuOpen(false);
            onAddProject(projectId);
          }}
          onCreateNew={() => {
            setAddMenuOpen(false);
            setCreatingProject(true);
          }}
        />
      ) : null}
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
          onArchived={(projectId) => {
            setEditingProjectId(null);
            onRemoveBookmark(projectBookmarkId(projectId));
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
