import { getAgentName, type PaperclipComment } from '../paperclipApi.js';
import { MarkdownText } from './MarkdownText.js';

/**
 * SystemNoticeCard — Stream 1 / Primitive #3 from CHAT_PANEL_DESIGN.md.
 *
 * Renders an `issue_comments` row whose `presentation.kind === "system_notice"`.
 * These are NOT dialog bubbles — they're alert-styled cards with a tone color,
 * optional title, body markdown, and structured metadata rows that the agent
 * (or system) wanted to surface as one coherent notice.
 *
 * Examples in the wild:
 *   • "Paperclip needs a disposition before this issue can continue."
 *   • "Run completed with errors" + run_link metadata row.
 *   • "Plan document updated" + a run_link to the source run.
 */

export interface SystemNoticeCardProps {
  comment: PaperclipComment;
  /** Pass-through `size(n)` so typography stays in sync with the chat panel. */
  size: (base: number) => number;
  formatTime: (iso: string) => string;
}

// Tone → palette mapping. Aligned with Paperclip's tone vocabulary:
//   neutral / info / success / warning / danger
const TONE: Record<
  string,
  { bg: string; border: string; icon: string; text: string; titleText: string }
> = {
  neutral: {
    bg: 'rgba(71,85,105,0.35)',
    border: 'rgba(148,163,184,0.5)',
    icon: 'ℹ',
    text: '#e2e8f0',
    titleText: '#f1f5f9',
  },
  info: {
    bg: 'rgba(59,130,246,0.22)',
    border: 'rgba(96,165,250,0.55)',
    icon: 'ℹ',
    text: '#dbeafe',
    titleText: '#eff6ff',
  },
  success: {
    bg: 'rgba(34,197,94,0.22)',
    border: 'rgba(74,222,128,0.55)',
    icon: '✓',
    text: '#dcfce7',
    titleText: '#f0fdf4',
  },
  warning: {
    bg: 'rgba(245,158,11,0.22)',
    border: 'rgba(251,191,36,0.55)',
    icon: '⚠',
    text: '#fef3c7',
    titleText: '#fffbeb',
  },
  danger: {
    bg: 'rgba(220,38,38,0.22)',
    border: 'rgba(248,113,113,0.55)',
    icon: '✕',
    text: '#fecaca',
    titleText: '#fef2f2',
  },
};

function pickTone(tone: string | undefined | null) {
  return TONE[tone ?? 'neutral'] ?? TONE.neutral!;
}

