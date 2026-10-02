import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetchRoutes, deferred, type ResponseTuple } from '../../test/mockFetch';
import {
  currentLnmDataset, expiredLnmDataset, expiredNoCycleDataset, mcduDataset, sourceResponse, undatedLnmDataset,
} from '../../test/navdataFixtures';
import type { NavdataSourceResponse } from '../../types';
import { NavdataSourceTile } from './NavdataSourceTile';

const URL = '/api/settings/navdata-source';

function serve(get: NavdataSourceResponse, put?: (body: unknown) => [number, unknown]) {
  mockFetchRoutes({
    [URL]: {
      GET: [200, get],
      ...(put ? { PUT: (init: RequestInit | undefined) => put(JSON.parse(init!.body as string)) } : {}),
    },
  });
}

describe('NavdataSourceTile', () => {
  it('shows a loading placeholder, then both sources with their dataset labels', async () => {
    const d = deferred<ResponseTuple>();
    mockFetchRoutes({ [URL]: d.handler });
    const { container } = render(<NavdataSourceTile />);
    expect(container.querySelector('.cds--skeleton__text')).not.toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();

    d.resolve([200, sourceResponse({ mcdu: { present: true, dataset: { ...mcduDataset, label: 'Simulator (TestSim 1.0)' } } })]);

    expect(await screen.findByRole('radio', { name: 'Simulator (MCDU)' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Little Navmap import' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Simulator (MCDU)' })).toHaveAccessibleDescription('Simulator (TestSim 1.0)');
    expect(container.querySelector('.cds--skeleton__text')).toBeNull();
  });

  it('disables Little Navmap with the reason when nothing was imported, and says so for an empty simulator replica', async () => {
    serve(sourceResponse({ mcdu: { present: false, dataset: null }, lnm: { present: false, dataset: null } }));
    render(<NavdataSourceTile />);

    const lnm = await screen.findByRole('radio', { name: 'Little Navmap import' });
    expect(lnm).toBeDisabled();
    expect(lnm).toHaveAccessibleDescription('Import a Little Navmap database below first');
    expect(screen.getByRole('radio', { name: 'Simulator (MCDU)' })).toBeEnabled();
    expect(screen.getByRole('radio', { name: 'Simulator (MCDU)' })).toHaveAccessibleDescription('Nothing received from the simulator yet');
  });

  it('shows the validity window of a current dataset in the helper, with no expiry warning', async () => {
    serve(sourceResponse());
    render(<NavdataSourceTile />);

    const lnm = await screen.findByRole('radio', { name: 'Little Navmap import' });
    expect(lnm).toBeEnabled();
    expect(lnm).toHaveAccessibleDescription('Navigraph AIRAC 9901 · valid 2099-01-02 – 2099-01-29');
    expect(screen.queryByText('Expired — not for navigation')).toBeNull();
  });

  it('shows no validity for a dataset that has none', async () => {
    serve(sourceResponse({ lnm: { present: true, dataset: undatedLnmDataset } }));
    render(<NavdataSourceTile />);

    expect(await screen.findByRole('radio', { name: 'Little Navmap import' }))
      .toHaveAccessibleDescription('MSFS scenery, compiled 2099-01-01');
  });

  it('warns that an expired dataset is not for navigation, naming its AIRAC cycle', async () => {
    serve(sourceResponse({ lnm: { present: true, dataset: expiredLnmDataset } }));
    render(<NavdataSourceTile />);

    expect(await screen.findByText('Expired — not for navigation')).toBeInTheDocument();
    expect(screen.getByText('AIRAC 2001 was valid until 2020-01-29.')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Little Navmap import' }))
      .toHaveAccessibleDescription('Navigraph AIRAC 2001 · valid 2020-01-02 – 2020-01-29');
  });

  it('names the dataset by its label when an expired one has no AIRAC cycle, never "AIRAC null"', async () => {
    serve(sourceResponse({ lnm: { present: true, dataset: expiredNoCycleDataset } }));
    const { container } = render(<NavdataSourceTile />);

    expect(await screen.findByText('Expired — not for navigation')).toBeInTheDocument();
    expect(screen.getByText('Navigraph build 2020-01 was valid until 2020-01-29.')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Little Navmap import' }))
      .toHaveAccessibleDescription('Navigraph build 2020-01 · valid until 2020-01-29');
    expect(container.textContent).not.toMatch(/AIRAC null|null/);
  });

  it('shows the expiry warning while the simulator is selected', async () => {
    serve(sourceResponse({ selected: 'mcdu', effective: 'mcdu', lnm: { present: true, dataset: expiredLnmDataset } }));
    render(<NavdataSourceTile />);

    expect(await screen.findByText('Expired — not for navigation')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Simulator (MCDU)' })).toBeChecked();
  });

  it('puts the chosen source to the server and shows the answer', async () => {
    const user = userEvent.setup();
    const puts: unknown[] = [];
    serve(sourceResponse(), body => {
      puts.push(body);
      return [200, sourceResponse({ selected: 'lnm', effective: 'lnm' })];
    });
    render(<NavdataSourceTile />);

    await user.click(await screen.findByRole('radio', { name: 'Little Navmap import' }));

    await waitFor(() => expect(screen.getByRole('radio', { name: 'Little Navmap import' })).toBeChecked());
    expect(puts).toEqual([{ source: 'lnm' }]);
    expect(screen.getByRole('radio', { name: 'Simulator (MCDU)' })).not.toBeChecked();
    expect(screen.getByText(/The simulator keeps syncing in the background/)).toBeInTheDocument();
  });

  it('disables the group while saving', async () => {
    const user = userEvent.setup();
    const d = deferred<ResponseTuple>();
    mockFetchRoutes({ [URL]: { GET: [200, sourceResponse()], PUT: d.handler } });
    render(<NavdataSourceTile />);

    await user.click(await screen.findByRole('radio', { name: 'Little Navmap import' }));

    await waitFor(() => expect(screen.getByRole('radio', { name: 'Simulator (MCDU)' })).toBeDisabled());
    expect(screen.getByRole('radio', { name: 'Little Navmap import' })).toBeDisabled();

    d.resolve([200, sourceResponse({ selected: 'lnm', effective: 'lnm' })]);
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Simulator (MCDU)' })).toBeEnabled());
  });

  it('shows the server message and puts the radio back when the switch is refused', async () => {
    const user = userEvent.setup();
    serve(sourceResponse(), () => [409, { error: 'No Little Navmap data has been imported', code: 'LNM_NOT_AVAILABLE' }]);
    render(<NavdataSourceTile />);

    await user.click(await screen.findByRole('radio', { name: 'Little Navmap import' }));

    expect(await screen.findByText('No Little Navmap data has been imported')).toBeInTheDocument();
    expect(screen.getByText('Could not switch')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Simulator (MCDU)' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Little Navmap import' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Simulator (MCDU)' })).toBeEnabled();
  });

  it('clears the error once a later switch works', async () => {
    const user = userEvent.setup();
    let calls = 0;
    serve(sourceResponse(), () => (++calls === 1
      ? [500, { error: 'disk full' }]
      : [200, sourceResponse({ selected: 'lnm', effective: 'lnm' })]));
    render(<NavdataSourceTile />);

    await user.click(await screen.findByRole('radio', { name: 'Little Navmap import' }));
    expect(await screen.findByText('disk full')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Little Navmap import' }));

    await waitFor(() => expect(screen.queryByText('disk full')).toBeNull());
    expect(screen.getByRole('radio', { name: 'Little Navmap import' })).toBeChecked();
  });

  it('warns when Little Navmap data is selected but the simulator data is what answers', async () => {
    serve(sourceResponse({ selected: 'lnm', effective: 'mcdu', fallback: 'lnm-unavailable', lnm: { present: false, dataset: null } }));
    render(<NavdataSourceTile />);

    expect(await screen.findByText('Little Navmap data is selected but unavailable, so the map is showing simulator data.'))
      .toBeInTheDocument();
    expect(screen.queryByText(/The simulator keeps syncing/)).toBeNull();
    expect(screen.getByRole('radio', { name: 'Little Navmap import' })).toBeDisabled();
  });

  it('lets the operator switch back to the simulator from the unavailable state', async () => {
    const user = userEvent.setup();
    const puts: unknown[] = [];
    serve(
      sourceResponse({ selected: 'lnm', effective: 'mcdu', fallback: 'lnm-unavailable', lnm: { present: false, dataset: null } }),
      body => {
        puts.push(body);
        return [200, sourceResponse({ lnm: { present: false, dataset: null } })];
      },
    );
    render(<NavdataSourceTile />);

    await user.click(await screen.findByRole('radio', { name: 'Simulator (MCDU)' }));

    await waitFor(() => expect(screen.queryByText(/is selected but unavailable/)).toBeNull());
    expect(puts).toEqual([{ source: 'mcdu' }]);
    expect(screen.getByRole('radio', { name: 'Simulator (MCDU)' })).toBeChecked();
  });

  it('notes that the simulator keeps syncing only while Little Navmap data is shown', async () => {
    serve(sourceResponse({ selected: 'lnm', effective: 'lnm', lnm: { present: true, dataset: currentLnmDataset } }));
    render(<NavdataSourceTile />);

    expect(await screen.findByText(
      'The simulator keeps syncing in the background, but its data is not shown while Little Navmap is selected.'
    )).toBeInTheDocument();
    expect(screen.queryByText(/is selected but unavailable/)).toBeNull();
  });

  it('shows the load error instead of the radios when the source cannot be read', async () => {
    mockFetchRoutes({ [URL]: [500, { error: 'navdata store unreadable' }] });
    render(<NavdataSourceTile />);

    expect(await screen.findByText('navdata store unreadable')).toBeInTheDocument();
    expect(screen.getByText('Could not load navigation data')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('reloads when the refresh key changes', async () => {
    let imported = false;
    mockFetchRoutes({
      [URL]: () => [200, imported
        ? sourceResponse()
        : sourceResponse({ lnm: { present: false, dataset: null } })],
    });
    const { rerender } = render(<NavdataSourceTile navdataRefreshKey={0} />);
    expect(await screen.findByRole('radio', { name: 'Little Navmap import' })).toBeDisabled();

    imported = true;
    rerender(<NavdataSourceTile navdataRefreshKey={1} />);

    await waitFor(() => expect(screen.getByRole('radio', { name: 'Little Navmap import' })).toBeEnabled());
  });
  it('hides the previous answer behind the loading placeholder while a reload is pending', async () => {
    const second = deferred<ResponseTuple>();
    let gets = 0;
    mockFetchRoutes({ [URL]: () => (++gets === 1 ? [200, sourceResponse({ lnm: { present: false, dataset: null } })] : second.handler()) });
    const { container, rerender } = render(<NavdataSourceTile navdataRefreshKey={0} />);
    expect(await screen.findByRole('radio', { name: 'Little Navmap import' })).toBeDisabled();

    rerender(<NavdataSourceTile navdataRefreshKey={1} />);

    await waitFor(() => expect(container.querySelector('.cds--skeleton__text')).not.toBeNull());
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByText('Import a Little Navmap database below first')).toBeNull();

    second.resolve([200, sourceResponse()]);
    expect(await screen.findByRole('radio', { name: 'Little Navmap import' })).toBeEnabled();
    expect(container.querySelector('.cds--skeleton__text')).toBeNull();
  });

  it('reports every answer it shows: the loaded one, then the one that follows a switch', async () => {
    const user = userEvent.setup();
    const onLoaded = vi.fn();
    serve(sourceResponse(), () => [200, sourceResponse({ selected: 'lnm', effective: 'lnm' })]);
    render(<NavdataSourceTile onLoaded={onLoaded} />);

    await screen.findByRole('radio', { name: 'Little Navmap import' });
    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(onLoaded.mock.calls[0][0].effective).toBe('mcdu');

    await user.click(screen.getByRole('radio', { name: 'Little Navmap import' }));

    await waitFor(() => expect(onLoaded).toHaveBeenCalledTimes(2));
    expect(onLoaded.mock.calls[1][0].effective).toBe('lnm');
  });

  it('does not reload when the parent passes a new callback on every render', async () => {
    let gets = 0;
    mockFetchRoutes({ [URL]: () => { gets++; return [200, sourceResponse()]; } });
    const { rerender } = render(<NavdataSourceTile onLoaded={() => {}} />);
    await screen.findByRole('radio', { name: 'Little Navmap import' });

    rerender(<NavdataSourceTile onLoaded={() => {}} />);
    rerender(<NavdataSourceTile onLoaded={() => {}} />);

    expect(gets).toBe(1);
    expect(screen.getByRole('radio', { name: 'Little Navmap import' })).toBeInTheDocument();
  });
});
