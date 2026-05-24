import {
  attachmentByteSize,
  attachmentContentUrl,
  attachmentFilename,
  attachmentMimeType,
  type PaperclipAttachment,
} from '../paperclipApi.js';
import { humanBytes, iconForMime } from './attachmentHelpers.js';

/**
 * AttachmentChip — Stream 5 / Primitives #8 (inline) and #9 (standalone).
 *
 * Renders a Paperclip `issue_attachments` row. Image MIME types preview
 * inline (small thumbnail + filename + download link); other types render
 * as a file chip with icon, filename, size, and a download link.
 *
 * Two presentation modes — selected by the caller:
 *   • `inline`     — used as a "tail" under a chat bubble. Compact, narrow.
 *   • `standalone` — used in the merged timeline when the attachment is not
 *                    owned by any specific comment. Wider, alert-styled.
 *
 * The actual content URL is `/api/attachments/:id/content` — produced by
 * `attachmentContentUrl(id)` in paperclipApi.
 */

export interface AttachmentChipProps {
  attachment: PaperclipAttachment;
  mode: 'inline' | 'standalone';
  size: (base: number) => number;
  formatTime?: (iso: string) => string;
}

// Icon + size helpers now live in `./attachmentHelpers.ts` so the upload
// form, chips, and Tasks Panel all use the same vocabulary.

export function AttachmentChip({ attachment, mode, size, formatTime }: AttachmentChipProps) {
  const filename = attachmentFilename(attachment);
  const mime = attachmentMimeType(attachment);
  const bytes = attachmentByteSize(attachment);
  const url = attachmentContentUrl(attachment.id);
  const isImage = mime.startsWith('image/');

  // ── Inline mode — small tail under a chat bubble. ──
  if (mode === 'inline') {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        download={filename}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px',
          background: 'rgba(0,0,0,0.15)',
          border: '1px solid rgba(0,0,0,0.18)',
          borderRadius: 6,
          color: 'inherit',
          textDecoration: 'none',
          fontSize: size(11),
          maxWidth: '100%',
        }}
        title={`${filename}${humanBytes(bytes) ? ` · ${humanBytes(bytes)}` : ''}`}
      >
        {isImage ? (
          <img
            src={url}
            alt={filename}
            style={{
              width: 36,
              height: 36,
              objectFit: 'cover',
              borderRadius: 4,
              flexShrink: 0,
            }}
          />
        ) : (
          <span aria-hidden style={{ fontSize: size(13), flexShrink: 0 }}>
            {iconForMime(mime)}
          </span>
        )}
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontWeight: 600,
          }}
        >
          {filename}
        </span>
        {humanBytes(bytes) ? (
          <span style={{ opacity: 0.65, flexShrink: 0 }}>{humanBytes(bytes)}</span>
        ) : null}
      </a>
    );
  }

  // ── Standalone mode — distinct row in the chat timeline. ──
  return (
    <div
      style={{
        alignSelf: 'stretch',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
        background: 'rgba(15,23,42,0.7)',
        border: '1px solid rgba(99,102,241,0.4)',
        borderRadius: 10,
        color: '#e2e8f0',
        fontSize: size(13),
      }}
    >
      {isImage ? (
        <img
          src={url}
          alt={filename}
          style={{
            width: 48,
            height: 48,
            objectFit: 'cover',
            borderRadius: 6,
            flexShrink: 0,
          }}
        />
      ) : (
        <span
          aria-hidden
          style={{
            width: 40,
            height: 40,
            borderRadius: 8,
            background: 'rgba(99,102,241,0.25)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: size(20),
            flexShrink: 0,
          }}
        >
          {iconForMime(mime)}
        </span>
      )}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div
          style={{
            fontWeight: 700,
            color: '#f1f5f9',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {filename}
        </div>
        <div style={{ fontSize: size(11), opacity: 0.7, display: 'flex', gap: 8 }}>
          {mime ? <span>{mime}</span> : null}
          {humanBytes(bytes) ? <span>· {humanBytes(bytes)}</span> : null}
          {formatTime ? <span>· {formatTime(attachment.createdAt)}</span> : null}
        </div>
      </div>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        download={filename}
        style={{
          padding: '6px 12px',
          background: 'rgba(99,102,241,0.3)',
          border: '1px solid rgba(129,140,248,0.6)',
          borderRadius: 8,
          color: '#e0e7ff',
          textDecoration: 'none',
          fontSize: size(12),
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        הורד
      </a>
    </div>
  );
}