export function SystemNoticeCard({ comment, size, formatTime }: SystemNoticeCardProps) {
  const tone = pickTone(comment.presentation?.tone);
  const title = comment.presentation?.title ?? null;
  const sections = comment.metadata?.sections ?? [];
  const hasBody = comment.body && comment.body.trim().length > 0;

  return (
    <div
      style={{
        alignSelf: 'stretch',
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        borderRadius: 10,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        color: tone.text,
        fontSize: size(13),
        lineHeight: 1.5,
        boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span
          aria-hidden
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            background: tone.border,
            color: '#0f172a',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: size(12),
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {tone.icon}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          {title ? (
            <div
              style={{
                color: tone.titleText,
                fontWeight: 700,
                fontSize: size(14),
                marginBottom: hasBody || sections.length > 0 ? 4 : 0,
              }}
            >
              {title}
            </div>
          ) : null}
          {hasBody ? (
            <div style={{ wordBreak: 'break-word' }}>
              <MarkdownText text={comment.body} emphasisColor={tone.titleText} />
            </div>
          ) : null}
        </div>
      </div>

      {/* Metadata sections — text, code, key-value, links. Each section is
          rendered as a small inset block with its rows stacked. */}
      {sections.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginInlineStart: 30 }}>
          {sections.map((section, sectionIdx) => (
            <div
              key={sectionIdx}
              style={{
                background: 'rgba(0,0,0,0.22)',
                borderRadius: 6,
                padding: '6px 8px',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              {section.title ? (
                <div
                  style={{
                    fontSize: size(11),
                    opacity: 0.75,
                    fontWeight: 600,
                    letterSpacing: 0.3,
                    marginBottom: 2,
                  }}
                >
                  {section.title}
                </div>
              ) : null}
              {section.rows.map((row, rowIdx) => (
                <MetadataRow key={rowIdx} row={row} size={size} />
              ))}
            </div>
          ))}
        </div>
      ) : null}

      <div
        style={{
          fontSize: size(10),
          opacity: 0.55,
          textAlign: 'start',
          marginInlineStart: 30,
        }}
      >
        {formatTime(comment.createdAt)}
      </div>
    </div>
  );
}

// ── Row renderers per metadata row type ───────────────────────────────────

function MetadataRow({
  row,
  size,
}: {
  row: NonNullable<PaperclipComment['metadata']>['sections'][number]['rows'][number];
  size: (base: number) => number;
}) {
  const labelStyle: React.CSSProperties = {
    fontSize: size(11),
    opacity: 0.7,
    fontWeight: 600,
    marginInlineEnd: 4,
  };

  switch (row.type) {
    case 'text':
      return (
        <div style={{ fontSize: size(12), lineHeight: 1.5 }}>
          {row.label ? <span style={labelStyle}>{row.label}:</span> : null}
          <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{row.text}</span>
        </div>
      );

    case 'code':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {row.label ? <span style={labelStyle}>{row.label}:</span> : null}
          <pre
            style={{
              margin: 0,
              padding: '6px 8px',
              background: 'rgba(0,0,0,0.35)',
              borderRadius: 4,
              fontSize: size(11),
              lineHeight: 1.45,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              overflowX: 'auto',
            }}
          >
            <code>{row.code}</code>
          </pre>
          {row.language ? (
            <span style={{ fontSize: size(10), opacity: 0.55, fontStyle: 'italic' }}>
              {row.language}
            </span>
          ) : null}
        </div>
      );

    case 'key_value':
      return (
        <div style={{ fontSize: size(12), display: 'flex', gap: 4 }}>
          <span style={{ ...labelStyle, marginInlineEnd: 0 }}>{row.label}:</span>
          <span style={{ wordBreak: 'break-word' }}>{row.value}</span>
        </div>
      );

    case 'issue_link': {
      const display = row.title ?? row.identifier ?? row.issueId ?? '—';
      return (
        <div style={{ fontSize: size(12), display: 'flex', alignItems: 'center', gap: 4 }}>
          {row.label ? <span style={labelStyle}>{row.label}:</span> : null}
          <span
            style={{
              background: 'rgba(99,102,241,0.3)',
              padding: '2px 6px',
              borderRadius: 4,
              fontWeight: 700,
              fontSize: size(11),
              letterSpacing: 0.3,
            }}
          >
            {row.identifier ?? '—'}
          </span>
          <span style={{ wordBreak: 'break-word' }}>{display}</span>
        </div>
      );
    }

    case 'agent_link': {
      const display = row.name ?? getAgentName(row.agentId) ?? row.agentId.slice(0, 8);
      return (
        <div style={{ fontSize: size(12), display: 'flex', alignItems: 'center', gap: 4 }}>
          {row.label ? <span style={labelStyle}>{row.label}:</span> : null}
          <span>👤</span>
          <span style={{ fontWeight: 600 }}>{display}</span>
        </div>
      );
    }

    case 'run_link': {
      const display = row.title ?? `run ${row.runId.slice(0, 8)}`;
      return (
        <div style={{ fontSize: size(12), display: 'flex', alignItems: 'center', gap: 4 }}>
          {row.label ? <span style={labelStyle}>{row.label}:</span> : null}
          <span>⚙</span>
          <span style={{ fontStyle: 'italic', opacity: 0.85 }}>{display}</span>
        </div>
      );
    }

    default:
      // Unknown row type — surface a small hint so we notice new variants
      // when Paperclip adds them, without breaking the render.
      return (
        <div style={{ fontSize: size(11), opacity: 0.5, fontStyle: 'italic' }}>
          [unknown metadata row]
        </div>
      );
  }
}
