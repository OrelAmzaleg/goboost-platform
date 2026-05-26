import { useCallback, useEffect, useRef, useState } from 'react';

import {
  applyCompanyImport,
  archiveCompany,
  companyAssetUrl,
  createCompanyExport,
  deleteCompany,
  fetchCompany,
  generateOpenClawInvite,
  previewCompanyExport,
  previewCompanyImport,
  updateCompany,
  uploadCompanyLogo,
  type OpenClawInvite,
  type PaperclipCompany,
} from '../paperclipApi.js';
import { ModalShell, primaryBtn, secondaryBtn } from './ProjectCreateModal.js';
import { TextArea, TextField } from './projectForm.js';

/**
 * CompanySettingsModal — single-page settings surface.
 *
 * Earlier version split into 6 tabs; operator review preferred a
 * single flowing scroll with grouped sections. Each section owns its
 * own dirty state + save button (so a draft on Appearance doesn't
 * trip General's PATCH). Sections that hit admin-only endpoints
 * surface a clearer "requires admin" hint instead of a generic save
 * failure.
 *
 * Section order — most-used first, dangerous last:
 *   1. General         (name, description)
 *   2. Appearance      (logo, brand color, attachment size)
 *   3. Hiring          (require board approval toggle)
 *   4. Invites         (OpenClaw invite snippet)
 *   5. Packages        (export + import)
 *   6. Danger Zone     (archive + delete)
 */

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#cbd5e1',
};

const fieldStyle: React.CSSProperties = {
  padding: '9px 12px',
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.12)',
  background: '#1e293b',
  color: '#f1f5f9',
  fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  fontSize: 14,
  fontWeight: 400,
  outline: 'none',
  colorScheme: 'dark',
};

const BRAND_COLOR_PRESETS = [
  '#6366f1',
  '#a855f7',
  '#ec4899',
  '#22c55e',
  '#f59e0b',
  '#0ea5e9',
  '#ef4444',
  '#475569',
];

export interface CompanySettingsModalProps {
  companyId: string;
  onClose: () => void;
  /** Called when the company changes — App.tsx refreshes its companies list. */
  onChanged: () => Promise<void> | void;
  /** Called after archive — App.tsx may need to switch to another company. */
  onArchived: () => Promise<void> | void;
  /** Called after delete — same as archive. */
  onDeleted: () => Promise<void> | void;
}

export function CompanySettingsModal({
  companyId,
  onClose,
  onChanged,
  onArchived,
  onDeleted,
}: CompanySettingsModalProps) {
  const [company, setCompany] = useState<PaperclipCompany | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const c = await fetchCompany(companyId);
    setCompany(c);
    setError(c ? null : 'לא ניתן לטעון את החברה.');
    setLoading(false);
  }, [companyId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const headerTitle = company ? `${company.name} · הגדרות` : 'הגדרות חברה';

  return (
    <ModalShell title={headerTitle} onClose={onClose} xlarge>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {error ? <ErrorBox text={error} /> : null}
        {loading || !company ? (
          <div style={{ fontSize: 14, color: '#94a3b8', padding: '20px 0' }}>
            טוען הגדרות חברה…
          </div>
        ) : (
          <>
            <SectionCard
              title="כללי"
              hint="שם החברה והתיאור — מופיעים בכל מקום ב-workspace הזה."
            >
              <GeneralSection
                company={company}
                onSaved={async () => {
                  await reload();
                  await onChanged();
                }}
              />
            </SectionCard>

            <SectionCard
              title="מראה"
              hint="לוגו, צבע מותג, וגודל קובץ מצורף מקסימלי."
            >
              <AppearanceSection
                company={company}
                onSaved={async () => {
                  await reload();
                  await onChanged();
                }}
              />
            </SectionCard>

            <SectionCard title="גיוס" hint="התנהגות שיוצרת סוכנים חדשים.">
              <HiringSection
                company={company}
                onSaved={async () => {
                  await reload();
                  await onChanged();
                }}
              />
            </SectionCard>

            <SectionCard
              title="הזמנות"
              hint="snippet חד-פעמי ל-OpenClaw כדי להוסיף סוכן חדש מהעולם."
            >
              <InvitesSection />
            </SectionCard>

            <SectionCard
              title="חבילות"
              hint="ייצוא + ייבוא של כל ה-workspace כקובץ JSON."
            >
              <PackagesSection />
            </SectionCard>

            <SectionCard
              title="אזור מסוכן"
              hint="פעולות בלתי-הפיכות. עצור והבן את ההשלכות לפני שלוחצים."
              danger
            >
              <DangerSection
                company={company}
                onArchived={async () => {
                  await onArchived();
                  onClose();
                }}
                onDeleted={async () => {
                  await onDeleted();
                  onClose();
                }}
              />
            </SectionCard>
          </>
        )}
      </div>
    </ModalShell>
  );
}

