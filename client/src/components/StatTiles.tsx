import { Tile } from '@carbon/react';
import './stattiles.scss';

export interface StatTile {
  label: string;
  value: string | number;
  /** Optional secondary line under the value. */
  sub?: string;
}

/** Lowercases a tile's label and joins its words with hyphens, for a stable `data-testid`. */
function statTestId(label: string): string {
  return `stat-${label.toLowerCase().trim().replace(/\s+/g, '-')}`;
}

export function StatTiles({ tiles }: { tiles: StatTile[] }) {
  return (
    <div className="stat-tiles">
      {tiles.map(t => (
        <Tile key={t.label} className="stat-tiles__tile" data-testid={statTestId(t.label)}>
          <div className="sabia-readout-label">{t.label}</div>
          <div className="sabia-readout">{t.value}</div>
          {t.sub && <div className="sabia-readout-label">{t.sub}</div>}
        </Tile>
      ))}
    </div>
  );
}
