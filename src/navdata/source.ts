// ── Selected navdata source ──────────────────────────────────────────────────
//
// Which replica the browser reads is a Settings choice kept in flights.db's
// app_setting table, one row. The server never rewrites it on its own: a
// selection that cannot be honoured right now (the Little Navmap file is
// missing) falls back to the simulator replica at read time, and a later import
// makes the stored choice effective again without another click.

import { getSetting, setSetting } from '../db/settings';
import { effectiveNavdataSource, getSelectedNavdataSource } from './connection';
import type { NavdataSource } from './dataset';

export const NAVDATA_SOURCE_SETTING = 'navdata_source';

/** The stored choice; an absent row and any value other than 'lnm' read as 'mcdu' (an unrecognised value also warns). */
export function readNavdataSourceSetting(): NavdataSource {
  const value = getSetting(NAVDATA_SOURCE_SETTING);
  if (value === 'lnm' || value === 'mcdu') return value;
  if (value !== null) {
    console.warn(`[Navdata] Ignoring unrecognised ${NAVDATA_SOURCE_SETTING} setting; showing simulator data`);
  }
  return 'mcdu';
}

export function writeNavdataSourceSetting(source: NavdataSource): void {
  setSetting(NAVDATA_SOURCE_SETTING, source);
}

export interface NavdataSourceState {
  selected: NavdataSource;
  effective: NavdataSource;
  /** Set iff the selection is 'lnm' and the simulator replica is what answers. */
  fallback: null | 'lnm-unavailable';
}

/** The selected and effective source and why they differ, read once so callers cannot disagree. */
export function navdataSourceState(): NavdataSourceState {
  const selected = getSelectedNavdataSource();
  const effective = effectiveNavdataSource();
  return { selected, effective, fallback: selected === 'lnm' && effective === 'mcdu' ? 'lnm-unavailable' : null };
}
