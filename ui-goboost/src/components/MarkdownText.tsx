import { Fragment, type ReactNode } from 'react';

/**
 * MarkdownText — minimal CommonMark subset for chat bubbles.
 *
 * Renders the markdown flavors Paperclip agents actually emit in
 * `issue_comments.body`:
 *   • `## Header` / `### Header` lines
 *   • `**bold**` / `__bold__`
 *   • `*italic*` / `_italic_`
 *   • `` `inline code` ``
 *   • ```` ```block code``` ````
 *   • `- ` / `* ` bullet lists
 *   • Plain URLs (auto-linked)
 *
 * Intentionally NOT a full markdown library — we want to keep the chat
 * panel zero-dep and predictable. Anything fancier (tables, footnotes,
 * embedded HTML) is rendered as plain text on purpose.
 */

export interface MarkdownTextProps {
  text: string;
  /** Color override for emphasized spans — defaults to the surrounding text color. */
  emphasisColor?: string;
}

// ── Block-level pass ────────────────────────────────────────────────────────

interface Block {
  kind: 'heading' | 'paragraph' | 'list' | 'code_block';
  level?: 1 | 2 | 3;
  lines: string[];
  /** For lists, each item is one logical line (already stripped of the bullet). */
}

function parseBlocks(text: string): Block[] {
  const lines = text.split(/\r?\n/);
  const blocks: Block[] = [];
  let i = 0;
  let inCode = false;
  let codeLines: string[] = [];
  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block
    if (line.trim().startsWith('```')) {
      if (!inCode) {
        inCode = true;
        codeLines = [];
      } else {
        blocks.push({ kind: 'code_block', lines: codeLines });
        inCode = false;
      }
      i++;
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      i++;
      continue;
    }

    // Heading
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1]!.length as 1 | 2 | 3,
        lines: [heading[2] ?? ''],
      });
      i++;
      continue;
    }

    // List (consume consecutive bullet lines)
    if (/^\s*[-*]\s+/.test(line)) {
      const listLines: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? '')) {
        listLines.push(lines[i]!.replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'list', lines: listLines });
      continue;
    }

    // Blank line — block boundary, skip.
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph (consume until blank or block boundary).
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^(#{1,3})\s+/.test(lines[i] ?? '') &&
      !/^\s*[-*]\s+/.test(lines[i] ?? '') &&
      !lines[i]!.trim().startsWith('```')
    ) {
      paraLines.push(lines[i]!);
      i++;
    }
    blocks.push({ kind: 'paragraph', lines: paraLines });
  }
  // Unterminated code fence — render what we have.
  if (inCode && codeLines.length > 0) {
    blocks.push({ kind: 'code_block', lines: codeLines });
  }
  return blocks;
}

// ── Inline pass (bold / italic / code / links) ──────────────────────────────

function renderInline(
  text: string,
  emphasisColor?: string,
  keyPrefix: string = 'i',
): ReactNode[] {
  // Regex captures any of the inline forms in order.
  // Note: keep this conservative — overlapping patterns are intentional.
  const pattern =
    /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|`[^`]+`|\bhttps?:\/\/[^\s)]+)/g;
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    const key = `${keyPrefix}-${idx++}`;
    if (token.startsWith('**') && token.endsWith('**')) {
      parts.push(
        <strong key={key} style={{ color: emphasisColor, fontWeight: 800 }}>
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith('__') && token.endsWith('__')) {
      parts.push(
        <strong key={key} style={{ color: emphasisColor, fontWeight: 800 }}>
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith('*') && token.endsWith('*')) {
      parts.push(
        <em key={key} style={{ fontStyle: 'italic' }}>
          {token.slice(1, -1)}
        </em>,
      );
    } else if (token.startsWith('_') && token.endsWith('_')) {
      parts.push(
        <em key={key} style={{ fontStyle: 'italic' }}>
          {token.slice(1, -1)}
        </em>,
      );
    } else if (token.startsWith('`') && token.endsWith('`')) {
      parts.push(
        <code
          key={key}
          style={{
            background: 'rgba(0,0,0,0.22)',
            padding: '1px 5px',
            borderRadius: 3,
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: '0.92em',
          }}
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (/^https?:\/\//.test(token)) {
      parts.push(
        <a
          key={key}
          href={token}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'inherit', textDecoration: 'underline' }}
        >
          {token}
        </a>,
      );
    } else {
      parts.push(token);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

// ── Block renderer ──────────────────────────────────────────────────────────

export function MarkdownText({ text, emphasisColor }: MarkdownTextProps) {
  const blocks = parseBlocks(text);
  return (
    <>
      {blocks.map((block, bi) => {
        if (block.kind === 'heading') {
          const Tag = (block.level === 1 ? 'h3' : block.level === 2 ? 'h4' : 'h5') as
            | 'h3'
            | 'h4'
            | 'h5';
          const fontSize =
            block.level === 1 ? '1.2em' : block.level === 2 ? '1.1em' : '1em';
          return (
            <Tag
              key={bi}
              style={{
                margin: '6px 0 2px',
                fontSize,
                fontWeight: 800,
                lineHeight: 1.3,
                color: emphasisColor,
              }}
            >
              {renderInline(block.lines.join(' '), emphasisColor, `h${bi}`)}
            </Tag>
          );
        }
        if (block.kind === 'list') {
          return (
            <ul
              key={bi}
              style={{
                margin: '4px 0',
                paddingInlineStart: 22,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              {block.lines.map((item, li) => (
                <li key={li} style={{ lineHeight: 1.5 }}>
                  {renderInline(item, emphasisColor, `l${bi}-${li}`)}
                </li>
              ))}
            </ul>
          );
        }
        if (block.kind === 'code_block') {
          return (
            <pre
              key={bi}
              style={{
                margin: '6px 0',
                padding: '8px 10px',
                background: 'rgba(0,0,0,0.3)',
                borderRadius: 6,
                fontFamily:
                  'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                fontSize: '0.88em',
                lineHeight: 1.45,
                overflowX: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              <code>{block.lines.join('\n')}</code>
            </pre>
          );
        }
        // paragraph
        return (
          <p
            key={bi}
            style={{
              margin: bi === 0 ? 0 : '4px 0 0',
              lineHeight: 1.55,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {block.lines.map((ln, li) => (
              <Fragment key={li}>
                {li > 0 ? <br /> : null}
                {renderInline(ln, emphasisColor, `p${bi}-${li}`)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}
