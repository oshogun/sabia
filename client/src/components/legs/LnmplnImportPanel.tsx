import { FileUploaderButton, InlineLoading, InlineNotification } from '@carbon/react';
import type { PlannedLegImportResponse } from '../../types';

/** Props for {@link LnmplnImportPanel}. The page performs the upload and passes the outcome back. */
export interface LnmplnImportPanelProps {
  /** Called with the picked files; the panel never talks to the server. */
  onFiles: (files: File[]) => void;
  importing?: boolean;
  /** Request-level failure (network, non-JSON body). */
  error?: string;
  /** Per-file results from a 201 or 400 response, in upload order. */
  results?: PlannedLegImportResponse['results'] | null;
  /** The response's batch verdict; used to explain an upload-order fallback. */
  batch?: PlannedLegImportResponse['batch'];
  /** Heading element for the panel title, so it can nest under a section of any depth. */
  headingLevel?: 'h2' | 'h3' | 'h4';
}

/** Multi-file .lnmpln import: per-file errors and warnings both listed, plus an ordering notice. */
export function LnmplnImportPanel({ onFiles, importing = false, error, results, batch, headingLevel: H = 'h2' }: LnmplnImportPanelProps) {
  const rejected = (results ?? []).filter(r => r.status !== 'imported');
  const warned = (results ?? []).filter(r => r.status === 'imported' && r.warnings && r.warnings.length > 0);
  const notice = batch && batch.ordering === 'upload'
    ? `Import order was taken from upload order (${batch.reason}), not the route.`
    : null;

  return (
    <section aria-label="Import planned route">
      <H className="sabia-heading-03" style={{ marginBlockEnd: '0.5rem' }}>Import a Little Navmap plan (.lnmpln)</H>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <FileUploaderButton
          labelText="Choose .lnmpln files"
          buttonKind="tertiary"
          size="md"
          accept={['.lnmpln']}
          multiple
          disabled={importing}
          disableLabelChanges
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length > 0) onFiles(files);
            e.target.value = '';
          }}
        />
        {importing && <InlineLoading description="Importing…" />}
      </div>
      {error && (
        <InlineNotification kind="error" lowContrast hideCloseButton title="Could not import plan"
          subtitle={error} style={{ maxInlineSize: 'none' }} />
      )}
      {notice && (
        <InlineNotification kind="info" lowContrast hideCloseButton title="Import order"
          subtitle={notice} style={{ maxInlineSize: 'none' }} />
      )}
      {rejected.map(r => (
        <InlineNotification key={`${r.filename}-error`} kind="error" lowContrast hideCloseButton
          title={r.filename} subtitle={r.error ?? r.status} style={{ maxInlineSize: 'none' }} />
      ))}
      {warned.map(r => (
        <InlineNotification key={`${r.filename}-warnings`} kind="warning" lowContrast hideCloseButton
          title={`${r.filename}: imported`}
          subtitle={r.warnings!.map(w => w.message).join('; ')} style={{ maxInlineSize: 'none' }} />
      ))}
    </section>
  );
}
