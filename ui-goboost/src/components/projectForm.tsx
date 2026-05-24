/**
 * projectForm — shared form parts for the project create + edit modals.
 *
 * Keeps the status vocabulary, color palette, and the three reusable
 * controls (status select, color picker, goal multi-select) in one place
 * so the two modals stay consistent.
 */

import type { PaperclipGoal } from '../paperclipApi.js';

export const PROJECT_STATUSES: { value: string; label: string }[] = [
  { value: 'backlog', label: 'תור' },
  { value: 'planned', label: 'מתוכנן' },
  { value: 'in_progress', label: 'בעבודה' },
  { value: 'completed', label: 'הושלם' },
  { value: 'cancelled', label: 'בוטל' },
];

export function projectStatusLabel(status: string): string {
  return PROJECT_STATUSES.find((s) => s.value === status)?.label ?? status;
}

export const PROJECT_COLORS = [
  '#6366f1',
  '#0ea5e9',
  '#22c55e',
  '#f59e0b',
  '#ef4444',
  '#a855f7',
  '#ec4899',
  '#14b8a6',
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
  background: 'rgba(255,255,255,0.06)',
  color: '#f1f5f9',
  fontFamily: 'inherit',
  fontSize: 13,
  outline: 'none',
};

// ── Status select ───────────────────────────────────────────────────────────

export function StatusSelect({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={labelStyle}>סטטוס</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{
          ...fieldStyle,
          background: '#1e293b',
          colorScheme: 'dark',
        }}
      >
        {PROJECT_STATUSES.map((s) => (
          <option
            key={s.value}
            value={s.value}
            style={{ background: '#1e293b', color: '#f1f5f9' }}
          >
            {s.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// ── Color picker ─────────────────────────────────────────────────────────────

export function ColorPicker({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={labelStyle}>צבע</span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {PROJECT_COLORS.map((c) => {
          const selected = value === c;
          return (
            <button
              key={c}
              type="button"
              disabled={disabled}
              onClick={() => onChange(c)}
              aria-label={`צבע ${c}`}
              style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                background: c,
                border: selected
                  ? '2px solid #fff'
                  : '2px solid rgba(255,255,255,0.15)',
                cursor: disabled ? 'not-allowed' : 'pointer',
                outline: selected ? `2px solid ${c}` : 'none',
                padding: 0,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── Goal multi-select ────────────────────────────────────────────────────────

export function GoalMultiSelect({
  goals,
  selected,
  onToggle,
  disabled,
}: {
  goals: PaperclipGoal[];
  selected: string[];
  onToggle: (goalId: string) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={labelStyle}>מטרות (Goals)</span>
      {goals.length === 0 ? (
        <div
          style={{
            fontSize: 12,
            opacity: 0.55,
            fontStyle: 'italic',
            padding: '6px 10px',
            border: '1px dashed rgba(255,255,255,0.1)',
            borderRadius: 8,
          }}
        >
          אין מטרות מוגדרות בחברה.
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
            maxHeight: 140,
            overflowY: 'auto',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 8,
            padding: 6,
          }}
        >
          {goals.map((g) => {
            const isSel = selected.includes(g.id);
            return (
              <button
                key={g.id}
                type="button"
                disabled={disabled}
                onClick={() => onToggle(g.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '5px 8px',
                  background: isSel
                    ? 'rgba(34,197,94,0.18)'
                    : 'transparent',
                  border: isSel
                    ? '1px solid rgba(74,222,128,0.5)'
                    : '1px solid transparent',
                  borderRadius: 6,
                  color: '#e2e8f0',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  textAlign: 'start',
                  fontFamily: 'inherit',
                  fontSize: 12,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 3,
                    flexShrink: 0,
                    border: isSel
                      ? '1px solid #4ade80'
                      : '1px solid rgba(255,255,255,0.3)',
                    background: isSel ? '#22c55e' : 'transparent',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#0f172a',
                    fontSize: 10,
                    fontWeight: 900,
                  }}
                >
                  {isSel ? '✓' : ''}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {g.title}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Shared text inputs ───────────────────────────────────────────────────────

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={labelStyle}>{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        style={fieldStyle}
      />
    </label>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={labelStyle}>{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        rows={rows}
        style={{ ...fieldStyle, resize: 'vertical', minHeight: 60 }}
      />
    </label>
  );
}

export function DateField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={labelStyle}>{label}</span>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{ ...fieldStyle, background: '#1e293b', colorScheme: 'dark' }}
      />
    </label>
  );
}
