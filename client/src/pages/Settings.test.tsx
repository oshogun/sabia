import { describe, it, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/renderWithProviders';
import { mockFetchRoutes } from '../test/mockFetch';
import type { ResponseTuple } from '../test/mockFetch';
import { Settings } from './Settings';

const SESSION_ROUTE: ResponseTuple = [200, { authenticated: true, user: { username: 'e2e' } }];
const UNSET_SIMBRIEF: ResponseTuple = [200, { simbrief_user_id: null }];
const NO_SAYINTENTIONS: ResponseTuple = [200, { sayintentions_api_key_set: false, sayintentions_api_key_masked: null }];
const SET_SAYINTENTIONS: ResponseTuple = [200, { sayintentions_api_key_set: true, sayintentions_api_key_masked: '••••cdef' }];
const CLOSED_INGEST: ResponseTuple = [200, { tokens: [], mode: 'closed', env_token_set: false, unauthenticated_opt_out_set: false }];
const DISABLED_MCP: ResponseTuple = [200, { tokens: [], mode: 'disabled', env_token_set: false }];

/**
 * Every ConfirmModal/TokenCreatedModal on the page is always in the DOM
 * (Carbon's Modal toggles a CSS class rather than mounting/unmounting), so
 * with two token tiles there is more than one `role="dialog"` node at once.
 * This picks the one actually showing.
 */
function openDialog(): HTMLElement {
  const open = screen.getAllByRole('dialog').find(d => d.parentElement?.classList.contains('is-visible'));
  if (!open) throw new Error('no open dialog found');
  return open;
}

describe('Settings', () => {
  it('loads and shows the saved SimBrief pilot ID and the SayIntentions status', async () => {
    mockFetchRoutes({
      '/api/auth/session': SESSION_ROUTE,
      '/api/settings/simbrief': [200, { simbrief_user_id: 'e2e-simbrief-id' }],
      '/api/settings/sayintentions': SET_SAYINTENTIONS,
      '/api/settings/ingest-tokens': CLOSED_INGEST,
      '/api/settings/mcp-tokens': DISABLED_MCP,
    });

    renderWithProviders(<Settings />);

    expect(await screen.findByDisplayValue('e2e-simbrief-id')).toBeInTheDocument();
    expect(screen.getByTestId('si-status')).toHaveTextContent('Saved: ••••cdef');
  });

  it('trims and saves a new SimBrief pilot ID, showing the server echo', async () => {
    const user = userEvent.setup();
    const puts: unknown[] = [];
    mockFetchRoutes({
      '/api/auth/session': SESSION_ROUTE,
      '/api/settings/simbrief': {
        GET: UNSET_SIMBRIEF,
        PUT: init => {
          puts.push(JSON.parse(init!.body as string));
          return [200, { simbrief_user_id: 'trimmed-id' }];
        },
      },
      '/api/settings/sayintentions': NO_SAYINTENTIONS,
      '/api/settings/ingest-tokens': CLOSED_INGEST,
      '/api/settings/mcp-tokens': DISABLED_MCP,
    });

    renderWithProviders(<Settings />);

    const input = await screen.findByLabelText('SimBrief Pilot ID');
    await user.type(input, '  trimmed-id  ');
    await user.click(screen.getAllByRole('button', { name: 'Save' })[0]);

    await waitFor(() => expect(screen.getByText('SimBrief pilot ID saved.')).toBeInTheDocument());
    expect(puts).toEqual([{ simbrief_user_id: 'trimmed-id' }]);
    expect(screen.getByDisplayValue('trimmed-id')).toBeInTheDocument();
  });

  it('saves a SayIntentions key, then clears it', async () => {
    const user = userEvent.setup();
    const puts: unknown[] = [];
    mockFetchRoutes({
      '/api/auth/session': SESSION_ROUTE,
      '/api/settings/simbrief': UNSET_SIMBRIEF,
      '/api/settings/sayintentions': {
        GET: NO_SAYINTENTIONS,
        PUT: init => {
          const body = JSON.parse(init!.body as string);
          puts.push(body);
          return body.sayintentions_api_key === null ? NO_SAYINTENTIONS : SET_SAYINTENTIONS;
        },
      },
      '/api/settings/ingest-tokens': CLOSED_INGEST,
      '/api/settings/mcp-tokens': DISABLED_MCP,
    });

    renderWithProviders(<Settings />);

    const keyInput = await screen.findByLabelText('SayIntentions API Key');
    await user.type(keyInput, 'sk-live-abcdef');
    const saveButtons = screen.getAllByRole('button', { name: 'Save' });
    await user.click(saveButtons[saveButtons.length - 1]);

    await waitFor(() => expect(screen.getByText('SayIntentions API key saved.')).toBeInTheDocument());
    expect(screen.getByTestId('si-status')).toHaveTextContent('Saved: ••••cdef');

    await user.click(screen.getByRole('button', { name: 'Clear' }));

    await waitFor(() => expect(screen.getByText('SayIntentions API key cleared.')).toBeInTheDocument());
    expect(screen.getByTestId('si-status')).toHaveTextContent('No key saved');
    expect(puts).toEqual([{ sayintentions_api_key: 'sk-live-abcdef' }, { sayintentions_api_key: null }]);
  });

  it('shows the SimBrief save error inline instead of throwing', async () => {
    const user = userEvent.setup();
    mockFetchRoutes({
      '/api/auth/session': SESSION_ROUTE,
      '/api/settings/simbrief': {
        GET: UNSET_SIMBRIEF,
        PUT: [500, { error: 'Database is locked' }],
      },
      '/api/settings/sayintentions': NO_SAYINTENTIONS,
      '/api/settings/ingest-tokens': CLOSED_INGEST,
      '/api/settings/mcp-tokens': DISABLED_MCP,
    });

    renderWithProviders(<Settings />);

    const input = await screen.findByLabelText('SimBrief Pilot ID');
    await user.type(input, 'e2e-id');
    await user.click(screen.getAllByRole('button', { name: 'Save' })[0]);

    await waitFor(() => expect(screen.getByText('Database is locked')).toBeInTheDocument());
  });

  it('shows the ingest closed banner with no tokens, and the env-ignored banner once one exists alongside INGEST_TOKEN', async () => {
    mockFetchRoutes({
      '/api/auth/session': SESSION_ROUTE,
      '/api/settings/simbrief': UNSET_SIMBRIEF,
      '/api/settings/sayintentions': NO_SAYINTENTIONS,
      '/api/settings/ingest-tokens': CLOSED_INGEST,
      '/api/settings/mcp-tokens': DISABLED_MCP,
    });

    renderWithProviders(<Settings />);

    expect(await screen.findByTestId('ingest-banner-closed')).toBeInTheDocument();
    expect(screen.queryByTestId('ingest-banner-env-ignored')).not.toBeInTheDocument();
    expect(screen.getByTestId('ingest-tokens-empty')).toBeInTheDocument();
  });

  it('shows the INGEST_TOKEN-ignored banner and the token row when a UI token coexists with the env var', async () => {
    mockFetchRoutes({
      '/api/auth/session': SESSION_ROUTE,
      '/api/settings/simbrief': UNSET_SIMBRIEF,
      '/api/settings/sayintentions': NO_SAYINTENTIONS,
      '/api/settings/ingest-tokens': [200, {
        tokens: [{ id: 7, public_id: 'abcd1234', label: 'MCDU main', created_at: '2026-01-01T00:00:00.000Z', last_used_at: null }],
        mode: 'ui_tokens',
        env_token_set: true,
        unauthenticated_opt_out_set: false,
      }],
      '/api/settings/mcp-tokens': DISABLED_MCP,
    });

    renderWithProviders(<Settings />);

    expect(await screen.findByTestId('ingest-banner-env-ignored')).toBeInTheDocument();
    expect(screen.queryByTestId('ingest-banner-closed')).not.toBeInTheDocument();
    expect(screen.getByTestId('ingest-token-row-7')).toHaveTextContent('MCDU main');
    expect(screen.getByTestId('ingest-token-row-7')).toHaveTextContent('abcd1234');
  });

  it('creates an ingest token, reveals the plaintext once, and clears it from the DOM on Done, with no stale plaintext on a second create', async () => {
    const user = userEvent.setup();
    let ingestTokens: Array<{ id: number; public_id: string; label: string; created_at: string; last_used_at: string | null }> = [];
    let nextId = 1;
    mockFetchRoutes({
      '/api/auth/session': SESSION_ROUTE,
      '/api/settings/simbrief': UNSET_SIMBRIEF,
      '/api/settings/sayintentions': NO_SAYINTENTIONS,
      '/api/settings/mcp-tokens': DISABLED_MCP,
      '/api/settings/ingest-tokens': {
        GET: CLOSED_INGEST,
        POST: init => {
          const { label } = JSON.parse(init!.body as string) as { label: string };
          const id = nextId++;
          const token = { id, public_id: `pub${id}`, label, created_at: '2026-01-01T00:00:00.000Z', last_used_at: null };
          ingestTokens = [...ingestTokens, token];
          return [201, {
            tokens: ingestTokens,
            mode: 'ui_tokens',
            env_token_set: false,
            unauthenticated_opt_out_set: false,
            created: token,
            secret: `secret-for-${label}`,
          }];
        },
      },
    });

    renderWithProviders(<Settings />);
    const tile = await screen.findByTestId('ingest-tokens-tile');

    await user.type(within(tile).getByLabelText('Label'), 'First token');
    await user.click(screen.getByTestId('ingest-token-create'));

    await waitFor(() => expect(screen.getByTestId('token-created-value')).toHaveTextContent('secret-for-First token'));
    await user.click(within(openDialog()).getByRole('button', { name: 'Done' }));

    expect(screen.queryByTestId('token-created-value')).not.toBeInTheDocument();
    expect(screen.queryByText('secret-for-First token')).not.toBeInTheDocument();

    await user.type(within(tile).getByLabelText('Label'), 'Second token');
    await user.click(screen.getByTestId('ingest-token-create'));

    await waitFor(() => expect(screen.getByTestId('token-created-value')).toHaveTextContent('secret-for-Second token'));
    expect(screen.queryByText('secret-for-First token')).not.toBeInTheDocument();
  });

  it('revokes an ingest token via the confirm modal and removes it from the list', async () => {
    const user = userEvent.setup();
    mockFetchRoutes({
      '/api/auth/session': SESSION_ROUTE,
      '/api/settings/simbrief': UNSET_SIMBRIEF,
      '/api/settings/sayintentions': NO_SAYINTENTIONS,
      '/api/settings/mcp-tokens': DISABLED_MCP,
      '/api/settings/ingest-tokens': {
        GET: [200, {
          tokens: [{ id: 7, public_id: 'abcd1234', label: 'MCDU main', created_at: '2026-01-01T00:00:00.000Z', last_used_at: null }],
          mode: 'ui_tokens',
          env_token_set: false,
          unauthenticated_opt_out_set: false,
        }],
      },
      '/api/settings/ingest-tokens/7': {
        DELETE: CLOSED_INGEST,
      },
    });

    renderWithProviders(<Settings />);
    await screen.findByTestId('ingest-token-row-7');

    await user.click(screen.getByTestId('ingest-token-revoke-7'));
    const dialog = openDialog();
    expect(dialog).toHaveTextContent('MCDU main');
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(screen.queryByTestId('ingest-token-row-7')).not.toBeInTheDocument());
    expect(screen.getByTestId('ingest-tokens-empty')).toBeInTheDocument();
  });

  it('shows the MCP_TOKEN-ignored banner and the token list, then creates and revokes an MCP token', async () => {
    const user = userEvent.setup();
    let mcpTokens: Array<{ id: number; public_id: string; label: string; created_at: string; last_used_at: string | null }> = [
      { id: 3, public_id: 'mcp00003', label: 'Copilot', created_at: '2026-01-01T00:00:00.000Z', last_used_at: null },
    ];
    mockFetchRoutes({
      '/api/auth/session': SESSION_ROUTE,
      '/api/settings/simbrief': UNSET_SIMBRIEF,
      '/api/settings/sayintentions': NO_SAYINTENTIONS,
      '/api/settings/ingest-tokens': CLOSED_INGEST,
      '/api/settings/mcp-tokens': {
        GET: () => [200, { tokens: mcpTokens, mode: 'ui_tokens', env_token_set: true }],
        POST: init => {
          const { label } = JSON.parse(init!.body as string) as { label: string };
          const token = { id: 9, public_id: 'mcp00009', label, created_at: '2026-01-02T00:00:00.000Z', last_used_at: null };
          mcpTokens = [...mcpTokens, token];
          return [201, { tokens: mcpTokens, mode: 'ui_tokens', env_token_set: true, created: token, secret: 'mcp-secret-xyz' }];
        },
      },
      '/api/settings/mcp-tokens/3': {
        DELETE: () => {
          mcpTokens = mcpTokens.filter(t => t.id !== 3);
          return [200, { tokens: mcpTokens, mode: 'ui_tokens', env_token_set: true }];
        },
      },
    });

    renderWithProviders(<Settings />);
    const tile = await screen.findByTestId('mcp-tokens-tile');

    expect(within(tile).getByTestId('mcp-banner-env-ignored')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-token-row-3')).toHaveTextContent('Copilot');

    await user.type(within(tile).getByLabelText('Label'), 'New MCP client');
    await user.click(screen.getByTestId('mcp-token-create'));
    await waitFor(() => expect(screen.getByTestId('token-created-value')).toHaveTextContent('mcp-secret-xyz'));
    await user.click(within(openDialog()).getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('mcp-secret-xyz')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('mcp-token-revoke-3'));
    const dialog = openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(screen.queryByTestId('mcp-token-row-3')).not.toBeInTheDocument());
  });

  it('rejects a mismatched password confirmation client-side, without calling the API', async () => {
    const user = userEvent.setup();
    let passwordCalls = 0;
    mockFetchRoutes({
      '/api/auth/session': SESSION_ROUTE,
      '/api/settings/simbrief': UNSET_SIMBRIEF,
      '/api/settings/sayintentions': NO_SAYINTENTIONS,
      '/api/settings/ingest-tokens': CLOSED_INGEST,
      '/api/settings/mcp-tokens': DISABLED_MCP,
      '/api/settings/password': () => { passwordCalls++; return [200, { ok: true, other_sessions_revoked: 0 }]; },
    });

    renderWithProviders(<Settings />);
    const tile = await screen.findByTestId('password-tile');

    await user.type(within(tile).getByLabelText('Current password'), 'currentpass1');
    await user.type(within(tile).getByLabelText('New password'), 'newpassword1');
    await user.type(within(tile).getByLabelText('Confirm new password'), 'somethingelse');
    await user.click(screen.getByTestId('password-submit'));

    expect(await screen.findByTestId('password-mismatch')).toBeInTheDocument();
    expect(passwordCalls).toBe(0);
  });

  it('shows the server error inline on a wrong current password (403), without navigating away', async () => {
    const user = userEvent.setup();
    mockFetchRoutes({
      '/api/auth/session': SESSION_ROUTE,
      '/api/settings/simbrief': UNSET_SIMBRIEF,
      '/api/settings/sayintentions': NO_SAYINTENTIONS,
      '/api/settings/ingest-tokens': CLOSED_INGEST,
      '/api/settings/mcp-tokens': DISABLED_MCP,
      '/api/settings/password': [403, { error: 'Current password is incorrect', code: 'WRONG_CURRENT_PASSWORD' }],
    });

    renderWithProviders(<Settings />);
    const tile = await screen.findByTestId('password-tile');

    await user.type(within(tile).getByLabelText('Current password'), 'wrongpass123');
    await user.type(within(tile).getByLabelText('New password'), 'newpassword1');
    await user.type(within(tile).getByLabelText('Confirm new password'), 'newpassword1');
    await user.click(screen.getByTestId('password-submit'));

    await waitFor(() => expect(screen.getByText('Current password is incorrect')).toBeInTheDocument());
    expect(screen.getByTestId('password-tile')).toBeInTheDocument();
  });

  it('changes the password on success, showing the revoked-session count and clearing the fields', async () => {
    const user = userEvent.setup();
    mockFetchRoutes({
      '/api/auth/session': SESSION_ROUTE,
      '/api/settings/simbrief': UNSET_SIMBRIEF,
      '/api/settings/sayintentions': NO_SAYINTENTIONS,
      '/api/settings/ingest-tokens': CLOSED_INGEST,
      '/api/settings/mcp-tokens': DISABLED_MCP,
      '/api/settings/password': [200, { ok: true, other_sessions_revoked: 2 }],
    });

    renderWithProviders(<Settings />);
    const tile = await screen.findByTestId('password-tile');

    const currentInput = within(tile).getByLabelText('Current password');
    const newInput = within(tile).getByLabelText('New password');
    const confirmInput = within(tile).getByLabelText('Confirm new password');
    await user.type(currentInput, 'currentpass1');
    await user.type(newInput, 'newpassword1');
    await user.type(confirmInput, 'newpassword1');
    await user.click(screen.getByTestId('password-submit'));

    await waitFor(() => expect(screen.getByText('Password changed. 2 other session(s) were signed out.')).toBeInTheDocument());
    expect(currentInput).toHaveValue('');
    expect(newInput).toHaveValue('');
    expect(confirmInput).toHaveValue('');
  });
});