// ── Section frame ───────────────────────────────────────────────

function SectionCard({
  title,
  hint,
  danger,
  children,
}: {
  title: string;
  hint?: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: danger
          ? 'rgba(127, 29, 29, 0.10)'
          : 'rgba(255,255,255,0.03)',
        border: `1px solid ${danger ? 'rgba(239, 68, 68, 0.35)' : 'rgba(255,255,255,0.08)'}`,
        borderRadius: 12,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div>
        <div
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: danger ? '#fecaca' : '#f1f5f9',
          }}
        >
          {title}
        </div>
        {hint ? (
          <div
            style={{
              fontSize: 12,
              color: danger ? '#fca5a5' : '#94a3b8',
              marginBlockStart: 4,
              lineHeight: 1.5,
            }}
          >
            {hint}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

// ── General ─────────────────────────────────────────────────────

function GeneralSection({
  company,
  onSaved,
}: {
  company: PaperclipCompany;
  onSaved: () => Promise<void> | void;
}) {
  const [name, setName] = useState(company.name);
  const [description, setDescription] = useState(company.description ?? '');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    name.trim() !== company.name.trim() ||
    (description.trim() || null) !== (company.description?.trim() || null);

  const submit = async () => {
    setSaving(true);
    setError(null);
    const updated = await updateCompany(company.id, {
      name: name.trim(),
      description: description.trim() || null,
    });
    setSaving(false);
    if (!updated) {
      setError('שמירה נכשלה. ייתכן שאינך admin/board ב-Paperclip.');
      return;
    }
    setSavedAt(Date.now());
    await onSaved();
  };

  return (
    <>
      <TextField
        label="שם החברה"
        value={name}
        onChange={setName}
        disabled={saving}
      />
      <TextArea
        label="תיאור"
        value={description}
        onChange={setDescription}
        placeholder="במה החברה עוסקת"
        disabled={saving}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          color: '#64748b',
        }}
      >
        <span style={labelStyle}>Issue prefix:</span>
        <code
          style={{
            background: 'rgba(0,0,0,0.3)',
            padding: '1px 6px',
            borderRadius: 4,
            color: '#cbd5e1',
          }}
        >
          {company.issuePrefix ?? '—'}
        </code>
        <span style={{ opacity: 0.7 }}>(לא ניתן לשנות מכאן)</span>
      </div>
      {error ? <ErrorBox text={error} /> : null}
      <SaveRow
        dirty={dirty}
        saving={saving}
        savedAt={savedAt}
        onSubmit={() => void submit()}
      />
    </>
  );
}

// ── Appearance ──────────────────────────────────────────────────

