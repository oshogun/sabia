import { Link as RouterLink } from 'react-router-dom';
import { Link } from '@carbon/react';
import { EmptyState } from './EmptyState';

/** Shown wherever the flight log is empty: how to connect the sim client and start logging. */
export function FirstFlightEmptyState() {
  return (
    <EmptyState
      title="No flights recorded yet"
      description="Connect the Sabiá MCDU client on your sim PC using an ingest token, then fly. Flights in MSFS 2020, MSFS 2024 and FSX are logged automatically."
      action={<Link as={RouterLink} to="/settings">Create an ingest token in Settings</Link>}
    />
  );
}
