import { useMemo, useState } from 'react';

import { updateAgent, type OrgNode } from '../paperclipApi.js';

/**
 * OrgTreeCanvas — interactive boxes-and-lines org chart.
 *
 * Replaces the indented list that lived in OrgChartModal pre-Session-3.
 * Layout = a Reingold-Tilford-lite recursion: each node knows its own
 * card width + its subtree width (max of card width / sum of children
 * subtree widths). Children are laid out left-to-right starting at
 * `offsetX`, then the parent centers itself above the children's span.
 *
 * Connectors are drawn in a single SVG layer behind the cards. The
 * boxes themselves are absolutely-positioned HTML so they can carry
 * native drag handlers, focus rings, and per-card hover state.
 *
 * Drag-to-reparent: each card is `draggable`; dropping it onto another
 * card fires `PATCH /agents/:childId { reportsTo: targetId }` after a
 * cycle check + confirm dialog. The caller refreshes the tree on
 * success via the existing `subscribeActivity` path on agent.* events.
 */

// ── Layout constants ─────────────────────────────────────────────

const CARD_WIDTH = 188;
const CARD_HEIGHT = 76;
const GAP_X = 26;
const GAP_Y = 56;
const TREE_GAP_X = 64; // gap between separate root forests
const CANVAS_PADDING = 32;

const STATUS_DOT_COLOR: Record<string, string> = {
  active: '#22c55e',
  running: '#22c55e',
  idle: '#94a3b8',
  paused: '#f59e0b',
  error: '#ef4444',
  pending_approval: '#a855f7',
  terminated: '#475569',
};

// ── Layout types ────────────────────────────────────────────────

interface LayoutNode {
  node: OrgNode;
  subtreeWidth: number;
  children: LayoutNode[];
  x: number;
  y: number;
}

function measureSubtree(node: OrgNode): LayoutNode {
  const children = node.reports.map(measureSubtree);
  if (children.length === 0) {
    return { node, subtreeWidth: CARD_WIDTH, children: [], x: 0, y: 0 };
  }
  const childrenWidth =
    children.reduce((sum, c) => sum + c.subtreeWidth, 0) +
    GAP_X * (children.length - 1);
  return {
    node,
    subtreeWidth: Math.max(CARD_WIDTH, childrenWidth),
    children,
    x: 0,
    y: 0,
  };
}

function positionSubtree(layout: LayoutNode, offsetX: number, depth: number) {
  layout.y = depth * (CARD_HEIGHT + GAP_Y);
  if (layout.children.length === 0) {
    layout.x = offsetX + (layout.subtreeWidth - CARD_WIDTH) / 2;
    return;
  }
  let childOffsetX = offsetX;
  for (const child of layout.children) {
    positionSubtree(child, childOffsetX, depth + 1);
    childOffsetX += child.subtreeWidth + GAP_X;
  }
  const first = layout.children[0];
  const last = layout.children[layout.children.length - 1];
  // Center self above children's combined span.
  layout.x = (first.x + last.x) / 2;
}

function collectAll(layout: LayoutNode, out: LayoutNode[]) {
  out.push(layout);
  for (const c of layout.children) collectAll(c, out);
}

// All descendants of `node`, inclusive — used for the drag cycle check.
function descendantIds(node: OrgNode, out: Set<string>): Set<string> {
  out.add(node.id);
  for (const c of node.reports) descendantIds(c, out);
  return out;
}

// ── Component ───────────────────────────────────────────────────

export interface OrgTreeCanvasProps {
  roots: OrgNode[];
  /** Triggered when the operator clicks a card. */
  onSelectAgent?: (agentUuid: string) => void;
  /**
   * Called when a successful reparent PATCH lands. The caller is
   * expected to refetch the tree (the modal already does this via
   * `subscribeActivity`, so this hook is mostly for UI side-effects
   * like flashing the moved card).
   */
  onReparented?: (childId: string, newParentId: string | null) => void;
}

