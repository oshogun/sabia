import { useEffect, useState } from 'react';
import {
  Button, Form, InlineNotification, SkeletonText, Stack, Table, TableBody, TableCell, TableContainer,
  TableHead, TableHeader, TableRow, TextInput, Tile,
} from '@carbon/react';
import { createMcpToken, getMcpTokens, revokeMcpToken } from '../../api';
import { UnauthorizedError } from '../../utils/api';
import type { McpTokenListResponse, McpTokenSummary } from '../../types';
import { ConfirmModal } from '../ConfirmModal';
import { TokenCreatedModal, type TokenCreatedInfo } from './TokenCreatedModal';

function formatLastUsed(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : 'Never';
}

/** MCP tokens (Bearer, /mcp): list, create-with-one-time-reveal, revoke. */
export function McpTokensTile() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [list, setList] = useState<McpTokenListResponse | null>(null);

  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [confirmingCreate, setConfirmingCreate] = useState(false);
  const [created, setCreated] = useState<TokenCreatedInfo | null>(null);

  const [revokeTarget, setRevokeTarget] = useState<McpTokenSummary | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState('');

  useEffect(() => {
    let cancelled = false;
    getMcpTokens()
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
      const r = await createMcpToken(trimmed);
      // Keep the secret out of list state: only `created`, below, ever holds it.
      setList({ tokens: r.tokens, mode: r.mode, env_token_set: r.env_token_set });
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
    if (list && list.mode === 'env_token') {
      setConfirmingCreate(true);
      return;
    }
    void doCreate();
  }

  async function doRevoke() {
    if (!revokeTarget) return;
    setRevoking(true); setRevokeError('');
    try {
      setList(await revokeMcpToken(revokeTarget.id));
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
    <Tile data-testid="mcp-tokens-tile">
      <Stack gap={5}>
        <h2 className="sabia-heading-03">MCP tokens</h2>
        <p className="sabia-helper">Bearer tokens for MCP clients at /mcp.</p>
        {loadError && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not load tokens" subtitle={loadError} />}
        {loading ? <SkeletonText /> : list && (
          <>
            {list.mode === 'ui_tokens' && list.env_token_set && (
              <InlineNotification
                kind="info" lowContrast hideCloseButton data-testid="mcp-banner-env-ignored"
                title="MCP_TOKEN is being ignored"
              />
            )}
            {list.mode === 'disabled' && (
              <p className="sabia-helper" data-testid="mcp-mode-disabled">/mcp is off until a token exists.</p>
            )}

            {tokens.length === 0 ? (
              <p data-testid="mcp-tokens-empty">No tokens yet.</p>
            ) : (
              <TableContainer>
                <Table aria-label="MCP tokens">
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
                      <TableRow key={t.id} data-testid={`mcp-token-row-${t.id}`}>
                        <TableCell>{t.label}</TableCell>
                        <TableCell className="sabia-code">{t.public_id}</TableCell>
                        <TableCell>{new Date(t.created_at).toLocaleString()}</TableCell>
                        <TableCell>{formatLastUsed(t.last_used_at)}</TableCell>
                        <TableCell>
                          <Button
                            kind="danger--ghost" size="sm" data-testid={`mcp-token-revoke-${t.id}`}
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
                  id="settings-mcp-token-label" labelText="Label" maxLength={64}
                  value={label} disabled={creating} onChange={e => setLabel(e.target.value)}
                />
                {createError && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not create token" subtitle={createError} />}
                <div>
                  <Button type="submit" kind="primary" disabled={creating || !label.trim()} data-testid="mcp-token-create">
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
        title="Replace MCP_TOKEN?"
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
              + (revokingLastToken ? ' It is the last token: /mcp falls back to MCP_TOKEN if set, otherwise it is disabled.' : '')
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
