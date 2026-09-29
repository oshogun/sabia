import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles/index.scss';

// A route rebuild (a deploy while this tab was already open) leaves a lazy
// page chunk requesting a hash that no longer exists on disk. Vite reports
// that as this event rather than letting the import rejection reach the
// error boundary silently; reloading picks up the new build. Guarded by a
// timestamp in sessionStorage so a build that's actually broken (not just
// stale) can't reload forever — if the storage itself is unavailable, skip
// the reload rather than risk looping with no way to tell.
const PRELOAD_RELOAD_GUARD_KEY = 'sabia:lastPreloadReload';
const PRELOAD_RELOAD_GUARD_MS = 10_000;

window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  try {
    const last = Number(sessionStorage.getItem(PRELOAD_RELOAD_GUARD_KEY) ?? '0');
    if (Date.now() - last < PRELOAD_RELOAD_GUARD_MS) return;
    sessionStorage.setItem(PRELOAD_RELOAD_GUARD_KEY, String(Date.now()));
  } catch {
    return;
  }
  window.location.reload();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