export function OrgTreeCanvas({
  roots,
  onSelectAgent,
  onReparented,
}: OrgTreeCanvasProps) {
  // ── Layout pass (memoized on roots) ────────────────────────────
  const { layouts, totalWidth, totalHeight } = useMemo(() => {
    const ls = roots.map((r) => measureSubtree(r));
    // Stack roots horizontally with TREE_GAP_X between forests.
    let offsetX = 0;
    let maxDepth = 0;
    for (const l of ls) {
      positionSubtree(l, offsetX, 0);
      offsetX += l.subtreeWidth + TREE_GAP_X;
      // Walk to compute max depth (for canvas height).
      const all: LayoutNode[] = [];
      collectAll(l, all);
      for (const n of all) {
        const d = Math.round(n.y / (CARD_HEIGHT + GAP_Y));
        if (d > maxDepth) maxDepth = d;
      }
    }
    return {
      layouts: ls,
      totalWidth: Math.max(CARD_WIDTH, offsetX - TREE_GAP_X),
      totalHeight: (maxDepth + 1) * (CARD_HEIGHT + GAP_Y) - GAP_Y,
    };
  }, [roots]);

  // ── Drag state (purely visual; reparent fires on drop) ─────────
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [reparenting, setReparenting] = useState(false);

  // Flat list for connector loop + drag-validation lookups.
  const flat = useMemo(() => {
    const out: LayoutNode[] = [];
    for (const l of layouts) collectAll(l, out);
    return out;
  }, [layouts]);

  // Returns the LayoutNode whose node.id matches — used during drag
  // validation to walk descendants without rebuilding the tree.
  const findInRoots = (id: string): OrgNode | null => {
    const stack = [...roots];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur.id === id) return cur;
      for (const c of cur.reports) stack.push(c);
    }
    return null;
  };

  const handleDrop = async (childId: string, newParentId: string) => {
    if (childId === newParentId) return;
    // Cycle check: target must not be a descendant of source.
    const sourceRoot = findInRoots(childId);
    if (sourceRoot) {
      const blockedIds = descendantIds(sourceRoot, new Set<string>());
      if (blockedIds.has(newParentId)) {
        window.alert('לא ניתן לעבור — היעד הוא צאצא של הסוכן שגוררים.');
        return;
      }
    }
    const childNode = findInRoots(childId);
    const parentNode = findInRoots(newParentId);
    if (!window.confirm(
      `להעביר את "${childNode?.name ?? childId.slice(0, 8)}" להיות כפוף ל-"${parentNode?.name ?? newParentId.slice(0, 8)}"?`,
    )) {
      return;
    }
    setReparenting(true);
    const ok = await updateAgent(childId, { reportsTo: newParentId });
    setReparenting(false);
    if (!ok) {
      window.alert('עדכון הכפיפות נכשל.');
      return;
    }
    onReparented?.(childId, newParentId);
  };

  if (flat.length === 0) {
    return (
      <div style={{ fontSize: 13, color: '#94a3b8', padding: '20px 0' }}>
        לא נמצאו סוכנים בארגון.
      </div>
    );
  }

  const canvasW = totalWidth + CANVAS_PADDING * 2;
  const canvasH = totalHeight + CANVAS_PADDING * 2;

  return (
    <div
      style={{
        overflow: 'auto',
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 10,
        maxHeight: '70vh',
        position: 'relative',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: canvasW,
          height: canvasH,
          // Center the tree horizontally when it's narrower than the
          // modal — overflow-auto takes over when it's wider.
          margin: '0 auto',
        }}
      >
        {/* Connector layer — SVG behind the cards. */}
        <svg
          width={canvasW}
          height={canvasH}
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
          }}
        >
          {flat.map((p) =>
            p.children.map((c) => {
              const px = p.x + CARD_WIDTH / 2 + CANVAS_PADDING;
              const py = p.y + CARD_HEIGHT + CANVAS_PADDING;
              const cx = c.x + CARD_WIDTH / 2 + CANVAS_PADDING;
              const cy = c.y + CANVAS_PADDING;
              const midY = (py + cy) / 2;
              return (
                <path
                  key={`${p.node.id}->${c.node.id}`}
                  d={`M ${px} ${py} L ${px} ${midY} L ${cx} ${midY} L ${cx} ${cy}`}
                  stroke="rgba(148,163,184,0.45)"
                  strokeWidth={1.5}
                  fill="none"
                />
              );
            }),
          )}
        </svg>

        {/* Card layer */}
        {flat.map((l) => (
          <AgentCard
            key={l.node.id}
            node={l.node}
            x={l.x + CANVAS_PADDING}
            y={l.y + CANVAS_PADDING}
            isDragging={draggingId === l.node.id}
            isDropTarget={
              dropTargetId === l.node.id && draggingId != null && draggingId !== l.node.id
            }
            reparenting={reparenting && draggingId === l.node.id}
            onSelect={() => onSelectAgent?.(l.node.id)}
            onDragStartCard={() => setDraggingId(l.node.id)}
            onDragEndCard={() => {
              setDraggingId(null);
              setDropTargetId(null);
            }}
            onDragEnterCard={() => {
              if (draggingId && draggingId !== l.node.id) {
                setDropTargetId(l.node.id);
              }
            }}
            onDragLeaveCard={() => {
              if (dropTargetId === l.node.id) setDropTargetId(null);
            }}
            onDropCard={() => {
              if (draggingId && draggingId !== l.node.id) {
                void handleDrop(draggingId, l.node.id);
              }
              setDraggingId(null);
              setDropTargetId(null);
            }}
          />
        ))}
      </div>
    </div>
  );
}

