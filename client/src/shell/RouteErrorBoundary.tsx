import { Component, type ReactNode } from 'react';
import { Button, InlineNotification } from '@carbon/react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Catches a render error from the routed content below it — most notably a
 * lazy page chunk that 404s because the client was rebuilt while this tab
 * stayed open — and offers a reload instead of leaving the page blank.
 * `appEntry.tsx`'s own `vite:preloadError` handler already reloads once for
 * that exact case; this is the fallback for when that guard skipped the
 * reload (a second failure within its cooldown) or the error isn't a chunk
 * load at all.
 *
 * Error boundaries only catch what React re-renders under them, so key this
 * by the route pathname where it's mounted — navigating to a different
 * route remounts it fresh instead of leaving it stuck showing the old error.
 */
export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <>
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Could not load this page"
            subtitle="Sabiá may have been updated. Reload to get the latest version."
          />
          <Button kind="tertiary" size="sm" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </>
      );
    }
    return this.props.children;
  }
}
