import type { CSSProperties, KeyboardEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Button, IconButton, InlineNotification, TextArea, Tile } from '@carbon/react';
import { Edit } from '@carbon/icons-react';

export interface NotesTileProps {
  kind: 'flight' | 'trip';
  subject: string;
  notes: string | null;
  onSave: (notes: string | null) => Promise<void>;
  /** Overrides the tile's own spacing below it; defaults to a 1rem bottom margin, for a page laying out its own gap (e.g. a CSS grid) instead. */
  style?: CSSProperties;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Always-visible Notes tile: a saved value shown as plain text, with a pencil
 * button (or a double-click on the text) switching to an inline textarea.
 * Save sends only the trimmed notes, never any other field on the flight or
 * trip; an emptied draft is saved as null and the tile falls back to its
 * empty state.
 */
export function NotesTile({ kind, subject, notes, onSave, style }: NotesTileProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const focusTriggerOnExit = useRef(false);

  useEffect(() => {
    if (!editing && focusTriggerOnExit.current) {
      triggerRef.current?.focus();
      focusTriggerOnExit.current = false;
    }
  }, [editing]);

  function enterEdit() {
    setDraft(notes ?? '');
    setError(null);
    setEditing(true);
  }

  function exitEdit() {
    focusTriggerOnExit.current = true;
    setEditing(false);
    setError(null);
  }

  function onTextAreaKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      exitEdit();
    }
  }

  async function handleSave() {
    const trimmed = draft.trim();
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed === '' ? null : trimmed);
      focusTriggerOnExit.current = true;
      setEditing(false);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setSaving(false);
    }
  }

  const empty = notes === null || notes === '';

  return (
    <Tile style={style ?? { marginBottom: '1rem' }} data-testid="notes-tile">
      <h2 className="sabia-heading-03" style={{ marginBottom: '0.5rem' }}>Notes</h2>
      {editing ? (
        <>
          <TextArea
            id={`notes-tile-${kind}`}
            hideLabel
            labelText="Notes"
            rows={4}
            value={draft}
            autoFocus
            disabled={saving}
            placeholder={`Free-form notes about this ${kind}…`}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onTextAreaKeyDown}
          />
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <Button kind="primary" size="sm" disabled={saving} onClick={() => void handleSave()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button kind="secondary" size="sm" disabled={saving} onClick={exitEdit}>Cancel</Button>
          </div>
          {error && (
            <InlineNotification kind="error" lowContrast hideCloseButton title={`Could not save ${kind} notes`}
              subtitle={error} style={{ maxInlineSize: 'none', marginTop: '0.5rem' }} />
          )}
        </>
      ) : empty ? (
        <>
          <p className="sabia-helper">No notes for this {kind}.</p>
          <Button ref={triggerRef} kind="ghost" size="sm" aria-label={`Add notes for ${subject}`}
            style={{ marginTop: '0.5rem' }} onClick={enterEdit}>
            Add notes
          </Button>
        </>
      ) : (
        <>
          <p style={{ whiteSpace: 'pre-wrap' }} onDoubleClick={enterEdit}>{notes}</p>
          <IconButton ref={triggerRef} label={`Edit notes for ${subject}`} kind="ghost" size="sm" onClick={enterEdit}>
            <Edit />
          </IconButton>
        </>
      )}
    </Tile>
  );
}
