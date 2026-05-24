import { useEffect, useState } from 'react';

import {
  fetchCompanyOrg,
  numericIdForAgentUuid,
  subscribeActivity,
  type OrgNode,
} from '../paperclipApi.js';
import { NewAgentDialog } from './NewAgentDialog.js';
import { OrgTreeCanvas } from './OrgTreeCanvas.js';
import { ModalShell, primaryBtn } from './ProjectCreateModal.js';

/**
 * OrgChartModal — interactive boxes-and-lines org tree.
 *
 * Session 3 rewrite — the indented list is gone. `OrgTreeCanvas`
 * lays out cards horizontally per level with SVG connectors between
 * parents and children. Clicking a card focuses the agent in the
 * office canvas + opens its management modal (caller's responsibility
 * via `onSelectAgent`). Dragging a card onto another reparents the
 * `reportsTo` link (PATCH lives inside the canvas).
 *
 * A "+ סוכן חדש" button in the header opens the two-step NewAgentDialog
 * mirror of Paperclip's flow: ask-the-CEO OR self-create.
 */

export interface OrgChartModalProps {
  onClose: () => void;
  /**
   * Bring a specific agent into focus in the office canvas. Called when
   * an agent card is clicked. App.tsx also opens the AgentManagementModal
   * for that agent (cross-link wired in Phase 3.E).
   */
  onSelectAgent?: (agentUuid: string, numericId: number) => void;
  /**
   * "Ask CEO" handler — invoked by NewAgentDialog when the operator
   * picks the CEO path. App.tsx opens AssignTaskModal pre-populated
   * with the agent-creation request rather than us drawing our own
   * composer. The dialog itself closes immediately after the call.
   */
  onAskCeo?: (ceoUuid: string, ceoName: string | null) => void;
}

export function OrgChartModal({
  onClose,
  onSelectAgent,
  onAskCeo,
}: OrgChartModalProps) {
  const [roots, setRoots] = useState<OrgNode[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newAgentOpen, setNewAgentOpen] = useState(false);

  // Initial + activity-driven refresh. We refetch on any `agent.*`
  // activity (create/delete/reparent) so the tree stays current
  // without manual reload — drag-to-reparent in OrgTreeCanvas relies
  // on this loop to redraw after its PATCH lands.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      setLoading(true);
      void fetchCompanyOrg().then((tree) => {
        if (cancelled) return;
        if (tree == null) {
          setError('לא ניתן לטעון את המבנה הארגוני.');
          setRoots([]);
        } else {
          setError(null);
          setRoots(tree);
        }
        setLoading(false);
      });
    };
    load();
    const unsub = subscribeActivity((payload) => {
      const et = String(payload.entityType ?? '');
      if (et !== 'agent') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, 600);
    });
    return () => {
      cancelled = true;
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);

  const onClickAgent = (uuid: string) => {
    const numId = numericIdForAgentUuid(uuid);
    if (numId == null) return;
    onSelectAgent?.(uuid, numId);
  };

  return (
    <>
      <ModalShell title="מבנה ארגוני" onClose={onClose} xlarge>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Header strip — "+ agent" + hint text. Pinned above the
              tree so it's always visible regardless of scroll. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              borderBlockEnd: '1px solid rgba(255,255,255,0.1)',
              paddingBlockEnd: 10,
              flexWrap: 'wrap',
            }}
          >
            <button
              type="button"
              onClick={() => setNewAgentOpen(true)}
              style={{
                ...primaryBtn,
                padding: '6px 14px',
                fontSize: 12,
              }}
            >
              + סוכן חדש
            </button>
            <span
              style={{
                fontSize: 11,
                color: '#94a3b8',
                opacity: 0.8,
              }}
            >
              גרור סוכן אל כרטיס אחר כדי לשנות כפיפות · קליק על כרטיס פותח את
              ניהול הסוכן
            </span>
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
              טוען היררכיה…
            </div>
          ) : (
            <OrgTreeCanvas
              roots={roots ?? []}
              onSelectAgent={onClickAgent}
            />
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" onClick={onClose} style={primaryBtn}>
              סגור
            </button>
          </div>
        </div>
      </ModalShell>
      {newAgentOpen ? (
        <NewAgentDialog
          onClose={() => setNewAgentOpen(false)}
          onCreated={() => {
            // No explicit refresh — `subscribeActivity` above fires on
            // agent.create and reloads the tree.
            setNewAgentOpen(false);
          }}
          onAskCeo={(ceoUuid, ceoName) => {
            // Hand off to App.tsx (which owns AssignTaskModal). Close
            // ourselves so the operator isn't stacked three modals deep.
            setNewAgentOpen(false);
            onAskCeo?.(ceoUuid, ceoName);
          }}
        />
      ) : null}
    </>
  );
}
