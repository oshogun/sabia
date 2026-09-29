import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RouteErrorBoundary } from './RouteErrorBoundary';

function Bomb(): never {
  throw new Error('boom');
}

describe('RouteErrorBoundary', () => {
  it('shows a reload notification instead of the blank page a caught render error would otherwise leave', () => {
    // React logs the caught error to the console on its own; keep the test
    // output focused on the assertion.
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <RouteErrorBoundary>
        <Bomb />
      </RouteErrorBoundary>
    );

    expect(screen.getByText('Could not load this page')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });
});