function AppearanceSection({
  company,
  onSaved,
}: {
  company: PaperclipCompany;
  onSaved: () => Promise<void> | void;
}) {
  const [brandColor, setBrandColor] = useState(company.brandColor ?? '#6366f1');
  const [logoAssetId, setLogoAssetId] = useState(company.logoAssetId ?? null);
  const [attachmentMaxMb, setAttachmentMaxMb] = useState<string>(
    company.attachmentMaxBytes != null
      ? String(Math.round(company.attachmentMaxBytes / (1024 * 1024)))
      : '10',
  );
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const dirty =
    brandColor !== (company.brandColor ?? '#6366f1') ||
    logoAssetId !== (company.logoAssetId ?? null) ||
    Number(attachmentMaxMb) * 1024 * 1024 !==
      (company.attachmentMaxBytes ?? 10 * 1024 * 1024);

  const onPickFile = () => fileRef.current?.click();

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploading(true);
    setError(null);
    // Explicit company.id so upload always targets THIS modal's
    // company — never the previously-active workspace.
    const assetId = await uploadCompanyLogo(f, company.id);
    setUploading(false);
    if (!assetId) {
      setError(
        'העלאת הלוגו נכשלה. ייתכן שאינך admin/board ב-Paperclip, או שהקובץ גדול מהמותר.',
      );
      return;
    }
    setLogoAssetId(assetId);
    e.target.value = '';
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    const mb = Math.max(1, Math.min(500, Number(attachmentMaxMb) || 10));
    const updated = await updateCompany(company.id, {
      brandColor,
      logoAssetId,
      attachmentMaxBytes: mb * 1024 * 1024,
    });
    setSaving(false);
    if (!updated) {
      setError('שמירה נכשלה. ייתכן שאינך admin/board ב-Paperclip.');
      return;
    }
    setSavedAt(Date.now());
    await onSaved();
  };

  const logoUrl = companyAssetUrl(logoAssetId);

  return (
    <>
      {/* Logo */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
        }}
      >
        {logoUrl ? (
          <img
            src={logoUrl}
            alt="logo"
            style={{
              width: 64,
              height: 64,
              borderRadius: 10,
              background: brandColor,
              objectFit: 'cover',
            }}
          />
        ) : (
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 10,
              background: brandColor,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontWeight: 700,
              fontSize: 26,
            }}
          >
            {company.name.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <button
            type="button"
            onClick={onPickFile}
            disabled={uploading || saving}
            style={{
              padding: '7px 14px',
              fontSize: 13,
              borderRadius: 7,
              border: '1px solid rgba(255,255,255,0.15)',
              background: 'rgba(255,255,255,0.06)',
              color: '#e2e8f0',
              cursor: uploading || saving ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              fontWeight: 600,
              opacity: uploading || saving ? 0.5 : 1,
            }}
          >
            {uploading ? 'מעלה…' : '⬆ העלה לוגו'}
          </button>
          {logoAssetId ? (
            <button
              type="button"
              onClick={() => setLogoAssetId(null)}
              disabled={uploading || saving}
              style={{
                padding: '4px 10px',
                fontSize: 11,
                borderRadius: 6,
                border: '1px solid rgba(239,68,68,0.4)',
                background: 'rgba(239,68,68,0.12)',
                color: '#fecaca',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              הסר לוגו
            </button>
          ) : null}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            onChange={(e) => void onFileChange(e)}
            style={{ display: 'none' }}
          />
          <div style={{ fontSize: 11, color: '#64748b' }}>
            PNG / JPG / SVG · עד 2MB מומלץ
          </div>
        </div>
      </div>

      {/* Brand color */}
      <div>
        <div style={{ ...labelStyle, marginBlockEnd: 6 }}>צבע מותג</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <input
            type="color"
            value={brandColor}
            onChange={(e) => setBrandColor(e.target.value)}
            disabled={saving}
            style={{
              width: 48,
              height: 36,
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 6,
              background: 'transparent',
              cursor: 'pointer',
              padding: 2,
            }}
          />
          <input
            type="text"
            value={brandColor}
            onChange={(e) => setBrandColor(e.target.value)}
            disabled={saving}
            placeholder="#6366f1"
            style={{
              ...fieldStyle,
              maxWidth: 130,
              fontFamily:
                "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
              fontSize: 13,
            }}
          />
          <div style={{ display: 'flex', gap: 4 }}>
            {BRAND_COLOR_PRESETS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setBrandColor(c)}
                disabled={saving}
                title={c}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  background: c,
                  border:
                    brandColor === c
                      ? '2px solid #fff'
                      : '1px solid rgba(255,255,255,0.18)',
                  cursor: 'pointer',
                  padding: 0,
                }}
              />
            ))}
          </div>
        </div>
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={labelStyle}>גודל מקסימלי לקובץ מצורף (MB)</span>
        <input
          type="number"
          min={1}
          max={500}
          value={attachmentMaxMb}
          onChange={(e) => setAttachmentMaxMb(e.target.value)}
          disabled={saving}
          style={{ ...fieldStyle, maxWidth: 160 }}
        />
      </label>

      {error ? <ErrorBox text={error} /> : null}
      <SaveRow
        dirty={dirty}
        saving={saving}
        savedAt={savedAt}
        onSubmit={() => void submit()}
      />
    </>
  );
}

