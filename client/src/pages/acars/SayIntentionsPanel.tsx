import { Link as RouterLink } from 'react-router-dom';
import { Button, InlineLoading, Link, Tile } from '@carbon/react';
import type { SayIntentionsLinkStatus } from '../../types';
import { SI_IMPORT_SENDING_ID, SI_LINK_SENDING_ID, SI_UNLINK_SENDING_ID } from './SendToolbar';
import { formatDate } from '../../utils/format';
import './acars.scss';

export interface SayIntentionsPanelProps {
  /** null covers both "not loaded" and "unavailable": the same muted line either way. */
  status: SayIntentionsLinkStatus | null;
  sendingId: string | null;
  onLink: () => void;
  onUnlink: () => void;
  onImport: () => void;
}

export function SayIntentionsPanel({ status, sendingId, onLink, onUnlink, onImport }: SayIntentionsPanelProps) {
  const idle = sendingId === null;
  const busy = (id: string, text: string, label: string) => (sendingId === id ? <InlineLoading description={text} /> : label);
  return (
    <Tile>
      <h2 className="sabia-heading-03 acars-section-title">SayIntentions</h2>
      {status === null || !status.api_key_set ? (
        <p className="acars-status" style={{ marginTop: 0 }}>SayIntentions: no API key saved. Add one in <Link as={RouterLink} to="/settings">Settings</Link>.</p>
      ) : (
        <>
          <div className="acars-toolbar">
            {status.linked ? (
              <>
                <Button kind="ghost" size="md" disabled={!idle} onClick={onLink}>{busy(SI_LINK_SENDING_ID, 'Relinking…', 'RELINK')}</Button>
                <Button kind="ghost" size="md" disabled={!idle} onClick={onUnlink}>{busy(SI_UNLINK_SENDING_ID, 'Unlinking…', 'UNLINK')}</Button>
              </>
            ) : (
              <Button kind="ghost" size="md" disabled={!idle} onClick={onLink}>{busy(SI_LINK_SENDING_ID, 'Linking…', 'LINK SAYINTENTIONS')}</Button>
            )}
            <Button
              kind="ghost" size="md" disabled={!idle || !status.linked}
              title={status.linked ? undefined : 'Link this flight to a SayIntentions session first'}
              onClick={onImport}
            >
              {busy(SI_IMPORT_SENDING_ID, 'Importing…', 'IMPORT SAYINTENTIONS COMMS')}
            </Button>
          </div>
          {status.linked && status.link && (
            <p className="acars-status">
              Linked · last import {status.link.last_import_at ? formatDate(status.link.last_import_at) : 'never'} · {status.link.imported_count} imported.
            </p>
          )}
        </>
      )}
    </Tile>
  );
}
