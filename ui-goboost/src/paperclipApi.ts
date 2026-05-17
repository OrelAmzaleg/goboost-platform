/**
 * paperclipApi.ts — GoBoost ↔ Paperclip data adapter.
 *
 * Replaces the per-agent mocks that browserMock.ts ships with by subscribing
 * to the running Paperclip backend (typically at http://localhost:3100) and
 * translating its events into the same `window.postMessage` shapes that
 * pixel-agents' useExtensionMessages hook already understands.
 *
 * What we hook into:
 *   - GET  /api/companies                            (initial bootstrap)
 *   - GET  /api/companies/:companyId/agents          (initial agent list)
 *   - WS   /api/companies/:companyId/events/ws       (live event stream)
 *
 * What we currently translate:
 *   activity.logged (entityType=agent, action=create|delete) → agentCreated/agentClosed
 *   agent.status                                              → agentStatus
 *   heartbeat.run.queued/.status                              → agentStatus (active/waiting/idle)
 *   heartbeat.run.event/.log/plugin.*                         → ignored (for now)
 *
 * Out of scope here (planned later):
 *   - tool-call-level visualization (agentToolStart/Done) — needs parsed
 *     TranscriptEntry stream from heartbeat_runs.stdoutExcerpt, not just
 *     the live event channel.
 *   - multi-company picker — we auto-pick the first company today.
 *   - mid-session reconciliation on long disconnects.
 *
 * Engine integration: pixel-agents' OfficeState uses numeric ids; Paperclip
 * uses UUIDs. We keep an in-memory bidirectional mapping (IdMapper). Refresh
 * resets the mapping, but the UUIDs are re-read from /api/agents on reconnect,
 * so the office repopulates correctly.
 */

// Empty string = same-origin (proxied through Vite to http://localhost:3100).
// For production builds or non-proxied environments, override via
// VITE_PAPERCLIP_API_URL env var (e.g. 'http://localhost:3100').
const DEFAULT_PAPERCLIP_BASE = '';
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const PAPERCLIP_PROBE_TIMEOUT_MS = 4_000;

// ── State for the banner indicator ────────────────────────────────────────

export type PaperclipConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'no-paperclip'
  | 'no-company';

export interface PaperclipStatusDetail {
  state: PaperclipConnectionState;
  companyName?: string;
  message: string;
}

export type PaperclipStatusListener = (status: PaperclipStatusDetail) => void;

// ── Types we read from Paperclip API responses ────────────────────────────

interface PaperclipCompany {
  id: string;
  name: string;
}

interface PaperclipAgent {
  id: string;
  name: string;
  status: string;
  reportsTo?: string | null;
  role?: string;
  title?: string | null;
}

interface PaperclipLiveEvent {
  id: number;
  companyId: string;
  type: string;
  createdAt: string;
  payload?: Record<string, unknown>;
}

// ── UUID ↔ numeric id mapping ─────────────────────────────────────────────
//
// pixel-agents engine was built around Claude Code agent ids that happen to
// be numbers (process pids / sequence numbers). Paperclip uses UUID strings.
// We bridge them here. Mapping is in-memory and resets on refresh — agents
// are re-listed via the API on every (re)connect, so nothing is lost.

class IdMapper {
  private uuidToId = new Map<string, number>();
  private idToUuid = new Map<number, string>();
  private nextId = 1;

  toNumeric(uuid: string): number {
    const existing = this.uuidToId.get(uuid);
    if (existing !== undefined) return existing;
    const id = this.nextId++;
    this.uuidToId.set(uuid, id);
    this.idToUuid.set(id, uuid);
    return id;
  }

  toUuid(id: number): string | undefined {
    return this.idToUuid.get(id);
  }

