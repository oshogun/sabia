import type { ReactNode } from 'react';
import { Tile } from '@carbon/react';

export interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <Tile style={{ textAlign: 'center', padding: '3rem 1rem' }}>
      <p className="sabia-heading-03">{title}</p>
      {description && (
        <p className="sabia-helper" style={{ marginTop: '0.5rem' }}>{description}</p>
      )}
      {action && <div style={{ marginTop: '1rem' }}>{action}</div>}
    </Tile>
  );
}