// ── Hiring ──────────────────────────────────────────────────────

function HiringSection({
  company,
  onSaved,
}: {
  company: PaperclipCompany;
  onSaved: () => Promise<void> | void;
}) {
  const [requireApproval, setRequireApproval] = useState(
    Boolean(company.requireBoardApprovalForNewAgents),
  );
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    requireApproval !== Boolean(company.requireBoardApprovalForNewAgents);

  const submit = async () => {
    setSaving(true);
    setError(null);
    const updated = await updateCompany(company.id, {
      requireBoardApprovalForNewAgents: requireApproval,
    });
    setSaving(false);
    if (!updated) {
      setError('שמירה נכשלה. ייתכן שאינך admin/board ב-Paperclip.');
      return;
    }
    setSavedAt(Date.now());
    await onSaved();
  };

  return (
    <>
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          cursor: saving ? 'not-allowed' : 'pointer',
          fontSize: 14,
          color: '#e2e8f0',
        }}
      >
        <input
          type="checkbox"
          checked={requireApproval}
          onChange={(e) => setRequireApproval(e.target.checked)}
          disabled={saving}
          style={{
            width: 18,
            height: 18,
            accentColor: '#6366f1',
            cursor: 'inherit',
          }}
        />
        <span style={{ fontWeight: 600 }}>
          דרוש אישור Board ליצירת סוכן חדש
        </span>
      </label>
      <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.6 }}>
        כאשר פעיל — סוכנים חדשים שיצרת מקבלים סטטוס{' '}
        <code>pending_approval</code> ולא יוכלו להריץ heartbeats עד אישור
        Board. השאר כבוי לשימוש פרטי.
      </div>
      {error ? <ErrorBox text={error} /> : null}
      <SaveRow
        dirty={dirty}
        saving={saving}
        savedAt={savedAt}
        onSubmit={() => void submit()}
      />
    </>
  );
}

// ── Invites ─────────────────────────────────────────────────────

