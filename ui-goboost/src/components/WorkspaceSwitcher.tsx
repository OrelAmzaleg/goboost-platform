import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  companyAssetUrl,
  type PaperclipCompany,
  type PaperclipCompanyStats,
} from '../paperclipApi.js';

/**
 * WorkspaceSwitcher — the top-banner chip that shows the active
 * company and (on click) drops down a list of all other companies +
 * a "+ workspace חדש" CTA + a "⚙ הגדרות החברה" link.
 *
 * Mounted via `createPortal` into `#gb-bootstrap-banner .gb-left`
 * (the span that previously held the raw connection text). This
 * keeps the React state cleanly inside the app while the DOM anchor
 * stays in index.html where the banner already lives.
 *
 * Selecting a company fires `onSwitch(companyId)` — App.tsx is
 * responsible for the tear-down + rebootstrap dance. Selecting the
 * already-active company is a no-op.
 */

const STATUS_DOT_COLOR: Record<string, string> = {
  active: '#22c55e',
  paused: '#f59e0b',
  archived: '#475569',
};

const STATUS_LABEL: Record<string, string> = {
  active: 'פעילה',
  paused: 'מושהית',
  archived: 'בארכיון',
};

export interface WorkspaceSwitcherProps {
  /** All companies the user has access to. */
  companies: PaperclipCompany[];
  /** Currently-active company id (matches `getActiveCompanyId()`). */
  activeCompanyId: string | null;
  /** Optional per-company stats for the dropdown subtitle (agent/issue counts). */
  stats?: Record<string, PaperclipCompanyStats>;
  /** Connection status string from `startPaperclipApi` — for the leading dot. */
  connectionState: 'connecting' | 'connected' | 'disconnected' | 'no-paperclip' | string;
  /** Switch active company (App.tsx handles tear-down). */
  onSwitch: (companyId: string) => void;
  /** Open the company-creation wizard. */
  onCreateNew: () => void;
  /**
   * Open the company-settings modal for a SPECIFIC company. Triggered
   * by the per-row ⚙ on hover — doesn't have to be the active company.
   */
  onOpenSettings: (companyId: string) => void;
  /**
   * Permanently delete a company (per-row 🗑 on hover). Caller is
   * responsible for the confirm dialog — keep it strict.
   */
  onDeleteCompany: (companyId: string) => void;
}

export function WorkspaceSwitcher(props: WorkspaceSwitcherProps) {
  // Find the banner anchor once — it lives in index.html, so it's
  // always there. Bail gracefully if (e.g.) we're inside a test
  // without the host page.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const el = document.querySelector(
      '#gb-bootstrap-banner .gb-left',
    ) as HTMLElement | null;
    if (el) {
      // Clear any prior `textContent` from the old status-string writer
      // so React owns the children of this span from now on.
      el.textContent = '';
    }
    setAnchor(el);
  }, []);

  if (!anchor) return null;
  return createPortal(<SwitcherChip {...props} />, anchor);
}

