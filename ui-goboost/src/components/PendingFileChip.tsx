import {
  humanBytes,
  iconForMime,
} from './attachmentHelpers.js';

/**
 * PendingFile — a file the user has staged for upload but not yet sent.
 *
 * The shape is shared between the new-conversation form and the
 * composer: in both contexts the user adds files first, then performs
 * the action (create issue / send comment) which triggers the upload.
 *
 * `error` is set when client-side validation fails (e.g. size cap) or
 * the upload itself returned a failure. The chip renders red and
 * exposes a retry button while `error` is non-null.
 *
 * `uploading` flips on during the in-flight fetch so the chip can
 * show a spinner-ish state and the parent can disable the action
 * button until everything settles.
 */
export interface PendingFile {
  /** Local UUID — stable React key, distinct from any server attachment id. */
  localId: string;
  file: File;
  error: string | null;
  uploading: boolean;
}

export interface PendingFileChipProps {
  pending: PendingFile;
  onRemove: () => void;
  onRetry?: () => void;
  size: (base: number) => number;
}

export function PendingFileChip({
  pending,
  onRemove,
  onRetry,
  size,
}: PendingFileChipProps) {
  const { file, error, uploading } = pending;
  const isError = error != null;
  const bg = isError
    ? 'rgba(220,38,38,0.18)'
    : uploading
      ? 'rgba(59,130,246,0.18)'
      : 'rgba(255,255,255,0.06)';
  const border = isError
    ? '1px solid rgba(248,113,113,0.55)'
    : uploading
      ? '1px solid rgba(96,165,250,0.55)'
      : '1px solid rgba(255,255,255,0.12)';
  const color = isError ? '#fecaca' : '#e2e8f0';

  return (
    <div
      title={
        isError
          ? error!
          : `${file.name} · ${humanBytes(file.size) ?? ''}`
      }
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 8px 4px 10px',
        background: bg,
        border,
        borderRadius: 999,
        color,
        fontSize: size(11),
        maxWidth: 260,
      }}
    >
      <span aria-hidden style={{ fontSize: size(13), flexShrink: 0 }}>
        {iconForMime(file.type)}
      </span>
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
        {file.name}
      </span>
      {!isError && !uploading && humanBytes(file.size) ? (
        <span style={{ opacity: 0.65, flexShrink: 0 }}>
          {humanBytes(file.size)}
        </span>
      ) : null}
      {uploading ? (
        <span
          style={{
            fontSize: size(10),
            opacity: 0.8,
            flexShrink: 0,
            animation: 'pixel-pulse 1.2s ease-in-out infinite',
          }}
        >
          מעלה…
        </span>
      ) : null}
      {isError && onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          title="נסה שוב"
          aria-label="נסה שוב"
          style={{
            width: 18,
            height: 18,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: '1px solid rgba(248,113,113,0.5)',
            borderRadius: 4,
            color: '#fecaca',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: size(10),
            flexShrink: 0,
          }}
        >
          ↻
        </button>
      ) : null}
      <button
        type="button"
        onClick={onRemove}
        disabled={uploading}
        title="הסר"
        aria-label="הסר"
        style={{
          width: 18,
          height: 18,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          cursor: uploading ? 'not-allowed' : 'pointer',
          opacity: uploading ? 0.4 : 0.8,
          fontFamily: 'inherit',
          fontSize: size(12),
          fontWeight: 700,
          flexShrink: 0,
          padding: 0,
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>
  );
}

/**
 * Random-enough local id for staged files. crypto.randomUUID is widely
 * available in modern browsers but we fall back gracefully.
 */
export function newLocalFileId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `pf-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