function InvitesSection() {
  const [invite, setInvite] = useState<OpenClawInvite | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setGenerating(true);
    setError(null);
    const result = await generateOpenClawInvite();
    setGenerating(false);
    if (!result) {
      setError(
        'יצירת ה-invite נכשלה — דרוש admin ב-Paperclip. צור invite ידנית בדשבורד פייפרקליפ.',
      );
      return;
    }
    setInvite(result);
    setCopied(false);
  };

  const copy = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setError('העתקה ל-clipboard נכשלה.');
    }
  };

  return (
    <>
      {!invite ? (
        <button
          type="button"
          onClick={() => void generate()}
          disabled={generating}
          style={{
            ...primaryBtn,
            padding: '9px 18px',
            fontSize: 13,
            alignSelf: 'flex-start',
            opacity: generating ? 0.5 : 1,
            cursor: generating ? 'not-allowed' : 'pointer',
          }}
        >
          {generating ? 'יוצר…' : '+ צור OpenClaw invite'}
        </button>
      ) : (
        <div
          style={{
            background: 'rgba(99,102,241,0.12)',
            border: '1px solid rgba(99,102,241,0.45)',
            borderRadius: 10,
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <span
              style={{
                fontSize: 12,
                color: '#c7d2fe',
                fontWeight: 700,
              }}
            >
              📋 Invite — חד-פעמי
            </span>
            <button
              type="button"
              onClick={() => void copy()}
              style={{
                padding: '4px 12px',
                fontSize: 12,
                borderRadius: 6,
                border: '1px solid rgba(99,102,241,0.55)',
                background: 'rgba(99,102,241,0.22)',
                color: '#e0e7ff',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontWeight: 700,
              }}
            >
              {copied ? '✓ הועתק' : '📋 העתק'}
            </button>
          </div>
          <pre
            style={{
              margin: 0,
              padding: 10,
              background: 'rgba(0,0,0,0.4)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 7,
              fontSize: 12,
              fontFamily:
                "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
              color: '#e2e8f0',
              whiteSpace: 'pre-wrap',
              maxHeight: 240,
              overflow: 'auto',
            }}
          >
            {invite.prompt}
          </pre>
          {invite.expiresAt ? (
            <div style={{ fontSize: 11, color: '#94a3b8' }}>
              תוקף עד: {new Date(invite.expiresAt).toLocaleString('he-IL')}
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => setInvite(null)}
            style={{
              ...secondaryBtn,
              alignSelf: 'flex-start',
              fontSize: 12,
              padding: '5px 12px',
            }}
          >
            סגור snippet
          </button>
        </div>
      )}
      {error ? <ErrorBox text={error} /> : null}
    </>
  );
}

// ── Packages ────────────────────────────────────────────────────

function PackagesSection() {
  const [exporting, setExporting] = useState(false);
  const [exportPreview, setExportPreview] = useState<unknown>(null);
  const [exportResult, setExportResult] = useState<{
    downloadUrl?: string;
  } | null>(null);

  const [importing, setImporting] = useState(false);
  const [importPreview, setImportPreview] = useState<unknown>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);

  const onPreviewExport = async () => {
    setExporting(true);
    setError(null);
    const preview = await previewCompanyExport();
    setExporting(false);
    if (!preview) {
      setError('preview של ה-export נכשל — ייתכן שדרוש admin ב-Paperclip.');
      return;
    }
    setExportPreview(preview);
  };

  const onExport = async () => {
    setExporting(true);
    setError(null);
    const result = await createCompanyExport();
    setExporting(false);
    if (!result) {
      setError('יצירת ה-export נכשלה — ייתכן שדרוש admin ב-Paperclip.');
      return;
    }
    setExportResult(result);
  };

  const onPickImport = () => importRef.current?.click();

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setImportFile(f);
    setImporting(true);
    setError(null);
    const preview = await previewCompanyImport(f);
    setImporting(false);
    if (!preview) {
      setError('preview של ה-import נכשל — ייתכן שדרוש admin ב-Paperclip.');
      return;
    }
    setImportPreview(preview);
    e.target.value = '';
  };

  const onApplyImport = async () => {
    if (!importFile) return;
    if (
      !window.confirm(
        'להחיל את ה-import? הפעולה תוסיף / תעדכן נתונים בחברה הנוכחית. אינה הפיכה בקלות.',
      )
    ) {
      return;
    }
    setImporting(true);
    const ok = await applyCompanyImport(importFile);
    setImporting(false);
    if (!ok) {
      setError('החלת ה-import נכשלה.');
      return;
    }
    setImportFile(null);
    setImportPreview(null);
    window.alert('Import הושלם בהצלחה.');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Export */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ ...labelStyle, fontSize: 13 }}>Export החברה</div>
        <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.6 }}>
          חבילת JSON של agents / projects / goals / routines / issues.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => void onPreviewExport()}
            disabled={exporting}
            style={secondaryBtn}
          >
            {exporting ? 'מבצע…' : 'תצוגה מקדימה'}
          </button>
          <button
            type="button"
            onClick={() => void onExport()}
            disabled={exporting}
            style={{
              ...primaryBtn,
              opacity: exporting ? 0.5 : 1,
              cursor: exporting ? 'not-allowed' : 'pointer',
            }}
          >
            ⬇ הורד export
          </button>
        </div>
        {exportPreview != null ? (
          <PreviewBlock label="תצוגה מקדימה" data={exportPreview} />
        ) : null}
        {exportResult?.downloadUrl ? (
          <a
            href={exportResult.downloadUrl}
            download
            style={{
              ...primaryBtn,
              alignSelf: 'flex-start',
              textDecoration: 'none',
              fontSize: 13,
              padding: '6px 14px',
            }}
          >
            ⬇ הורד את הקובץ
          </a>
        ) : null}
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />

      {/* Import */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ ...labelStyle, fontSize: 13 }}>Import חבילה</div>
        <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.6 }}>
          טוען חבילת JSON מ-export קודם. ה-preview יציג מה ייתווסף.
        </div>
        <button
          type="button"
          onClick={onPickImport}
          disabled={importing}
          style={{
            ...secondaryBtn,
            alignSelf: 'flex-start',
          }}
        >
          {importing ? 'מעלה…' : '⬆ בחר קובץ import'}
        </button>
        <input
          ref={importRef}
          type="file"
          accept=".json,application/json"
          onChange={(e) => void onImportFile(e)}
          style={{ display: 'none' }}
        />
        {importPreview != null ? (
          <>
            <PreviewBlock label="מה ייובא" data={importPreview} />
            <button
              type="button"
              onClick={() => void onApplyImport()}
              disabled={importing}
              style={{
                ...primaryBtn,
                alignSelf: 'flex-start',
                opacity: importing ? 0.5 : 1,
                cursor: importing ? 'not-allowed' : 'pointer',
              }}
            >
              {importing ? 'מחיל…' : '✓ החל import'}
            </button>
          </>
        ) : null}
      </div>

      {error ? <ErrorBox text={error} /> : null}
    </div>
  );
}

