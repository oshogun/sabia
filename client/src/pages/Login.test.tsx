import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Login } from './Login';
import { SessionProvider } from '../shell/SessionContext';
import { formatDuration } from '../utils/format';
import { mockFetchRoutes } from '../test/mockFetch';
import type { ResponseTuple } from '../test/mockFetch';

const ANONYMOUS_SESSION: ResponseTuple = [200, { authenticated: false, user: null }];

/**
 * Carbon's `TextInput` always renders its own (empty, unless a character
 * counter is enabled) `role="alert"` span, so a query for "the error alert"
 * has to skip that one and find the one with actual text in it.
 */
function nonEmptyAlerts(): HTMLElement[] {
  return screen.queryAllByRole('alert').filter(el => el.textContent?.trim());
}

/**
 * One test proving the whole component-test harness works end to end:
 * jsdom + React Testing Library render a real page, the stubbed global
 * `fetch` answers the calls that page's own hooks make, and a real app
 * utility import resolves correctly under this config.
 */
// This test renders the Login page and submits the form through the stubbed
// fetch, which can exceed the 5 s default on a heavily loaded machine.
describe('component test harness smoke test', { timeout: 20_000 }, () => {
  it('renders Login, submits real credentials through the stubbed fetch, and formats a duration', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url === '/api/auth/session' && (!init || init.method === undefined)) {
          return new Response(JSON.stringify({ authenticated: false, user: null }), { status: 200 });
        }
        if (url === '/api/auth/login' && init?.method === 'POST') {
          return new Response(JSON.stringify({ user: { username: 'operator' } }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: 'unexpected fetch ' + url }), { status: 500 });
      })
    );

    render(
      <MemoryRouter initialEntries={['/login']}>
        <SessionProvider>
          <Login />
        </SessionProvider>
      </MemoryRouter>
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/username/i), 'operator');
    await user.type(screen.getByLabelText('Password'), 'e2e-password-123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(calls.some(c => c.url === '/api/auth/login')).toBe(true);
    });
    expect(nonEmptyAlerts()).toHaveLength(0);

    const loginCall = calls.find(c => c.url === '/api/auth/login');
    expect(loginCall?.init?.body).toBe(JSON.stringify({ username: 'operator', password: 'e2e-password-123' }));

    expect(formatDuration(3725)).toBe('1h 02m');
  });
});

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <SessionProvider>
        <Login />
      </SessionProvider>
    </MemoryRouter>
  );
}

describe('failed login', () => {
  it('renders the server\'s 401 error message', async () => {
    mockFetchRoutes({
      '/api/auth/session': ANONYMOUS_SESSION,
      '/api/auth/login': [401, { error: 'Invalid username or password' }],
    });

    renderLogin();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/username/i), 'operator');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(nonEmptyAlerts()).toHaveLength(1));
    expect(nonEmptyAlerts()[0]).toHaveTextContent('Invalid username or password');
  });

  it('renders a 429 throttle message the same way, verbatim', async () => {
    mockFetchRoutes({
      '/api/auth/session': ANONYMOUS_SESSION,
      '/api/auth/login': [429, { error: 'Too many login attempts. Try again in 30 seconds.', retryAfterSec: 30 }],
    });

    renderLogin();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/username/i), 'operator');
    await user.type(screen.getByLabelText('Password'), 'whatever');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(nonEmptyAlerts()).toHaveLength(1));
    expect(nonEmptyAlerts()[0]).toHaveTextContent('Too many login attempts. Try again in 30 seconds.');
  });
});

describe('client-side validation', () => {
  it('never calls the login endpoint when both fields are left empty', async () => {
    mockFetchRoutes({ '/api/auth/session': ANONYMOUS_SESSION });

    renderLogin();
    await userEvent.setup().click(screen.getByRole('button', { name: /sign in/i }));

    // required on both <input>s stops the browser from ever dispatching
    // submit — so the network call this test really cares about (login)
    // must never have gone out.
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/auth/session')).toBe(true);
    });
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/auth/login')).toBe(false);
    expect(nonEmptyAlerts()).toHaveLength(0);
  });

  it('never calls the login endpoint when the password is left empty', async () => {
    mockFetchRoutes({ '/api/auth/session': ANONYMOUS_SESSION });

    renderLogin();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/username/i), 'operator');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/auth/login')).toBe(false);
  });

  it('never calls the login endpoint when the username is left empty', async () => {
    mockFetchRoutes({ '/api/auth/session': ANONYMOUS_SESSION });

    renderLogin();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Password'), 'e2e-password-123');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/auth/login')).toBe(false);
  });
});
