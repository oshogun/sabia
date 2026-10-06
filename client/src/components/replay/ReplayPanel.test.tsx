import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { FlightPoint } from '../../types';
import { ReplayPanel } from './ReplayPanel';

const T0 = Date.parse('2026-01-01T12:00:00.000Z');

function pt(i: number, over: Partial<FlightPoint> = {}): FlightPoint {
  return {
    id: i,
    flight_id: 1,
    ts: new Date(T0 + i * 5000).toISOString(),
    lat: 50 + i * 0.01,
    lon: 8 + i * 0.01,
    altitude_ft: 100 + i * 100,
    airspeed_kts: 100 + i,
    ground_speed_kts: 110 + i,
    heading_deg: 90,
    vertical_speed_fpm: 0,
    on_ground: i === 0 ? 1 : 0,
    ...over,
  };
}

const track = (n: number) => Array.from({ length: n }, (_, i) => pt(i));
const field = (name: string) =>
  document.querySelector<HTMLElement>(`[data-field="${name}"]`)!.textContent;

// Carbon's Slider is keyboard- and pointer-driven, not a native range input:
// there is nothing an `input`-style `fireEvent.change` can target. Its own
// keydown handler moves it by `step` (`shiftKey` multiplies by
// `stepMultiplier`), which is the same 0.5 s per press this panel wires up.
const SCRUB_STEP_SEC = 0.5;
function scrubTo(handle: HTMLElement, deltaSec: number) {
  const presses = Math.round(deltaSec / SCRUB_STEP_SEC);
  for (let i = 0; i < presses; i++) {
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
  }
}

// jsdom has no layout engine, so Carbon's Dropdown can't scroll a highlighted
// option into view when one is selected via keyboard/click; stub it out so
// that doesn't throw.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

describe('ReplayPanel', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders play, scrubber, speed and follow controls by accessible name', () => {
    render(<ReplayPanel points={track(10)} />);
    expect(screen.getByRole('button', { name: 'Play replay' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Replay position' })).toBeInTheDocument();
    const speed = screen.getByRole('combobox', { name: 'Replay speed' });
    expect(speed).toHaveTextContent('16×');
    expect(screen.getByRole('checkbox', { name: /Follow aircraft/ })).toBeChecked();
  });

  it('shows the first point in the readout on mount', () => {
    render(<ReplayPanel points={track(10)} />);
    expect(field('alt')).toBe('100 ft');
    expect(field('ias')).toBe('100 kt');
    expect(field('gs')).toBe('110 kt');
    expect(field('hdg')).toBe('090°');
    expect(field('state')).toBe('On ground');
    expect(field('point')).toBe('1 / 10');
    expect(field('time')).toBe('12:00:00Z');
  });

  // Drives the scrubber through many renders, which exceeds the 5 s default on a busy machine.
  it('updates the readout from the scrubber without starting playback', { timeout: 20_000 }, () => {
    render(<ReplayPanel points={track(10)} />);
    scrubTo(screen.getByRole('slider', { name: 'Replay position' }), 10);
    expect(field('time')).toBe('12:00:10Z');
    expect(field('alt')).toBe('300 ft');
    expect(field('state')).toBe('Airborne');
    expect(screen.getByRole('button', { name: 'Play replay' })).toBeInTheDocument();
  });

  it('advances on play and freezes on pause', () => {
    vi.useFakeTimers();
    render(<ReplayPanel points={track(200)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play replay' }));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    const advanced = field('time');
    expect(advanced).not.toBe('12:00:00Z');
    fireEvent.click(screen.getByRole('button', { name: 'Pause replay' }));
    const frozen = field('time');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(field('time')).toBe(frozen);
  });

  it('shows Restart after reaching the end, and the same button plays again from the start', () => {
    vi.useFakeTimers();
    render(<ReplayPanel points={track(3)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play replay' }));
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(field('point')).toBe('3 / 3');
    const restart = screen.getByRole('button', { name: 'Restart replay' });
    fireEvent.click(restart);
    expect(screen.getByRole('button', { name: 'Pause replay' })).toBeInTheDocument();
    expect(field('point')).toBe('1 / 3');
  });

  it('shows a status tag that follows the play/pause/end lifecycle', () => {
    vi.useFakeTimers();
    render(<ReplayPanel points={track(3)} />);
    expect(screen.getByText('Idle')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Play replay' }));
    expect(screen.getByText('Playing')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pause replay' }));
    expect(screen.getByText('Paused')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Play replay' }));
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText('Ended')).toBeInTheDocument();
  });

  it('picking a faster speed advances the readout further for the same elapsed time', () => {
    vi.useFakeTimers();
    render(<ReplayPanel points={track(200)} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Replay speed' }));
    fireEvent.click(screen.getByText('64×'));
    fireEvent.click(screen.getByRole('button', { name: 'Play replay' }));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // At the default 16x, one second of wall-clock time only reaches the
    // track's 4th point (5 s apart); at 64x it must be well past that.
    const reached = Number(field('point')!.split(' / ')[0]);
    expect(reached).toBeGreaterThan(8);
  });

  it('reports every tick through onPosition, and the follow toggle through onFollowChange', () => {
    const positions: number[] = [];
    const follows: boolean[] = [];
    render(
      <ReplayPanel
        points={track(10)}
        onPosition={s => positions.push(s.pointIndex)}
        onFollowChange={f => follows.push(f)}
      />
    );
    expect(positions).toEqual([0]);
    expect(follows).toEqual([true]);

    fireEvent.click(screen.getByRole('checkbox', { name: /Follow aircraft/ }));
    expect(follows).toEqual([true, false]);

    scrubTo(screen.getByRole('slider', { name: 'Replay position' }), 10);
    expect(positions.at(-1)).toBe(2);
  });

  it('handles Space, ArrowRight, and ignores keys from the scrubber', () => {
    render(<ReplayPanel points={track(200)} />);
    const panel = screen.getByRole('region', { name: 'Flight replay' });
    fireEvent.keyDown(panel, { key: ' ' });
    expect(screen.getByRole('button', { name: 'Pause replay' })).toBeInTheDocument();
    fireEvent.keyDown(panel, { key: ' ' });
    expect(screen.getByRole('button', { name: 'Play replay' })).toBeInTheDocument();

    fireEvent.keyDown(panel, { key: 'ArrowRight' });
    expect(field('time')).toBe('12:00:05Z');

    fireEvent.keyDown(screen.getByRole('slider', { name: 'Replay position' }), { key: 'ArrowRight' });
    expect(field('time')).toBe('12:00:05Z');
  });

  it('renders a track that is entirely recording gaps without NaN', () => {
    const pts = [0, 1, 2].map(i => pt(i, { ts: new Date(T0 + i * 3600_000).toISOString() }));
    render(<ReplayPanel points={pts} />);
    scrubTo(screen.getByRole('slider', { name: 'Replay position' }), 1);
    expect(field('state')).toMatch(/^Recording gap — /);
    for (const f of ['alt', 'ias', 'gs', 'vs', 'hdg', 'time']) {
      expect(field(f)).not.toMatch(/NaN/);
    }
  });

  it('says so when no point is usable', () => {
    render(<ReplayPanel points={[pt(0, { ts: 'bad' }), pt(1, { ts: 'bad' })]} />);
    expect(screen.getByText(/No replayable GPS points/)).toBeInTheDocument();
  });
});