function PreviewBlock({ label, data }: { label: string; data: unknown }) {
  return (
    <div>
      <div style={{ ...labelStyle, fontSize: 11, marginBlockEnd: 4 }}>
        {label}
      </div>
      <pre
        style={{
          margin: 0,
          padding: 10,
          background: 'rgba(0,0,0,0.4)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 7,
          fontSize: 11,
          fontFamily:
            "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
          color: '#cbd5e1',
          maxHeight: 220,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
        }}
      >
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}

// ── Danger Zone ─────────────────────────────────────────────────

function DangerSection({
  company,
  onArchived,
  onDeleted,
}: {
  company: PaperclipCompany;
  onArchived: () => Promise<void> | void;
  onDeleted: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState<'archive' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onArchive = async () => {
    if (
      !window.confirm(
        `להעביר את "${company.name}" לארכיון?\n\nהחברה תוסתר מהרשימה אך הנתונים נשמרים. אפשר לשחזר דרך Paperclip dashboard.`,
      )
    ) {
      return;
    }
    setBusy('archive');
    setError(null);
    const result = await archiveCompany(company.id);
    setBusy(null);
    if (!result) {
      setError('Archive נכשל — דרוש admin/board ב-Paperclip.');
      return;
    }
    await onArchived();
  };

  const onDelete = async () => {
    const confirmText = company.name;
    const typed = window.prompt(
      `מחיקה לצמיתות של "${company.name}".\n\nכל הסוכנים, המשימות, הריצות, ההגדרות ימחקו ולא יהיו ניתנים לשחזור.\n\nכדי לאשר, הקלד את שם החברה:`,
    );
    if (typed !== confirmText) {
      if (typed != null) {
        window.alert('השם שהוקלד אינו תואם. המחיקה בוטלה.');
      }
      return;
    }
    setBusy('delete');
    setError(null);
    const ok = await deleteCompany(company.id);
    setBusy(null);
    if (!ok) {
      setError('מחיקה נכשלה — דרוש admin/board ב-Paperclip.');
      return;
    }
    await onDeleted();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        style={{
          display: 'flex',
          gap: 14,
          alignItems: 'center',
          flexWrap: 'wrap',
          padding: 10,
          background: 'rgba(245, 158, 11, 0.10)',
          border: '1px solid rgba(245, 158, 11, 0.35)',
          borderRadius: 8,
        }}
      >
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#fde68a' }}>
            העברה לארכיון
          </div>
          <div
            style={{
              fontSize: 12,
              color: '#fcd34d',
              marginBlockStart: 4,
              lineHeight: 1.5,
            }}
          >
            סטטוס → <code>archived</code>. החברה תוסתר מ-switcher (אבל
            תופיע עם תווית "בארכיון"). שחזור אפשרי דרך Paperclip dashboard.
          </div>
        </div>
        <button
          type="button"
          onClick={() => void onArchive()}
          disabled={busy != null || company.status === 'archived'}
          style={{
            padding: '8px 16px',
            borderRadius: 7,
            border: '1px solid rgba(245, 158, 11, 0.6)',
            background: 'rgba(245, 158, 11, 0.22)',
            color: '#fde68a',
            fontSize: 13,
            fontWeight: 700,
            fontFamily: 'inherit',
            cursor: busy != null ? 'not-allowed' : 'pointer',
            opacity: busy != null || company.status === 'archived' ? 0.5 : 1,
            flexShrink: 0,
          }}
        >
          {busy === 'archive'
            ? 'מעביר…'
            : company.status === 'archived'
              ? 'כבר בארכיון'
              : '📦 העבר לארכיון'}
        </button>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 14,
          alignItems: 'center',
          flexWrap: 'wrap',
          padding: 10,
          background: 'rgba(127, 29, 29, 0.20)',
          border: '1px solid rgba(239, 68, 68, 0.45)',
          borderRadius: 8,
        }}
      >
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#fee2e2' }}>
            מחיקה לצמיתות
          </div>
          <div
            style={{
              fontSize: 12,
              color: '#fca5a5',
              marginBlockStart: 4,
              lineHeight: 1.5,
            }}
          >
            כל ה-agents / issues / projects / goals / runs / configurations
            ימחקו <strong>לצמיתות</strong>. הגנה: תידרש להקליד את שם החברה.
          </div>
        </div>
        <button
          type="button"
          onClick={() => void onDelete()}
          disabled={busy != null}
          style={{
            padding: '8px 16px',
            borderRadius: 7,
            border: '1px solid rgba(239, 68, 68, 0.7)',
            background: 'rgba(239, 68, 68, 0.32)',
            color: '#fee2e2',
            fontSize: 13,
            fontWeight: 700,
            fontFamily: 'inherit',
            cursor: busy != null ? 'not-allowed' : 'pointer',
            opacity: busy != null ? 0.5 : 1,
            flexShrink: 0,
          }}
        >
          {busy === 'delete' ? 'מוחק…' : '✕ מחק לצמיתות'}
        </button>
      </div>

      {error ? <ErrorBox text={error} /> : null}
    </div>
  );
}

// ── Shared helpers ──────────────────────────────────────────────

function ErrorBox({ text }: { text: string }) {
  return (
    <div
      style={{
        fontSize: 13,
        color: '#fecaca',
        background: 'rgba(127,29,29,0.4)',
        padding: '8px 12px',
        borderRadius: 7,
        lineHeight: 1.5,
      }}
    >
      {text}
    </div>
  );
}

function SaveRow({
  dirty,
  saving,
  savedAt,
  onSubmit,
}: {
  dirty: boolean;
  saving: boolean;
  savedAt: number | null;
  onSubmit: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        justifyContent: 'flex-end',
        marginBlockStart: 4,
      }}
    >
      {savedAt && Date.now() - savedAt < 4000 ? (
        <span style={{ fontSize: 12, color: '#86efac' }}>נשמר ✓</span>
      ) : null}
      <button
        type="button"
        onClick={onSubmit}
        disabled={saving || !dirty}
        style={{
          ...primaryBtn,
          opacity: saving || !dirty ? 0.5 : 1,
          cursor: saving || !dirty ? 'not-allowed' : 'pointer',
        }}
      >
        {saving ? 'שומר…' : dirty ? 'שמור שינויים' : 'אין שינויים'}
      </button>
    </div>
  );
}
