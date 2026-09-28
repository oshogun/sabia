import { useEffect, useState } from 'react';
import {
  Button, Form, InlineNotification, SkeletonText, Stack, Table, TableBody, TableCell, TableContainer,
  TableHead, TableHeader, TableRow, TextInput, Tile,
} from '@carbon/react';
import { createIngestToken, getIngestTokens, revokeIngestToken } from '../../api';
import { UnauthorizedError } from '../../utils/api';
import type { IngestTokenListResponse, IngestTokenSummary } from '../../types';
import { ConfirmModal } from '../ConfirmModal';
import { TokenCreatedModal, type TokenCreatedInfo } from './TokenCreatedModal';

const helper: React.CSSProperties = { color: 'var(--cds-text-secondary)', fontSize: '0.875rem' };

function formatLastUsed(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : 'Never';
}

/** Ingest tokens (MCDU): list, create-with-one-time-reveal, revoke. */
export function IngestTokensTile() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [list, setList] = useState<IngestTokenListResponse | null>(null);

  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [confirmingCreate, setConfirmingCreate] = useState(false);
  const [created, setCreated] = useState<TokenCreatedInfo | null>(null);

  const [revokeTarget, setRevokeTarget] = useState<IngestTokenSummary | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState('');

  useEffect(() => {
    let cancelled = false;
    getIngestTokens()
      .then(r => { if (!cancelled) setList(r); })
      .catch(err => {
        if (cancelled || err instanceof UnauthorizedError) return;
        setLoadError((err as Error).message);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function doCreate() {
    const trimmed = label.trim();
    if (!trimmed) return;
    setCreating(true); setCreateError('');
    try {
      const r = await createIngestToken(trimmed);
      // Keep the secret out of list state: only `created`, below, ever holds it.
      setList({ tokens: r.tokens, mode: r.mode, env_token_set: r.env_token_set, unauthenticated_opt_out_set: r.unauthenticated_opt_out_set });
      setLabel('');
      setCreated({ label: r.created.label, public_id: r.created.public_id, secret: r.secret });
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setCreateError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  function requestCreate() {
    if (creating || !label.trim()) return;
    if (list && (list.mode === 'env_token' || list.mode === 'unauthenticated')) {
      setConfirmingCreate(true);
      return;
    }
    void doCreate();
  }

  async function doRevoke() {
    if (!revokeTarget) return;
    setRevoking(true); setRevokeError('');
    try {
      setList(await revokeIngestToken(revokeTarget.id));
      setRevokeTarget(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setRevokeError((err as Error).message);
    } finally {
      setRevoking(false);
    }
  }

  const tokens = list?.tokens ?? [];
  const revokingLastToken = tokens.length === 1;

  return (
    <Tile data-testid="ingest-tokens-tile">
      <Stack gap={5}>
        <h2 className="sabia-heading-03">Ingest tokens (MCDU)</h2>
        <p style={helper}>
          Tokens the MCDU client (CFG NETWORK) and other ingest clients use. Each token is shown once, when created.
        </p>
        {loadError && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not load tokens" subtitle={loadError} />}
        {loading ? <SkeletonText /> : list && (
          <>
            {list.mode === 'closed' && (
              <InlineNotification
                kind="error" lowContrast hideCloseButton data-testid="ingest-banner-closed"
                title="No ingest token — the MCDU cannot connect"
                subtitle="Create a token below and enter it in the MCDU client. Until then every ingest request is rejected."
              />
            )}
            {list.mode === 'ui_tokens' && list.env_token_set && (
              <InlineNotification
                kind="info" lowContrast hideCloseButton data-testid="ingest-banner-env-ignored"
                title="INGEST_TOKEN is being ignored"
                subtitle="Tokens created here are enforced. A client still using the INGEST_TOKEN value is rejected."
              />
            )}
            {list.mode === 'ui_tokens' && list.unauthenticated_opt_out_set && (
              <InlineNotification
                kind="info" lowContrast hideCloseButton data-testid="ingest-banner-optout-ignored"
                title="ALLOW_UNAUTHENTICATED_INGEST is being ignored"
              />
            )}
            {list.mode === 'unauthenticated' && (
              <InlineNotification
                kind="warning" lowContrast hideCloseButton data-testid="ingest-banner-unauthenticated"
                title="Ingest is unauthenticated"
                subtitle="Anyone who can reach this server can send flight data. Creating a token turns authentication on."
              />
            )}
            {list.mode === 'env_token' && (
              <p style={helper} data-testid="ingest-mode-env">
                Currently authenticated by the INGEST_TOKEN environment variable. Creating a token here replaces it.
              </p>
            )}

            {tokens.length === 0 ? (
              <p data-testid="ingest-tokens-empty">No tokens yet.</p>
            ) : (
              <TableContainer>
                <Table aria-label="Ingest tokens">
                  <TableHead>
                    <TableRow>
                      <TableHeader>Label</TableHeader>
                      <TableHeader>ID</TableHeader>
                      <TableHeader>Created</TableHeader>
                      <TableHeader>Last used</TableHeader>
                      <TableHeader />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {tokens.map(t => (
                      <TableRow key={t.id} data-testid={`ingest-token-row-${t.id}`}>
                        <TableCell>{t.label}</TableCell>
                        <TableCell style={{ fontFamily: 'monospace' }}>{t.public_id}</TableCell>
                        <TableCell>{new Date(t.created_at).toLocaleString()}</TableCell>
                        <TableCell>{formatLastUsed(t.last_used_at)}</TableCell>
                        <TableCell>
                          <Button
                            kind="danger--ghost" size="sm" data-testid={`ingest-token-revoke-${t.id}`}
                            disabled={revoking} onClick={() => setRevokeTarget(t)}
                          >
                            Revoke
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}

            {revokeError && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not revoke token" subtitle={revokeError} />}

            <Form onSubmit={e => { e.preventDefault(); requestCreate(); }}>
              <Stack gap={4}>
                <TextInput
                  id="settings-ingest-token-label" labelText="Label" maxLength={64}
                  value={label} disabled={creating} onChange={e => setLabel(e.target.value)}
                />
                {createError && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not create token" subtitle={createError} />}
                <div>
                  <Button type="submit" kind="primary" disabled={creating || !label.trim()} data-testid="ingest-token-create">
                    {creating ? 'Creating…' : 'Create token'}
                  </Button>
                </div>
              </Stack>
            </Form>
          </>
        )}
      </Stack>

      <ConfirmModal
        open={confirmingCreate}
        title={list?.mode === 'env_token' ? 'Replace INGEST_TOKEN?' : 'Turn on ingest authentication?'}
        message="As soon as this token exists, clients using the old setting are rejected until you enter the new token in them."
        confirmLabel="Create"
        onConfirm={() => { setConfirmingCreate(false); void doCreate(); }}
        onCancel={() => setConfirmingCreate(false)}
      />

      <ConfirmModal
        open={revokeTarget !== null}
        danger
        title="Revoke token?"
        message={
          revokeTarget
            ? `“${revokeTarget.label}” (${revokeTarget.public_id}) stops working immediately.`
              + (revokingLastToken ? ' It is the last token: ingest falls back to INGEST_TOKEN if set, otherwise every ingest request is rejected.' : '')
            : ''
        }
        confirmLabel="Revoke"
        onConfirm={() => void doRevoke()}
        onCancel={() => setRevokeTarget(null)}
      />

      <TokenCreatedModal info={created} onClose={() => setCreated(null)} />
    </Tile>
  );
}
