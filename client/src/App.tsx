import { lazy, Suspense } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { InlineLoading } from '@carbon/react';
import { AppShell } from './shell/AppShell';
import { RequireAuth } from './shell/RequireAuth';
import { LiveEventsProvider } from './shell/LiveEventsProvider';
import { RouteErrorBoundary } from './shell/RouteErrorBoundary';
import { SessionProvider, useSession } from './shell/SessionContext';
import { useLiveStatus } from './shell/useLiveStatus';
import { useNavTree } from './shell/useNavTree';
import { Home } from './pages/Home';
import { Login } from './pages/Login';

// Everything but Home and Login is loaded on demand, so the first paint
// (including the login screen) never pulls in the heavier pages or Leaflet.
const AllFlights = lazy(() => import('./pages/AllFlights').then((m) => ({ default: m.AllFlights })));
const Prefiles = lazy(() => import('./pages/Prefiles').then((m) => ({ default: m.Prefiles })));
const FlightDetail = lazy(() => import('./pages/FlightDetail').then((m) => ({ default: m.FlightDetail })));
const AcarsMessages = lazy(() => import('./pages/AcarsMessages').then((m) => ({ default: m.AcarsMessages })));
const TripDetail = lazy(() => import('./pages/TripDetail').then((m) => ({ default: m.TripDetail })));
const Device = lazy(() => import('./pages/Device').then((m) => ({ default: m.Device })));
const Override = lazy(() => import('./pages/Override').then((m) => ({ default: m.Override })));
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })));

function ShellRoutes() {
  const session = useSession();
  const navigate = useNavigate();
  const live = useLiveStatus();
  const nav = useNavTree();
  const location = useLocation();

  async function handleLogout() {
    await session.logout();
    navigate('/login');
  }

  return (
    <AppShell
      live={live}
      username={session.user?.username ?? null}
      onLogout={handleLogout}
      trips={nav.trips}
      looseFlights={nav.loose}
    >
      <RouteErrorBoundary key={location.pathname}>
        <Suspense fallback={<InlineLoading description="Loading…" />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/flights" element={<AllFlights />} />
            <Route path="/prefiles" element={<Prefiles />} />
            <Route path="/flight/:id" element={<FlightDetail />} />
            <Route path="/flight/:id/acars" element={<AcarsMessages />} />
            <Route path="/planned-leg/:legId/acars" element={<AcarsMessages />} />
            <Route path="/trip/:id" element={<TripDetail />} />
            <Route path="/device" element={<Device />} />
            <Route path="/override" element={<Override />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </Suspense>
      </RouteErrorBoundary>
    </AppShell>
  );
}

export function App() {
  return (
    <SessionProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="*"
          element={
            <RequireAuth>
              <LiveEventsProvider>
                <ShellRoutes />
              </LiveEventsProvider>
            </RequireAuth>
          }
        />
      </Routes>
    </SessionProvider>
  );
}
