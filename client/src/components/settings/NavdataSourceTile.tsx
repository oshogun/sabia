import { useEffect, useRef, useState } from 'react';
import { InlineNotification, RadioButton, RadioButtonGroup, SkeletonText, Stack, Tile } from '@carbon/react';
import { UnauthorizedError } from '../../utils/api';
import { fetchNavdataSource, saveNavdataSource, validityText } from '../../utils/navdataApi';
import type { NavdataDataset, NavdataSource, NavdataSourceResponse } from '../../types';

// Carbon's radio helper sits under the label text, which is indented past the radio circle.
const HELPER_INDENT = { marginInlineStart: '1.875rem' };

export interface NavdataSourceTileProps {
  /** Reload the choice and both datasets whenever this changes (an import finished elsewhere on the page). */
  navdataRefreshKey?: number;
  /** Called with every answer the tile shows: after a load, and after a successful switch. */
  onLoaded?: (response: NavdataSourceResponse) => void;
}

function expiredSubtitle(d: NavdataDataset): string {
  const what = d.airacCycle !== null ? `AIRAC ${d.airacCycle}` : d.label;
  return d.validThrough !== null ? `${what} was valid until ${d.validThrough}.` : `${what} is past its validity.`;
}

/** Which navigation data the map reads: the simulator's replica or an imported Little Navmap database. */
export function NavdataSourceTile({ navdataRefreshKey = 0, onLoaded }: NavdataSourceTileProps) {
  const [data, setData] = useState<NavdataSourceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  // Carbon's group keeps its own selection and only follows `valueSelected` when it changes, so a
  // failed save would leave the radio on the rejected value. Bumping the key remounts it on the
  // value the server still has.
  const [groupKey, setGroupKey] = useState(0);
  // Read when an answer arrives, so a parent passing a new function each render does not reload the tile.
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  useEffect(() => {
    let cancelled = false;
    setLoadError('');
    // The previous answer is hidden while a reload (after an import) is pending.
    setLoading(true);
    fetchNavdataSource()
      .then(r => {
        if (cancelled) return;
        setData(r);
        onLoadedRef.current?.(r);
      })
      .catch(err => {
        if (cancelled || err instanceof UnauthorizedError) return;
        setLoadError((err as Error).message);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [navdataRefreshKey]);

  async function choose(source: NavdataSource) {
    if (!data || source === data.selected) return;
    setSaving(true); setSaveError('');
    try {
      const r = await saveNavdataSource(source);
      setData(r);
      onLoadedRef.current?.(r);
      if (r.selected !== source) setGroupKey(k => k + 1);
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setSaveError((err as Error).message);
      setGroupKey(k => k + 1);
    } finally {
      setSaving(false);
    }
  }

  const lnmDataset = data?.lnm.dataset ?? null;

  return (
    <Tile>
      <Stack gap={5}>
        <h2 className="sabia-heading-03">Navigation data</h2>
        <p className="sabia-helper">
          Choose where the map&apos;s airports, navaids, airways and procedures come from. Only one source is shown at a time.
        </p>
        {loading && <SkeletonText />}
        {loadError && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not load navigation data" subtitle={loadError} />}
        {data && !loading && (
          <>
            <RadioButtonGroup
              key={groupKey}
              name="navdata-source"
              legendText="Source"
              orientation="vertical"
              valueSelected={data.selected}
              disabled={saving}
              onChange={value => { void choose(value as NavdataSource); }}
            >
              <RadioButton
                id="navdata-source-mcdu"
                value="mcdu"
                labelText="Simulator (MCDU)"
                aria-describedby="navdata-source-mcdu-helper"
              />
              <p id="navdata-source-mcdu-helper" className="sabia-helper" style={HELPER_INDENT}>
                {data.mcdu.present ? (data.mcdu.dataset?.label ?? '') : 'Nothing received from the simulator yet'}
              </p>
              <RadioButton
                id="navdata-source-lnm"
                value="lnm"
                labelText="Little Navmap import"
                disabled={!data.lnm.present}
                aria-describedby="navdata-source-lnm-helper"
              />
              <p id="navdata-source-lnm-helper" className="sabia-helper" style={HELPER_INDENT}>
                {data.lnm.present
                  ? (lnmDataset ? `${lnmDataset.label}${validityText(lnmDataset)}` : '')
                  : 'Import a Little Navmap database below first'}
              </p>
            </RadioButtonGroup>
            {saveError && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not switch" subtitle={saveError} />}
            {lnmDataset?.expired === true && (
              <InlineNotification
                kind="warning"
                lowContrast
                hideCloseButton
                title="Expired — not for navigation"
                subtitle={expiredSubtitle(lnmDataset)}
              />
            )}
            {data.fallback === 'lnm-unavailable' && (
              <InlineNotification
                kind="warning"
                lowContrast
                hideCloseButton
                subtitle="Little Navmap data is selected but unavailable, so the map is showing simulator data."
              />
            )}
            {data.effective === 'lnm' && (
              <p className="sabia-helper">
                The simulator keeps syncing in the background, but its data is not shown while Little Navmap is selected.
              </p>
            )}
          </>
        )}
      </Stack>
    </Tile>
  );
}