  forget(uuid: string): number | undefined {
    const id = this.uuidToId.get(uuid);
    if (id !== undefined) {
      this.uuidToId.delete(uuid);
      this.idToUuid.delete(id);
    }
    return id;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function dispatch(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

function wsUrlFromBase(baseUrl: string, companyId: string): string {
  // Same-origin proxy case: derive from current page origin (http→ws, https→wss).
  if (!baseUrl) {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}/api/companies/${encodeURIComponent(companyId)}/events/ws`;
  }
  const wsBase = baseUrl.replace(/^http/i, 'ws');
  return `${wsBase}/api/companies/${encodeURIComponent(companyId)}/events/ws`;
}

async function fetchJson<T>(url: string, timeoutMs?: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
    return (await r.json()) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Status translation: Paperclip → pixel-agents ──────────────────────────

/**
 * pixel-agents `agentStatus.status` semantics (from useExtensionMessages.ts):
 *   'active'   → engine treats as idle/ready (clears the status overlay,
 *                setAgentActive(id, true) drives the working animation)
 *   'waiting'  → engine shows the waiting bubble + playDoneSound()
 *   anything   → engine stores as overlay string (custom label)
 *
 * Paperclip agent.status values (from packages/db/schema/agents.ts):
 *   'idle' | 'running' | 'paused' | 'error' (and similar)
 *
 * Mapping below errs on the side of "show the character lively" — silence
 * looks broken in a visual UI.
 */
function mapPaperclipStatus(paperclipStatus: string): string {
  switch (paperclipStatus) {
    case 'running':
      return 'active'; // working animation
    case 'paused':
      return 'waiting'; // shows waiting bubble
    case 'idle':
      return 'active'; // calm/idle; engine character still breathes
    case 'error':
      return 'error'; // custom overlay
    default:
      return 'active';
  }
}

// ── Main entry point ──────────────────────────────────────────────────────

export interface StartPaperclipApiOptions {
  baseUrl?: string;
  onStatusChange?: PaperclipStatusListener;
}

export interface PaperclipApiHandle {
  stop: () => void;
}

export async function startPaperclipApi(
  opts: StartPaperclipApiOptions = {},
): Promise<PaperclipApiHandle | null> {
  const baseUrl = opts.baseUrl ?? DEFAULT_PAPERCLIP_BASE;
  const setStatus = opts.onStatusChange ?? (() => {});
  const idMapper = new IdMapper();

  // ── Step 1: probe Paperclip is alive ──
  setStatus({ state: 'connecting', message: 'בודק חיבור ל-Paperclip…' });
  let companies: PaperclipCompany[];
  try {
    companies = await fetchJson<PaperclipCompany[]>(
      `${baseUrl}/api/companies`,
      PAPERCLIP_PROBE_TIMEOUT_MS,
    );
  } catch (err) {
    console.warn('[PaperclipApi] Paperclip not reachable:', err);
    setStatus({
      state: 'no-paperclip',
      message: `Paperclip לא זמין ב-${baseUrl}. הפעל אותו עם pnpm dev.`,
    });
    return null;
  }

  // ── Step 2: pick a company (first one for MVP) ──
  if (companies.length === 0) {
    setStatus({
      state: 'no-company',
      message: 'אין companies. צור אחת ב-Paperclip ב-:3100 ורענן.',
    });
    return null;
  }
  const company = companies[0]!;
  console.log(`[PaperclipApi] Connected to company: ${company.name} (${company.id})`);

  // ── Step 3: load initial agents and seed the office ──
  let agents: PaperclipAgent[] = [];
  try {
    agents = await fetchJson<PaperclipAgent[]>(
      `${baseUrl}/api/companies/${company.id}/agents`,
    );
  } catch (err) {
    console.warn('[PaperclipApi] Failed to load initial agents:', err);
  }

  if (agents.length > 0) {
    const numericIds: number[] = [];
    const folderNames: Record<number, string> = {};
    for (const a of agents) {
      const id = idMapper.toNumeric(a.id);
      numericIds.push(id);
      folderNames[id] = a.name;
    }
    dispatch({
      type: 'existingAgents',
      agents: numericIds,
      agentMeta: {},
      folderNames,
    });
    // Apply current statuses
    for (const a of agents) {
      const mapped = mapPaperclipStatus(a.status);
      if (mapped !== 'active') {
        dispatch({
          type: 'agentStatus',
          id: idMapper.toNumeric(a.id),
          status: mapped,
        });
      }
    }
  }

  // ── Step 4: open the live WebSocket with auto-reconnect ──
  let ws: WebSocket | null = null;
  let reconnectDelay = RECONNECT_MIN_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function scheduleReconnect(): void {
    if (stopped) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      connect();
    }, reconnectDelay);
  }

  function connect(): void {
    if (stopped) return;
    const url = wsUrlFromBase(baseUrl, company.id);
    setStatus({
      state: 'connecting',
      companyName: company.name,
      message: `מתחבר ל-${company.name}…`,
    });
    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.error('[PaperclipApi] WS construct failed:', err);
      setStatus({
        state: 'disconnected',
        companyName: company.name,
        message: 'WebSocket לא נפתח — מנסה שוב…',
      });
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      console.log('[PaperclipApi] WS connected');
      reconnectDelay = RECONNECT_MIN_MS;
      setStatus({
        state: 'connected',
        companyName: company.name,
        message: `מחובר: ${company.name}`,
      });
    };

    ws.onmessage = (msg) => {
      try {
        const event = JSON.parse(String(msg.data)) as PaperclipLiveEvent;
        handleLiveEvent(event);
      } catch (err) {
        console.warn('[PaperclipApi] failed to parse message:', err);
      }
    };

    ws.onerror = (err) => {
      console.warn('[PaperclipApi] WS error:', err);
    };

    ws.onclose = (ev) => {
      console.log(`[PaperclipApi] WS closed (code=${ev.code}, reason=${ev.reason})`);
      ws = null;
      setStatus({
        state: 'disconnected',
        companyName: company.name,
        message: `WebSocket נסגר. מנסה שוב בעוד ${Math.round(reconnectDelay / 1000)}s…`,
      });
      scheduleReconnect();
    };
  }

  async function refetchAgentAndDispatchCreate(uuid: string): Promise<void> {
    try {
      const a = await fetchJson<PaperclipAgent>(`${baseUrl}/api/agents/${uuid}`);
      const numericId = idMapper.toNumeric(a.id);
      dispatch({
        type: 'agentCreated',
        id: numericId,
        folderName: a.name,
      });
      const mapped = mapPaperclipStatus(a.status);
      if (mapped !== 'active') {
        dispatch({ type: 'agentStatus', id: numericId, status: mapped });
      }
    } catch (err) {
      console.warn(`[PaperclipApi] failed to fetch new agent ${uuid}:`, err);
    }
  }

  function handleLiveEvent(event: PaperclipLiveEvent): void {
    const payload = event.payload ?? {};

    switch (event.type) {
      // ── Agent lifecycle status ──
      case 'agent.status': {
        const uuid = String(payload.agentId ?? '');
        const paperclipStatus = String(payload.status ?? '');
        if (!uuid) return;
        const mapped = mapPaperclipStatus(paperclipStatus);
        dispatch({
          type: 'agentStatus',
          id: idMapper.toNumeric(uuid),
          status: mapped,
        });
        return;
      }

      // ── A run is queued / starting / finishing ──
      // We mirror to agentStatus so the character animates while work is happening.
      case 'heartbeat.run.queued':
      case 'heartbeat.run.status': {
        const uuid = String(payload.agentId ?? '');
        const runStatus = String(payload.status ?? 'running');
        if (!uuid) return;
        const numericId = idMapper.toNumeric(uuid);
        const terminal = ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(runStatus);
        dispatch({
          type: 'agentStatus',
          id: numericId,
          status: terminal ? 'active' : 'active', // both map to 'active' until we add finer overlay
        });
        return;
      }

      // ── Activity log entries (agent created / deleted / etc.) ──
      case 'activity.logged': {
        const entityType = String(payload.entityType ?? '');
        const action = String(payload.action ?? '');
        const entityId = String(payload.entityId ?? '');
        if (entityType !== 'agent' || !entityId) return;
        // Paperclip's action vocabulary varies — match liberally
        if (/create|added|hired/i.test(action)) {
          void refetchAgentAndDispatchCreate(entityId);
        } else if (/delete|removed|terminated/i.test(action)) {
          const numericId = idMapper.forget(entityId);
          if (numericId !== undefined) {
            dispatch({ type: 'agentClosed', id: numericId });
          }
        }
        return;
      }

      // ── Intentionally ignored for v1 ──
      case 'heartbeat.run.event':
      case 'heartbeat.run.log':
      case 'plugin.ui.updated':
      case 'plugin.worker.crashed':
      case 'plugin.worker.restarted':
        return;

      default:
        // Unknown event type — surface to console for triage
        console.debug('[PaperclipApi] unhandled event:', event.type);
        return;
    }
  }

  connect();

  return {
    stop: () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        try {
          ws.close(1000, 'client stop');
        } catch {
          // ignore
        }
      }
    },
  };
}
