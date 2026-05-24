/**
 * attachmentHelpers — shared utilities for rendering and validating
 * attachments across the chat panel, Tasks Panel, and upload forms.
 *
 * Kept zero-dep so it can be imported anywhere without pulling React.
 * Three things live here:
 *   • iconForMime(mime)  — emoji icon best-matched to the content type
 *   • humanBytes(n)      — "12.4 KB" / "1.2 MB" rendering for byte counts
 *   • validateAttachmentSize(file) — client-side check before upload
 *
 * The 10 MB cap matches Paperclip's server default
 * (PAPERCLIP_ATTACHMENT_MAX_BYTES). Companies can raise it via env var,
 * but the client can't easily learn that — so we use the safe default
 * and let the server give the authoritative 413 if a larger file slips
 * through.
 */

export const DEFAULT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

const ICON_FOR_MIME: Array<[RegExp, string]> = [
  [/^image\//, '🖼'],
  [/pdf$/, '📕'],
  [/word|officedocument\.wordprocessing/, '📘'],
  [/spreadsheet|excel|csv/, '📊'],
  [/presentation|powerpoint/, '📙'],
  [/zip|tar|gzip|7z|rar/, '🗜'],
  [/audio\//, '🎵'],
  [/video\//, '🎬'],
  [/text\//, '📄'],
  [/json|yaml|toml|xml/, '🧾'],
];

export function iconForMime(mime: string): string {
  for (const [rx, icon] of ICON_FOR_MIME) {
    if (rx.test(mime)) return icon;
  }
  return '📎';
}

export function humanBytes(bytes: number | null | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes)) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export interface AttachmentValidation {
  ok: boolean;
  /** Hebrew error string suitable for inline display in a chip. */
  error?: string;
}

export function validateAttachmentSize(
  file: File,
  max: number = DEFAULT_ATTACHMENT_MAX_BYTES,
): AttachmentValidation {
  if (file.size > max) {
    return {
      ok: false,
      error: `קובץ גדול מדי (${humanBytes(file.size)}). מקסימום ${humanBytes(max)}.`,
    };
  }
  return { ok: true };
}