function SwitcherChip({
  companies,
  activeCompanyId,
  stats,
  connectionState,
  onSwitch,
  onCreateNew,
  onOpenSettings,
  onDeleteCompany,
}: WorkspaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  const active = companies.find((c) => c.id === activeCompanyId) ?? null;
  const dot =
    connectionState === 'connected'
      ? '🟢'
      : connectionState === 'connecting'
        ? '🟡'
        : connectionState === 'no-paperclip'
          ? '⚫'
          : '🔴';

  // Click-outside to close.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Sort: active first, then alphabetically, archived last.
  const sorted = useMemo(() => {
    const inactiveStatus = (s?: string) => (s === 'archived' ? 2 : 1);
    return [...companies].sort((a, b) => {
      if (a.id === activeCompanyId) return -1;
      if (b.id === activeCompanyId) return 1;
      const sa = inactiveStatus(a.status);
      const sb = inactiveStatus(b.status);
      if (sa !== sb) return sa - sb;
      return a.name.localeCompare(b.name, 'he');
    });
  }, [companies, activeCompanyId]);

  return (
    <div
      ref={ref}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          background: hover || open
            ? 'rgba(255,255,255,0.18)'
            : 'rgba(255,255,255,0.08)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 999,
          color: '#fff',
          cursor: 'pointer',
          fontSize: 12,
          fontWeight: 600,
          fontFamily: 'inherit',
          maxWidth: 360,
        }}
      >
        <span style={{ fontSize: 11 }}>{dot}</span>
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {active?.name ?? 'אין workspace'}
        </span>
        <span style={{ opacity: 0.7, fontSize: 10 }}>▼</span>
      </button>

      {open ? (
        <div
          dir="rtl"
          // Positioned relative to the chip wrapper (which is
          // `position: relative` above) so the panel anchors right
          // below the button regardless of where the banner places
          // the switcher. `left: 0` (physical) pins the dropdown's
          // visual-left edge to the button's visual-left edge.
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            left: 0,
            zIndex: 10000,
            background: '#0f172a',
            border: '1px solid rgba(255,255,255,0.18)',
            borderRadius: 10,
            boxShadow: '0 10px 26px rgba(0,0,0,0.6)',
            color: '#e2e8f0',
            fontFamily: "'Heebo', system-ui, -apple-system, sans-serif",
            minWidth: 320,
            maxWidth: 420,
            maxHeight: '70vh',
            overflow: 'auto',
            padding: 4,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {sorted.length === 0 ? (
            <div
              style={{
                fontSize: 12,
                color: '#94a3b8',
                padding: '14px 12px',
                textAlign: 'center',
              }}
            >
              עדיין אין workspaces. צור את הראשון.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {sorted.map((c) => (
                <CompanyRow
                  key={c.id}
                  company={c}
                  active={c.id === activeCompanyId}
                  stat={stats?.[c.id]}
                  onClick={() => {
                    if (c.id !== activeCompanyId) {
                      onSwitch(c.id);
                    }
                    setOpen(false);
                  }}
                  onOpenSettings={() => {
                    setOpen(false);
                    onOpenSettings(c.id);
                  }}
                  onDelete={() => {
                    setOpen(false);
                    onDeleteCompany(c.id);
                  }}
                />
              ))}
            </div>
          )}

          {/* Footer — only the "+ workspace" action; settings/delete
              moved to per-row hover buttons (one action per company). */}
          <div
            style={{
              borderBlockStart: '1px solid rgba(255,255,255,0.08)',
              marginBlockStart: 4,
              paddingBlockStart: 4,
            }}
          >
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onCreateNew();
              }}
              style={{
                width: '100%',
                padding: '8px 10px',
                fontSize: 12,
                fontWeight: 700,
                borderRadius: 7,
                border: '1px solid rgba(34,197,94,0.55)',
                background: 'rgba(34,197,94,0.18)',
                color: '#dcfce7',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              + workspace חדש
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CompanyRow({
  company,
  active,
  stat,
  onClick,
  onOpenSettings,
  onDelete,
}: {
  company: PaperclipCompany;
  active: boolean;
  stat?: PaperclipCompanyStats;
  onClick: () => void;
  onOpenSettings: () => void;
  onDelete: () => void;
}) {
  const [hover, setHover] = useState(false);
  const statusColor =
    STATUS_DOT_COLOR[company.status ?? 'active'] ?? '#64748b';
  const isArchived = company.status === 'archived';
  const logo = companyAssetUrl(company.logoAssetId);
  return (
    // Row is a div (not button) so the inner ⚙ / 🗑 buttons can sit
    // inside without invalid nested-button HTML. Click on the row
    // body still switches the company.
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px',
        background: active
          ? 'rgba(99,102,241,0.22)'
          : hover
            ? 'rgba(255,255,255,0.06)'
            : 'transparent',
        border: `1px solid ${active ? 'rgba(99,102,241,0.55)' : 'transparent'}`,
        borderRadius: 7,
        cursor: 'pointer',
        color: '#e2e8f0',
        fontFamily: 'inherit',
        textAlign: 'inherit',
        width: '100%',
        opacity: isArchived ? 0.55 : 1,
        userSelect: 'none',
      }}
    >
      {/* Logo or brand dot */}
      {logo ? (
        <img
          src={logo}
          alt=""
          style={{
            width: 26,
            height: 26,
            borderRadius: 6,
            background: company.brandColor ?? '#1e293b',
            objectFit: 'cover',
            flexShrink: 0,
          }}
        />
      ) : (
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: 6,
            background: company.brandColor ?? '#475569',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontWeight: 700,
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          {company.name.slice(0, 1).toUpperCase()}
        </span>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {company.name}
          </span>
          {company.status && company.status !== 'active' ? (
            <span
              style={{
                fontSize: 9,
                padding: '1px 5px',
                borderRadius: 999,
                background: `${statusColor}33`,
                color: statusColor,
                fontWeight: 700,
              }}
            >
              {STATUS_LABEL[company.status] ?? company.status}
            </span>
          ) : null}
        </div>
        {stat && (stat.agentCount != null || stat.issueCount != null) ? (
          <div style={{ fontSize: 10, color: '#94a3b8', marginBlockStart: 2 }}>
            {stat.agentCount != null ? `${stat.agentCount} סוכנים` : ''}
            {stat.agentCount != null && stat.issueCount != null ? ' · ' : ''}
            {stat.issueCount != null ? `${stat.issueCount} משימות` : ''}
          </div>
        ) : null}
      </div>
      {/* Right-side cluster: hover reveals ⚙ + 🗑; else show "פעיל" if active. */}
      {hover ? (
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenSettings();
            }}
            title="הגדרות החברה"
            aria-label="הגדרות החברה"
            style={{
              width: 26,
              height: 26,
              padding: 0,
              borderRadius: 6,
              border: '1px solid rgba(255,255,255,0.18)',
              background: 'rgba(255,255,255,0.08)',
              color: '#cbd5e1',
              cursor: 'pointer',
              fontSize: 13,
              lineHeight: 1,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'inherit',
            }}
          >
            ⚙
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title="מחק חברה"
            aria-label="מחק חברה"
            style={{
              width: 26,
              height: 26,
              padding: 0,
              borderRadius: 6,
              border: '1px solid rgba(239,68,68,0.45)',
              background: 'rgba(239,68,68,0.15)',
              color: '#fca5a5',
              cursor: 'pointer',
              fontSize: 13,
              lineHeight: 1,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'inherit',
            }}
          >
            🗑
          </button>
        </div>
      ) : active ? (
        <span
          style={{
            fontSize: 10,
            color: '#c7d2fe',
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          פעיל
        </span>
      ) : null}
    </div>
  );
}
