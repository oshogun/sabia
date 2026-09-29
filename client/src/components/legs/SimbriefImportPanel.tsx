import { Link as RouterLink } from 'react-router-dom';
import { Button, InlineLoading, InlineNotification, Link } from '@carbon/react';
import type { SimbriefImportResult } from '../../types';

/**
 * Props for {@link SimbriefImportPanel}. The user id itself is edited on the
 * settings page; this panel only reads whether one is saved.
 */
export interface SimbriefImportPanelProps {
  /** Saved SimBrief user id: undefined while loading, null when not set. */
  userId: string | null | undefined;
  importing?: boolean;
  onImport: () => void;
  /** Request-level failure. */
  error?: string;
  /** Outcome of the last import; a duplicate is informational, not an error. */
  result?: SimbriefImportResult | null;
  /** Heading element for the panel title, so it can nest under a section of any depth. */
  headingLevel?: 'h2' | 'h3' | 'h4';
}

/** SimBrief import action: disabled, with a link to /settings, until a user id is saved. */
export function SimbriefImportPanel({ userId, importing = false, onImport, error, result, headingLevel: H = 'h2' }: SimbriefImportPanelProps) {
  const loading = userId === undefined;
  const unset = userId === null || userId === '';
  const disabled = loading || unset || importing;

  return (
    <section aria-label="Import from SimBrief">
      <H className="sabia-heading-03" style={{ marginBlockEnd: '0.5rem' }}>Import from SimBrief</H>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <Button kind="tertiary" disabled={disabled} onClick={onImport}>Import from SimBrief</Button>
        {importing && <InlineLoading description="Importing from SimBrief…" />}
        {loading && <InlineLoading description="Loading settings…" />}
        {!loading && !importing && unset && (
          <span style={{ color: 'var(--cds-text-secondary)' }}>
            No SimBrief pilot ID saved.{' '}
            <Link as={RouterLink} to="/settings">Set it in Settings</Link> to enable import.
          </span>
        )}
      </div>
      {error && (
        <InlineNotification kind="error" lowContrast hideCloseButton title="Could not import plan"
          subtitle={error} style={{ maxInlineSize: 'none' }} />
      )}
      {result?.status === 'imported' && (
        <>
          <InlineNotification kind="success" lowContrast hideCloseButton title="Imported"
            subtitle={`Imported ${result.label} as a new planned leg.`} style={{ maxInlineSize: 'none' }} />
          {result.warnings.map((w, i) => (
            <InlineNotification key={`${w.code}-${i}`} kind="warning" lowContrast hideCloseButton
              title={w.code} subtitle={w.message} style={{ maxInlineSize: 'none' }} />
          ))}
        </>
      )}
      {result?.status === 'duplicate' && (
        <InlineNotification kind="info" lowContrast hideCloseButton title="Already imported"
          subtitle={result.error ?? 'This plan was already imported.'} style={{ maxInlineSize: 'none' }} />
      )}
    </section>
  );
}