// ── Card ────────────────────────────────────────────────────────

function AgentCard({
  node,
  x,
  y,
  isDragging,
  isDropTarget,
  reparenting,
  onSelect,
  onDragStartCard,
  onDragEndCard,
  onDragEnterCard,
  onDragLeaveCard,
  onDropCard,
}: {
  node: OrgNode;
  x: number;
  y: number;
  isDragging: boolean;
  isDropTarget: boolean;
  reparenting: boolean;
  onSelect: () => void;
  onDragStartCard: () => void;
  onDragEndCard: () => void;
  onDragEnterCard: () => void;
  onDragLeaveCard: () => void;
  onDropCard: () => void;
}) {
  const [hover, setHover] = useState(false);
  const dotColor = STATUS_DOT_COLOR[node.status ?? ''] ?? '#64748b';

  const baseBorder = isDropTarget
    ? 'rgba(34,197,94,0.85)'
    : hover
      ? 'rgba(99,102,241,0.55)'
      : 'rgba(255,255,255,0.18)';
  const baseBg = isDropTarget
    ? 'rgba(34,197,94,0.18)'
    : hover
      ? 'rgba(99,102,241,0.12)'
      : 'rgba(15, 23, 42, 0.92)';

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/agent-id', node.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStartCard();
      }}
      onDragEnd={onDragEndCard}
      onDragEnter={onDragEnterCard}
      onDragOver={(e) => {
        // preventDefault required to mark the element as a drop target.
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDragLeave={onDragLeaveCard}
      onDrop={(e) => {
        e.preventDefault();
        onDropCard();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onSelect}
      title={`${node.name}${node.title ? ` — ${node.title}` : ''}`}
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        padding: '10px 12px',
        background: baseBg,
        border: `1px solid ${baseBorder}`,
        borderRadius: 10,
        color: '#e2e8f0',
        cursor: isDragging ? 'grabbing' : 'pointer',
        opacity: isDragging ? 0.5 : reparenting ? 0.7 : 1,
        boxShadow: hover
          ? '0 4px 14px rgba(0,0,0,0.45)'
          : '0 1px 3px rgba(0,0,0,0.25)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        // Help the eye understand this is grabbable.
        userSelect: 'none',
        transition: 'box-shadow 0.12s, background 0.12s, border-color 0.12s',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minWidth: 0,
        }}
      >
        {node.icon ? (
          <span style={{ fontSize: 16, flexShrink: 0 }}>{node.icon}</span>
        ) : null}
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: '50%',
            background: dotColor,
            flexShrink: 0,
            boxShadow:
              node.status === 'active' || node.status === 'running'
                ? '0 0 0 2px rgba(34,197,94,0.18)'
                : 'none',
          }}
          title={node.status ?? ''}
        />
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: '#f1f5f9',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
            minWidth: 0,
          }}
        >
          {node.name}
        </span>
      </div>
      {node.title || node.role ? (
        <div
          style={{
            fontSize: 11,
            color: '#94a3b8',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {node.title ?? node.role}
        </div>
      ) : null}
      {node.reports.length > 0 ? (
        <div
          style={{
            fontSize: 10,
            color: '#94a3b8',
            opacity: 0.85,
            marginBlockStart: 'auto',
          }}
        >
          {node.reports.length} כפיפים
        </div>
      ) : null}
    </div>
  );
}
