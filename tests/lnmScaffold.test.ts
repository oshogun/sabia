// The Little Navmap importer's shared parts: flavour detection, unit helpers,
// the source index, the coverage grid, the dataset metadata and the synthetic
// atools database builder every converter test starts from. Everything runs on
// invented rows; no real navigation database is opened.

import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { LNM_DATASET_DDL, readNavdataDataset } from '../src/navdata/dataset';
import { applyNavdataSchema } from '../src/navdata/schema';
import { cellId } from '../src/navdata/keys';
import { COVERAGE_CELLS_PER_KIND, coverageCellId, writeCoverageGrid } from '../src/navdata/lnm/coverage';
import { ATOOLS_COLUMNS, detectFlavour } from '../src/navdata/lnm/flavour';
import {
  datasetLabel, parseAiracCycle, parseNavigraphUpdate, parseValidity, writeLnmMeta,
} from '../src/navdata/lnm/meta';
import { buildSourceIndex } from '../src/navdata/lnm/sourceIndex';
import { LNM_STAGE_WEIGHTS, LnmImportError, type AtoolsMetadata, type LnmImportErrorCode } from '../src/navdata/lnm/types';
import {
  comFrequencyHz, ftToM, ilsFrequencyHz, magvarToReplica, ndbFrequencyHz, nmToM, norm360, stripTrueSuffix,
  verticalAngleToReplica, vorFrequencyHz,
} from '../src/navdata/lnm/units';
import {
  ATOOLS_SUBSET_DDL, buildLnmFixture, makeLnmFixtureDir, msfs, navigraph, type AtoolsRow, type LnmFixtureSpec,
} from './helpers/lnmFixture';

// ── Shared scaffolding ───────────────────────────────────────────────────────

let dir: string;
const open: Database.Database[] = [];

beforeAll(() => {
  dir = makeLnmFixtureDir();
});
afterEach(() => {
  while (open.length) open.pop()!.close();
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Builds a fixture and opens it the way the importer does. */
function openFixture(spec: LnmFixtureSpec): Database.Database {
  const db = new Database(buildLnmFixture(dir, spec), { readonly: true, fileMustExist: true });
  open.push(db);
  return db;
}

const shared: Partial<Record<'navigraph' | 'msfs', string>> = {};

/** An unmodified preset: built once, opened read-only per test. */
function openPreset(name: 'navigraph' | 'msfs'): Database.Database {
  shared[name] ??= buildLnmFixture(dir, (name === 'navigraph' ? navigraph : msfs)({ fileName: `shared-${name}.sqlite` }));
  const db = new Database(shared[name], { readonly: true, fileMustExist: true });
  open.push(db);
  return db;
}

/** Builds a fixture, then edits it before it is opened read-only. */
function openEdited(spec: LnmFixtureSpec, edit: (db: Database.Database) => void): Database.Database {
  const file = buildLnmFixture(dir, spec);
  const rw = new Database(file);
  rw.pragma('foreign_keys = OFF');
  edit(rw);
  rw.close();
  const db = new Database(file, { readonly: true, fileMustExist: true });
  open.push(db);
  return db;
}

function refusal(fn: () => unknown): LnmImportError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(LnmImportError);
    return err as LnmImportError;
  }
  throw new Error('expected a refusal, none was thrown');
}

function expectRefusal(fn: () => unknown, code: LnmImportErrorCode, message: string): void {
  const err = refusal(fn);
  expect(err.code).toBe(code);
  expect(err.message).toBe(message);
}

const rows = (db: Database.Database, sql: string, ...args: unknown[]): any[] => db.prepare(sql).all(...args);
const one = (db: Database.Database, sql: string, ...args: unknown[]): any => db.prepare(sql).pluck().get(...args);

// ── Types ────────────────────────────────────────────────────────────────────

describe('LnmImportError and stage weights', () => {
  it('carries its code and a name of its own', () => {
    const err = new LnmImportError('LNM_EMPTY', 'no airports');
    expect(err).toBeInstanceOf(Error);
    expect([err.name, err.code, err.message]).toEqual(['LnmImportError', 'LNM_EMPTY', 'no airports']);
  });

  it('weights the stages to 100', () => {
    expect(Object.values(LNM_STAGE_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });
});

// ── Flavour detection ────────────────────────────────────────────────────────

describe('detectFlavour', () => {
  it('detects NAVIGRAPH from the Navigraph preset', () => {
    const found = detectFlavour(openPreset('navigraph'));
    expect([found.flavour, found.provider]).toEqual(['NAVIGRAPH', 'NAVIGRAPH']);
    expect(found.metadata.airac_cycle).toBe('2610');
  });

  it('detects MSFS from the MSFS preset', () => {
    const found = detectFlavour(openPreset('msfs'));
    expect([found.flavour, found.provider]).toEqual(['MSFS', 'MSFS']);
    expect(found.metadata.properties).toBe('NavigraphUpdate=true\n');
  });

  it('converts MSFS24 with the MSFS rules but keeps it as the provider, whatever the case or padding', () => {
    const found = detectFlavour(openFixture(msfs({ metadata: { data_source: ' msfs24 ' } })));
    expect([found.flavour, found.provider]).toEqual(['MSFS', 'MSFS24']);
  });

  it('refuses an unknown data source, echoing it cut to 16 safe characters', () => {
    expectRefusal(
      () => detectFlavour(openFixture(msfs({ metadata: { data_source: 'XP12' } }))),
      'LNM_UNSUPPORTED_SOURCE',
      "unsupported Little Navmap data source 'XP12'; only NAVIGRAPH, MSFS and MSFS24 are supported",
    );
    expectRefusal(
      () => detectFlavour(openFixture(msfs({ metadata: { data_source: "x'<b>y\n/etc/passwd-and-more-text" } }))),
      'LNM_UNSUPPORTED_SOURCE',
      "unsupported Little Navmap data source 'xbyetcpasswd-and'; only NAVIGRAPH, MSFS and MSFS24 are supported",
    );
  });

  it('refuses a missing data source', () => {
    expectRefusal(
      () => detectFlavour(openFixture(msfs({ metadata: { data_source: null } }))),
      'LNM_UNSUPPORTED_SOURCE',
      "unsupported Little Navmap data source ''; only NAVIGRAPH, MSFS and MSFS24 are supported",
    );
  });

  it('refuses a file lacking a table, naming it', () => {
    expectRefusal(
      () => detectFlavour(openEdited(msfs(), db => db.exec('DROP TABLE approach_leg'))),
      'LNM_NOT_ATOOLS',
      'not a Little Navmap database: missing table approach_leg',
    );
  });

  it('refuses a file lacking a column, naming it', () => {
    expectRefusal(
      () => detectFlavour(openEdited(navigraph(), db => db.exec('ALTER TABLE approach_leg DROP COLUMN vertical_angle'))),
      'LNM_NOT_ATOOLS',
      'not a Little Navmap database: missing column approach_leg.vertical_angle',
    );
  });

  it('refuses a database that is not an atools file at all', () => {
    const file = path.join(dir, 'other.sqlite');
    const other = new Database(file);
    other.exec('CREATE TABLE notes (id INTEGER)');
    other.close();
    const db = new Database(file, { readonly: true, fileMustExist: true });
    open.push(db);
    expect(refusal(() => detectFlavour(db)).code).toBe('LNM_NOT_ATOOLS');
  });

  it('refuses a metadata table that does not hold exactly one row', () => {
    expectRefusal(
      () => detectFlavour(openEdited(msfs(), db => db.exec('DELETE FROM metadata'))),
      'LNM_NOT_ATOOLS',
      'not a Little Navmap database: metadata has no row',
    );
    expectRefusal(
      () => detectFlavour(openFixture(msfs({ extra: { metadata: [{ data_source: 'MSFS' }] } }))),
      'LNM_NOT_ATOOLS',
      'not a Little Navmap database: metadata has more than one row',
    );
  });

  it('refuses a file with no airports', () => {
    expectRefusal(
      () => detectFlavour(openEdited(msfs(), db => db.exec('DELETE FROM airport'))),
      'LNM_EMPTY',
      'the Little Navmap database has no airports',
    );
  });

  it('reports a missing table before an unsupported source, that before an empty file, and that before a mismatch', () => {
    expect(refusal(() => detectFlavour(openEdited(
      msfs({ metadata: { data_source: 'XP12' } }), db => db.exec('DROP TABLE approach_leg'),
    ))).code).toBe('LNM_NOT_ATOOLS');
    const mismatched = { com: [{ airport_id: 1, frequency: 118_000_000 }] };
    expect(refusal(() => detectFlavour(openEdited(
      navigraph({ metadata: { data_source: 'XP12' }, extra: mismatched }), db => db.exec('DELETE FROM airport'),
    ))).code).toBe('LNM_UNSUPPORTED_SOURCE');
    expect(refusal(() => detectFlavour(openEdited(
      navigraph({ extra: mismatched }), db => db.exec('DELETE FROM airport'),
    ))).code).toBe('LNM_EMPTY');
  });

  describe('magnitude assertions abort on a mismatch', () => {
    const mismatch = (provider: string, what: string): string =>
      `data source ${provider} does not match the file: ${what}`;

    it('com.frequency in Hz in a file that says NAVIGRAPH', () => {
      expectRefusal(
        () => detectFlavour(openFixture(navigraph({ extra: { com: [{ airport_id: 1, frequency: 118_000_000 }] } }))),
        'LNM_FLAVOUR_MISMATCH',
        mismatch('NAVIGRAPH', 'com.frequency is not in kHz'),
      );
    });

    it('com.frequency in kHz in a file that says MSFS', () => {
      expectRefusal(
        () => detectFlavour(openFixture(msfs({ extra: { com: [{ airport_id: 1, frequency: 118_300 }] } }))),
        'LNM_FLAVOUR_MISMATCH',
        mismatch('MSFS', 'com.frequency is not in Hz'),
      );
    });

    it('the whole Navigraph file under an MSFS label, and the reverse', () => {
      const asMsfs = navigraph({ metadata: { data_source: 'MSFS' } });
      expect(refusal(() => detectFlavour(openFixture(asMsfs))).code).toBe('LNM_FLAVOUR_MISMATCH');
      const asNavigraph = msfs({ metadata: { data_source: 'NAVIGRAPH' } });
      expect(refusal(() => detectFlavour(openFixture(asNavigraph))).code).toBe('LNM_FLAVOUR_MISMATCH');
    });

    it('vor.frequency outside the VHF band, either side', () => {
      for (const frequency of [11_230, 112_300_000]) {
        expectRefusal(
          () => detectFlavour(openFixture(navigraph({ extra: { vor: [{ ident: 'ZZX', frequency, lonx: -160, laty: 10 }] } }))),
          'LNM_FLAVOUR_MISMATCH',
          mismatch('NAVIGRAPH', 'vor.frequency is not in kHz'),
        );
      }
    });

    it('ndb.frequency outside kHz x 100', () => {
      for (const frequency of [375, 375_000]) {
        expectRefusal(
          () => detectFlavour(openFixture(msfs({ extra: { ndb: [{ ident: 'ZZX', frequency, lonx: -160, laty: 10 }] } }))),
          'LNM_FLAVOUR_MISMATCH',
          mismatch('MSFS', 'ndb.frequency is not in kHz x 100'),
        );
      }
    });

    it('leg coordinates missing from a Navigraph file or present in an MSFS one', () => {
      expectRefusal(
        () => detectFlavour(openEdited(navigraph(), db => db.exec('UPDATE approach_leg SET fix_laty = NULL'))),
        'LNM_FLAVOUR_MISMATCH',
        mismatch('NAVIGRAPH', 'approach_leg has no fix coordinates'),
      );
      expectRefusal(
        () => detectFlavour(openFixture(msfs({ extra: { approach_leg: [{ approach_id: 5, type: 'TF', fix_laty: 12, fix_lonx: -160 }] } }))),
        'LNM_FLAVOUR_MISMATCH',
        mismatch('MSFS', 'approach_leg has fix coordinates'),
      );
    });

    it('skips a check whose table is empty, and ignores NULL values', () => {
      for (const spec of [navigraph, msfs]) {
        const db = openEdited(spec(), edit => {
          edit.exec('DELETE FROM approach_leg; DELETE FROM com; DELETE FROM vor; DELETE FROM ndb');
        });
        expect(() => detectFlavour(db)).not.toThrow();
      }
      const withNulls = openFixture(navigraph({ extra: { vor: [{ ident: 'ZZX', frequency: null, lonx: -160, laty: 10 }] } }));
      expect(() => detectFlavour(withNulls)).not.toThrow();
    });
  });
});

describe('the atools column list', () => {
  it('is exactly the schema the fixture builder creates', () => {
    const db = new Database(':memory:');
    db.exec(ATOOLS_SUBSET_DDL);
    const found: Record<string, string[]> = {};
    for (const t of rows(db, "SELECT name FROM sqlite_master WHERE type = 'table'")) {
      found[t.name] = rows(db, `PRAGMA table_info(${t.name})`).map(c => c.name);
    }
    db.close();
    expect(found).toEqual(ATOOLS_COLUMNS);
  });
});

// ── Units ────────────────────────────────────────────────────────────────────

describe('unit helpers', () => {
  it('converts feet and nautical miles, and passes null through', () => {
    expect(ftToM(1000)).toBeCloseTo(304.8, 10);
    expect(nmToM(2)).toBe(3704);
    expect(ftToM(null)).toBeNull();
    expect(nmToM(undefined)).toBeNull();
  });

  describe('comFrequencyHz', () => {
    it('keeps MSFS hertz as they are', () => {
      expect(comFrequencyHz(118_325_000, 'MSFS')).toBe(118_325_000);
      expect(comFrequencyHz(257_825_000, 'MSFS')).toBe(257_825_000);
    });

    it('restores the truncated 25 kHz channels of Navigraph by adding 5 kHz', () => {
      expect(comFrequencyHz(118_320, 'NAVIGRAPH')).toBe(118_325_000);
      expect(comFrequencyHz(119_370, 'NAVIGRAPH')).toBe(119_375_000);
      expect(comFrequencyHz(257_820, 'NAVIGRAPH')).toBe(257_825_000);
    });

    it('leaves other VHF channels and the HF and LF values as plain kHz', () => {
      expect(comFrequencyHz(121_700, 'NAVIGRAPH')).toBe(121_700_000);
      expect(comFrequencyHz(118_300, 'NAVIGRAPH')).toBe(118_300_000);
      expect(comFrequencyHz(5_670, 'NAVIGRAPH')).toBe(5_670_000);
      expect(comFrequencyHz(335, 'NAVIGRAPH')).toBe(335_000);
      expect(comFrequencyHz(395, 'NAVIGRAPH')).toBe(395_000);
      expect(comFrequencyHz(117_970, 'NAVIGRAPH')).toBe(117_970_000);
    });
  });

  it('converts navaid frequencies to hertz', () => {
    expect(vorFrequencyHz(112_300)).toBe(112_300_000);
    expect(ilsFrequencyHz(110_500)).toBe(110_500_000);
    expect(ndbFrequencyHz(37_500)).toBe(375_000);
    expect([vorFrequencyHz(null), ilsFrequencyHz(null), ndbFrequencyHz(null)]).toEqual([null, null, null]);
  });

  it('turns an east variation into the west-positive replica convention in [0, 360)', () => {
    expect(magvarToReplica(13.5)).toBe(346.5);
    expect(magvarToReplica(-13.5)).toBe(13.5);
    expect(magvarToReplica(0)).toBe(0);
    expect(Object.is(magvarToReplica(0), 0)).toBe(true);
    expect(magvarToReplica(360)).toBe(0);
    expect(magvarToReplica(-1e-20)).toBe(0);
    expect(magvarToReplica(null)).toBeNull();
  });

  it('encodes a vertical angle as 360 minus the path angle, per flavour', () => {
    expect(verticalAngleToReplica(-3.57, 'MSFS')).toBe(357);
    expect(verticalAngleToReplica(-3.42, 'MSFS')).toBe(342);
    expect(verticalAngleToReplica(-3.0, 'NAVIGRAPH')).toBe(357);
    expect(verticalAngleToReplica(-3.25, 'NAVIGRAPH')).toBe(356.75);
    for (const flavour of ['MSFS', 'NAVIGRAPH'] as const) {
      expect(verticalAngleToReplica(null, flavour)).toBeNull();
      expect(verticalAngleToReplica(0, flavour)).toBeNull();
    }
    expect(verticalAngleToReplica(3.0, 'NAVIGRAPH')).toBeNull();
    expect(verticalAngleToReplica(3.0, 'MSFS')).toBeNull();
  });

  it('normalises degrees and strips the true-bearing suffix of a two-digit runway only', () => {
    expect([norm360(-10), norm360(370), norm360(360), norm360(0)]).toEqual([350, 10, 0, 0]);
    expect([stripTrueSuffix('08T'), stripTrueSuffix('27R'), stripTrueSuffix('NT'), stripTrueSuffix('8T'), stripTrueSuffix('T')])
      .toEqual(['08', '27R', 'NT', '8T', 'T']);
  });
});

// ── Source index ─────────────────────────────────────────────────────────────

describe('buildSourceIndex', () => {
  it('names the provider it was built for', () => {
    expect(buildSourceIndex(openFixture(msfs({ metadata: { data_source: 'MSFS24' } })), 'MSFS').provider).toBe('MSFS24');
    expect(buildSourceIndex(openPreset('navigraph'), 'NAVIGRAPH').provider).toBe('NAVIGRAPH');
  });

  describe('airport owner', () => {
    it('is the row with the most runways, frequencies and approaches', () => {
      const index = buildSourceIndex(openPreset('navigraph'), 'NAVIGRAPH');
      expect(index.airportOwnerId('ZZAC')).toBe(4);
      expect(index.airportByIdent('ZZAC')).toMatchObject({ id: 4, region: 'ZY', isOwner: true });
      expect(index.airportById(3)).toMatchObject({ ident: 'ZZAC', region: 'ZZ', isOwner: false });
      expect(index.airportOwnerId('ZZAA')).toBe(1);
      expect(index.airportOwnerId('ZZZZ')).toBeUndefined();
    });

    it('goes to the lowest airport_id on a tie', () => {
      const dup = (id: number): AtoolsRow => ({ airport_id: id, ident: 'ZZAD', lonx: -160, laty: 10, num_runways: 1 });
      const index = buildSourceIndex(openFixture(msfs({ extra: { airport: [dup(1001), dup(1000), dup(1002)] } })), 'MSFS');
      expect(index.airportOwnerId('ZZAD')).toBe(1000);
    });

    it('keeps the east-positive variation and an empty region for a NULL one', () => {
      const index = buildSourceIndex(openPreset('msfs'), 'MSFS');
      expect(index.airportByIdent('ZZAA')).toMatchObject({ region: '', magvarEast: 12.5, lat: 12, lon: -165 });
    });
  });

  describe('runway ends', () => {
    it('are found by airport ident and end name, with or without the true-bearing suffix', () => {
      const index = buildSourceIndex(openPreset('navigraph'), 'NAVIGRAPH');
      expect(index.runwayEnd('ZZAA', '18')?.id).toBe(13);
      expect(index.runwayEnd('ZZAA', '18T')?.id).toBe(13);
      expect(index.runwayEnd('ZZAA', '27R')).toMatchObject({ id: 12, name: '27R', headingTrue: 270, offsetThresholdFt: 300 });
      expect(index.runwayEnd('ZZAA', '27L')).toBeUndefined();
    });

    it('belong to the owner airport only', () => {
      const index = buildSourceIndex(openFixture(navigraph({ extra: {
        runway_end: [{ runway_end_id: 1000, name: '15', lonx: -163.5, laty: 14 }, { runway_end_id: 1001, name: '33', lonx: -163.4, laty: 14 }],
        runway: [{ runway_id: 1000, airport_id: 3, primary_end_id: 1000, secondary_end_id: 1001, lonx: -163.5, laty: 14 }],
      } })), 'NAVIGRAPH');
      expect(index.runwayEnd('ZZAC', '15')).toBeUndefined();
      expect(index.runwayEnd('ZZAC', '10')?.id).toBe(17);
    });

    it('come from the highest runway_id when a name repeats at one airport', () => {
      const index = buildSourceIndex(openFixture(msfs({ extra: {
        runway_end: [{ runway_end_id: 1000, name: '09L', lonx: -165.1, laty: 12 }, { runway_end_id: 1001, name: '27R', lonx: -164.9, laty: 12 }],
        runway: [{ runway_id: 1000, airport_id: 1, primary_end_id: 1000, secondary_end_id: 1001, lonx: -165, laty: 12 }],
      } })), 'MSFS');
      expect(index.runwayEnd('ZZAA', '09L')?.id).toBe(1000);
      expect(index.runwayEnd('ZZAA', '27R')?.id).toBe(1001);
    });
  });

  describe('navaid winners', () => {
    const index = (spec: LnmFixtureSpec) => buildSourceIndex(openFixture(spec), spec.rows.metadata[0].data_source === 'MSFS' ? 'MSFS' : 'NAVIGRAPH');

    it('give a VOR the key before an ILS sharing it, flagged ambiguous', () => {
      for (const spec of [navigraph(), msfs()]) {
        expect(index(spec).navaidWinner('V', 'ZZV', 'ZZ')).toEqual({ table: 'vor', id: 1, ambiguous: true });
      }
    });

    it('give an ILS the key when no VOR has it, and the lowest ils_id among ILS', () => {
      const lone = buildSourceIndex(openPreset('navigraph'), 'NAVIGRAPH');
      expect(lone.navaidWinner('V', 'IZZA', 'ZZ')).toEqual({ table: 'ils', id: 1, ambiguous: false });
      const twins = index(msfs({ extra: { ils: [{ ils_id: 1000, ident: 'IZZA', loc_airport_ident: 'ZZAA', lonx: -160, laty: 10 }] } }));
      expect(twins.navaidWinner('V', 'IZZA', 'ZZ')).toEqual({ table: 'ils', id: 1, ambiguous: true });
    });

    it('prefer an airway-endpoint NDB, then one with no airport, then the lowest id', () => {
      const ndb = (id: number, ident: string, airportId: number | null): AtoolsRow =>
        ({ ndb_id: id, ident, region: 'ZZ', airport_id: airportId, frequency: 37500, lonx: -160, laty: 10 });
      const idx = index(navigraph({ extra: { ndb: [
        ndb(1000, 'ZZM', 1), ndb(1001, 'ZZM', null),
        ndb(1002, 'ZZL', null), ndb(1003, 'ZZL', null),
        ndb(1004, 'ZZK', 1),
      ] } }));
      // ZZN row 2 sits at ZZAA but is the endpoint of airway ZZ2, row 1 is free and has the lower id.
      expect(idx.navaidWinner('N', 'ZZN', 'ZZ')).toEqual({ table: 'ndb', id: 2, ambiguous: true });
      expect(idx.navaidWinner('N', 'ZZM', 'ZZ')).toEqual({ table: 'ndb', id: 1001, ambiguous: true });
      expect(idx.navaidWinner('N', 'ZZL', 'ZZ')).toEqual({ table: 'ndb', id: 1002, ambiguous: true });
      expect(idx.navaidWinner('N', 'ZZK', 'ZZ')).toEqual({ table: 'ndb', id: 1004, ambiguous: false });
    });

    it('answer the same on every build', () => {
      const a = buildSourceIndex(openPreset('navigraph'), 'NAVIGRAPH').navaidWinner('N', 'ZZN', 'ZZ');
      const b = buildSourceIndex(openPreset('navigraph'), 'NAVIGRAPH').navaidWinner('N', 'ZZN', 'ZZ');
      expect(a).toEqual(b);
    });

    it('return nothing for a key nobody holds, or in another region', () => {
      const idx = buildSourceIndex(openPreset('navigraph'), 'NAVIGRAPH');
      expect(idx.navaidWinner('V', 'ZZQ', 'ZZ')).toBeUndefined();
      expect(idx.navaidWinner('N', 'ZZN', 'ZY')).toBeUndefined();
      expect(idx.navaidWinner('V', 'ZZV', 'ZY')).toBeUndefined();
    });

    it('list candidates by ident and region in id order', () => {
      const idx = buildSourceIndex(openPreset('navigraph'), 'NAVIGRAPH');
      expect(idx.ndbs('ZZN', 'ZZ').map(n => n.id)).toEqual([1, 2]);
      expect(idx.ndbs('ZZN', 'ZZ')[1]).toMatchObject({ airportId: 1, lat: 12.1, lon: -165.1 });
      expect(idx.vors('ZZV', 'ZZ').map(v => v.id)).toEqual([1]);
      expect(idx.vors('ZZV', '')).toEqual([]);
    });
  });

  describe('airway endpoint navaids', () => {
    it('are told apart by table although vor_id and ndb_id overlap', () => {
      const idx = buildSourceIndex(openPreset('navigraph'), 'NAVIGRAPH');
      // VOR 1 is the V copy at the start of airway ZZ3; NDB 2 the N copy at the end of ZZ2.
      expect([idx.isAirwayEndpointNavaid('vor', 1), idx.isAirwayEndpointNavaid('ndb', 1)]).toEqual([true, false]);
      expect([idx.isAirwayEndpointNavaid('vor', 2), idx.isAirwayEndpointNavaid('ndb', 2)]).toEqual([false, true]);
      expect(idx.isAirwayEndpointNavaid('vor', 3)).toBe(false);
    });
  });

  describe('ILS', () => {
    it('takes its region from the row, else from the airport ident, else has none', () => {
      const nav = buildSourceIndex(openPreset('navigraph'), 'NAVIGRAPH');
      expect(nav.ilsByIdent('IZZA')[0]).toMatchObject({ region: 'ZZ', derivedRegion: 'ZZ' });
      const sim = buildSourceIndex(openFixture(msfs({ extra: { ils: [
        { ils_id: 1000, ident: 'IZZB', lonx: -160, laty: 10 },
        { ils_id: 1001, ident: 'IZZB', loc_airport_ident: 'XZAB', region: '', lonx: -160, laty: 10 },
      ] } })), 'MSFS');
      expect(sim.ilsByIdent('IZZA')[0]).toMatchObject({ region: null, derivedRegion: 'ZZ', airportIdent: 'ZZAA', locRunwayEndId: 12 });
      expect(sim.ilsRegion(sim.ilsByIdent('IZZA')[0])).toBe('ZZ');
      expect(sim.ilsByIdent('IZZB').map(i => sim.ilsRegion(i))).toEqual([null, 'XZ']);
    });

    it('leaves GLS rows out of the index', () => {
      const idx = buildSourceIndex(openFixture(msfs({ extra: { ils: [
        { ils_id: 1000, ident: 'IZZG', type: 'G', loc_airport_ident: 'ZZAA', lonx: -160, laty: 10 },
      ] } })), 'MSFS');
      expect(idx.ilsByIdent('IZZG')).toEqual([]);
      expect(idx.navaidWinner('V', 'IZZG', 'ZZ')).toBeUndefined();
    });
  });

  describe('waypoints', () => {
    it('leave out the artificial V and N copies', () => {
      const idx = buildSourceIndex(openPreset('navigraph'), 'NAVIGRAPH');
      expect(idx.waypoints('ZZV', 'ZZ')).toEqual([]);
      expect(idx.waypointsByIdent('ZZN')).toEqual([]);
      expect(idx.waypoints('ZZW01', 'ZZ')).toHaveLength(1);
    });

    it('hold the VFR point that shares a VOR ident and region, and key a NULL region as empty', () => {
      const idx = buildSourceIndex(openPreset('msfs'), 'MSFS');
      expect(idx.waypoints('ZZV', 'ZZ')).toMatchObject([{ id: 14, lat: 15, lon: -160 }]);
      expect(idx.waypoints('ZZW10', '')).toHaveLength(1);
      expect(idx.waypointsByIdent('ZZW10')[0].region).toBe('');
    });

    it('name the owning airport through airport_id, null when unset or dangling', () => {
      const idx = buildSourceIndex(openFixture(navigraph({ extra: { waypoint: [
        { waypoint_id: 1000, ident: 'ZZW20', type: 'WN', region: 'ZZ', airport_id: 3, lonx: -160, laty: 10 },
        { waypoint_id: 1001, ident: 'ZZW21', type: 'WN', region: 'ZZ', airport_id: 777, lonx: -160, laty: 10 },
      ] } })), 'NAVIGRAPH');
      expect(idx.waypoints('ZZT01', 'ZZ')[0]).toMatchObject({ airportId: 1, airportIdent: 'ZZAA' });
      expect(idx.waypoints('ZZW01', 'ZZ')[0]).toMatchObject({ airportId: null, airportIdent: null });
      // A losing duplicate shares its owner's ident.
      expect(idx.waypoints('ZZW20', 'ZZ')[0].airportIdent).toBe('ZZAC');
      expect(idx.waypoints('ZZW21', 'ZZ')[0].airportIdent).toBeNull();
    });
  });
});

// ── Coverage grid ────────────────────────────────────────────────────────────

describe('coverageCellId', () => {
  it('numbers the cells row by row from the south-west corner', () => {
    expect(coverageCellId(-90, -180)).toBe(0);
    expect(coverageCellId(-89.5, -179.5)).toBe(721);
    expect(coverageCellId(0, 0)).toBe(180 * 720 + 360);
  });

  it('clamps latitude 90 and longitude 180 into the last row and column', () => {
    expect(coverageCellId(90, 180)).toBe(COVERAGE_CELLS_PER_KIND - 1);
    expect(coverageCellId(90, 0)).toBe(359 * 720 + 360);
    expect(coverageCellId(0, 180)).toBe(180 * 720 + 719);
    // The unclamped key leaves the grid or lands in the next row's first column.
    expect(cellId(90, 180)).toBeGreaterThanOrEqual(COVERAGE_CELLS_PER_KIND);
    expect(cellId(0, 180)).toBe(181 * 720);
  });

  it('never leaves 0..259199, and agrees with the plain key inside the grid', () => {
    const outside: number[][] = [];
    for (let lat = -90; lat <= 90; lat += 0.5) {
      for (let lon = -180; lon <= 180; lon += 0.5) {
        const id = coverageCellId(lat, lon);
        if (!(id >= 0 && id < COVERAGE_CELLS_PER_KIND) || (lat < 90 && lon < 180 && id !== cellId(lat, lon))) {
          outside.push([lat, lon]);
        }
      }
    }
    expect(outside).toEqual([]);
  });
});

describe('writeCoverageGrid', () => {
  let out: Database.Database;
  let written: number;
  const steps: number[] = [];
  const NOW = Date.UTC(2026, 9, 1, 12);

  // Writing the whole grid (777,600 rows into the real table with its indexes) is
  // CPU-bound: about 1.7 s alone and over 5 s while the full suite saturates the
  // machine, so this one hook gets 30 s; the global 5 s limit stays for the rest.
  beforeAll(() => {
    out = new Database(':memory:');
    out.pragma('foreign_keys = ON');
    applyNavdataSchema(out);
    const navaid = out.prepare('INSERT INTO nav_navaid (kind, ident, region, lat, lon, rev) VALUES (?, ?, ?, ?, ?, 1)');
    const waypoint = out.prepare('INSERT INTO nav_waypoint (wpt_key, ident, region, lat, lon, rev) VALUES (?, ?, ?, ?, ?, 1)');
    navaid.run('V', 'ZZV', 'ZZ', 12.5, -166);
    navaid.run('V', 'ZZT', 'ZZ', 12.6, -165.9);
    navaid.run('V', 'ZZP', 'ZZ', 90, 180);
    navaid.run('N', 'ZZN', 'ZZ', 13, -167);
    navaid.run('N', 'ZZS', 'ZZ', -90, -180);
    navaid.run('N', 'ZZU', 'ZZ', null, null);
    waypoint.run('a', 'ZZW04', 'ZZ', 11, 180);
    waypoint.run('b', 'ZZW05', 'ZZ', 90, 0);
    waypoint.run('c', 'ZZW06', 'ZZ', 12, 179.5);
    waypoint.run('d', 'ZZW07', 'ZZ', 12.5, -179.5);
    let last = 0;
    written = writeCoverageGrid(out, NOW, (done, total) => {
      expect(total).toBe(3 * COVERAGE_CELLS_PER_KIND);
      steps.push(done - last);
      last = done;
    });
  }, 30_000);
  afterAll(() => out.close());

  it('writes exactly 3 x 259,200 rows, none outside the CHECK, including latitude 90 and longitude 180', () => {
    expect(written).toBe(777_600);
    expect(one(out, 'SELECT COUNT(*) FROM nav_coverage_cell')).toBe(3 * 259_200);
    for (const kind of ['V', 'N', 'W']) {
      expect(rows(out, 'SELECT COUNT(*) n, MIN(cell_id) lo, MAX(cell_id) hi FROM nav_coverage_cell WHERE kind = ?', kind))
        .toEqual([{ n: 259_200, lo: 0, hi: 259_199 }]);
    }
  });

  it('counts the built rows per cell, zero where there are none', () => {
    const count = (kind: string, lat: number, lon: number): number =>
      one(out, 'SELECT row_count FROM nav_coverage_cell WHERE kind = ? AND cell_id = ?', kind, coverageCellId(lat, lon));
    expect(count('V', 12.5, -166)).toBe(2);
    expect(count('V', 90, 180)).toBe(1);
    expect(count('N', -90, -180)).toBe(1);
    expect(count('W', 11, 180)).toBe(1);
    expect(count('W', 90, 0)).toBe(1);
    expect(count('W', 0, 0)).toBe(0);
    expect(rows(out, 'SELECT kind, SUM(row_count) n FROM nav_coverage_cell GROUP BY kind ORDER BY kind'))
      .toEqual([{ kind: 'N', n: 2 }, { kind: 'V', n: 3 }, { kind: 'W', n: 4 }]);
  });

  it('marks every cell harvested at the import time, once, at revision 1', () => {
    expect(rows(out, 'SELECT DISTINCT harvested_at, harvest_count, rev FROM nav_coverage_cell'))
      .toEqual([{ harvested_at: NOW, harvest_count: 1, rev: 1 }]);
  });

  it('reports progress after each transaction of at most 50,000 rows', () => {
    expect(Math.max(...steps)).toBeLessThanOrEqual(50_000);
    expect(steps.reduce((a, b) => a + b, 0)).toBe(777_600);
    expect(steps).toHaveLength(18);
  });
});

// ── Dataset metadata ─────────────────────────────────────────────────────────

describe('parseNavigraphUpdate', () => {
  it('reads the NavigraphUpdate line of the properties text', () => {
    expect(parseNavigraphUpdate('NavigraphUpdate=true\n')).toBe(true);
    expect(parseNavigraphUpdate('Other=1\r\n NavigraphUpdate=false \r\n')).toBe(false);
  });

  it('is null when stated nowhere or not as true or false', () => {
    expect(parseNavigraphUpdate(null)).toBeNull();
    expect(parseNavigraphUpdate('')).toBeNull();
    expect(parseNavigraphUpdate('Other=1\n')).toBeNull();
    expect(parseNavigraphUpdate('NavigraphUpdate=maybe\n')).toBeNull();
  });
});

describe('parseAiracCycle', () => {
  it('keeps exactly four digits, trimmed', () => {
    expect(parseAiracCycle(' 1801 ')).toBe('1801');
    for (const bad of ['18', '18011', '18a1', '', null, undefined]) expect(parseAiracCycle(bad)).toBeNull();
  });
});

describe('parseValidity', () => {
  it('reads the range the file carries', () => {
    expect(parseValidity('0401310118', null)).toEqual({ validFrom: '2018-01-04', validThrough: '2018-01-31' });
    expect(parseValidity('0110281026', '2610')).toEqual({ validFrom: '2026-10-01', validThrough: '2026-10-28' });
  });

  it('starts a December-January cycle in the year before it ends', () => {
    expect(parseValidity('2012160119', null)).toEqual({ validFrom: '2018-12-20', validThrough: '2019-01-16' });
  });

  it('falls back to the AIRAC calendar for the cycle', () => {
    expect(parseValidity(null, '1801')).toEqual({ validFrom: '2018-01-04', validThrough: '2018-01-31' });
    expect(parseValidity('', '2601')).toEqual({ validFrom: '2026-01-22', validThrough: '2026-02-18' });
    expect(parseValidity(null, '2610')).toEqual({ validFrom: '2026-10-01', validThrough: '2026-10-28' });
    expect(parseValidity(null, '2613')).toEqual({ validFrom: '2026-12-24', validThrough: '2027-01-20' });
  });

  it('rejects a range with a day that does not exist, or that ends before it starts, and uses the cycle', () => {
    expect(parseValidity('3102280118', '1801')).toEqual({ validFrom: '2018-01-04', validThrough: '2018-01-31' });
    expect(parseValidity('2801010118', '1801')).toEqual({ validFrom: '2018-01-04', validThrough: '2018-01-31' });
    expect(parseValidity('0113011018', null)).toEqual({ validFrom: null, validThrough: null });
  });

  it('has neither date when nothing usable is given, or the cycle lies outside its year', () => {
    expect(parseValidity(null, null)).toEqual({ validFrom: null, validThrough: null });
    expect(parseValidity('garbage', 'xx')).toEqual({ validFrom: null, validThrough: null });
    expect(parseValidity(null, '2600')).toEqual({ validFrom: null, validThrough: null });
    expect(parseValidity(null, '2614')).toEqual({ validFrom: null, validThrough: null });
  });
});

describe('datasetLabel', () => {
  const base = { airacCycle: null, navigraphUpdate: null, compiledAt: null };

  it('names the cycle when there is one', () => {
    expect(datasetLabel({ ...base, provider: 'NAVIGRAPH', airacCycle: '1801' })).toBe('Navigraph AIRAC 1801');
    expect(datasetLabel({ ...base, provider: 'MSFS', airacCycle: '2610', navigraphUpdate: true })).toBe('MSFS 2020 AIRAC 2610');
  });

  it('describes a scenery build otherwise', () => {
    expect(datasetLabel({ ...base, provider: 'MSFS', navigraphUpdate: true, compiledAt: '2026-09-27T10:15:00' }))
      .toBe('MSFS 2020 scenery with Navigraph update, compiled 2026-09-27');
    expect(datasetLabel({ ...base, provider: 'MSFS24', navigraphUpdate: false, compiledAt: '2026-09-27' }))
      .toBe('MSFS 2024 scenery, compiled 2026-09-27');
    expect(datasetLabel({ ...base, provider: 'MSFS', compiledAt: 'yesterday' })).toBe('MSFS 2020 scenery');
    expect(datasetLabel({ ...base, provider: 'NAVIGRAPH' })).toBe('Navigraph scenery');
  });
});

describe('writeLnmMeta', () => {
  const START = Date.UTC(2026, 9, 1, 8, 0, 0);
  const END = START + 90_000;

  function freshReplica(airports = 1): Database.Database {
    const out = new Database(':memory:');
    applyNavdataSchema(out);
    out.exec(LNM_DATASET_DDL);
    for (let i = 0; i < airports; i++) {
      out.prepare('INSERT INTO nav_airport (ident, region, rev) VALUES (?, ?, 1)').run(`ZZA${i}`, 'ZZ');
    }
    return out;
  }

  function metadataOf(spec: LnmFixtureSpec): { provider: ReturnType<typeof detectFlavour>['provider']; metadata: AtoolsMetadata } {
    const { provider, metadata } = detectFlavour(openFixture(spec));
    return { provider, metadata };
  }

  it('writes a header the status reader describes, for a Navigraph cycle', () => {
    const out = freshReplica(3);
    const { snapshotId, dataset } = writeLnmMeta(out, {
      ...metadataOf(navigraph()), sourceFileName: 'lnm-navigraph.sqlite', sourceBytes: 4096, startedAt: START, completedAt: END,
    });
    expect(snapshotId).toMatch(new RegExp(`^lnm-navigraph-${START}-[0-9a-f]{8}$`));
    expect(dataset).toEqual({
      source: 'lnm', label: 'Navigraph AIRAC 2610', provider: 'NAVIGRAPH', airacCycle: '2610',
      validFrom: '2026-10-01', validThrough: '2026-10-28', expired: false, compiledAt: '2026-09-30T20:15:00',
      navigraphUpdate: null, importedAt: END,
    });
    expect(readNavdataDataset(out, 'lnm', END)).toEqual(dataset);
    expect(readNavdataDataset(out, 'lnm', Date.UTC(2026, 9, 29))?.expired).toBe(true);

    expect(rows(out, 'SELECT * FROM nav_meta')).toEqual([{
      id: 1, schema_version: 2, snapshot_id: snapshotId, rev: 1, sim_id: '2024', sim_app_name: 'Little Navmap',
      sim_app_version: 'Navigraph AIRAC 2610', bulk_started_at: START, bulk_completed_at: END, bulk_row_count: 3,
      created_at: END, updated_at: END,
    }]);
    expect(rows(out, 'SELECT * FROM lnm_dataset')).toEqual([{
      id: 1, snapshot_id: snapshotId, data_source: 'NAVIGRAPH', airac_cycle: '2610', valid_from: '2026-10-01',
      valid_through: '2026-10-28', compiled_at: '2026-09-30T20:15:00', navigraph_update: null, atools_db_version: '14.1',
      source_file_name: 'lnm-navigraph.sqlite', source_bytes: 4096, imported_at: END, label: 'Navigraph AIRAC 2610',
    }]);
    out.close();
  });

  it('describes an MSFS build by its scenery and carries no validity', () => {
    const out = freshReplica();
    const { dataset } = writeLnmMeta(out, {
      ...metadataOf(msfs()), sourceFileName: 'lnm-msfs.sqlite', sourceBytes: 1, startedAt: START, completedAt: END,
    });
    expect(dataset).toMatchObject({
      label: 'MSFS 2020 scenery with Navigraph update, compiled 2026-09-27', provider: 'MSFS', airacCycle: null,
      validFrom: null, validThrough: null, expired: null, navigraphUpdate: true,
    });
    expect(readNavdataDataset(out, 'lnm', END)).toEqual(dataset);
    expect(one(out, 'SELECT sim_id FROM nav_meta')).toBe('2020');
    expect(one(out, 'SELECT navigraph_update FROM lnm_dataset')).toBe(1);
    out.close();
  });

  it('maps MSFS24 to simulator 2024 and keeps the provider', () => {
    const out = freshReplica();
    writeLnmMeta(out, {
      ...metadataOf(msfs({ metadata: { data_source: 'MSFS24' } })), sourceFileName: 'x.sqlite', sourceBytes: 1,
      startedAt: START, completedAt: END,
    });
    expect(rows(out, 'SELECT n.sim_id, d.data_source, d.label, n.snapshot_id = d.snapshot_id AS same FROM nav_meta n, lnm_dataset d'))
      .toEqual([{ sim_id: '2024', data_source: 'MSFS24', label: expect.stringMatching(/^MSFS 2024 scenery/), same: 1 }]);
    expect(String(one(out, 'SELECT snapshot_id FROM nav_meta'))).toMatch(/^lnm-msfs24-/);
    out.close();
  });

  it('writes nothing when the dataset table is missing', () => {
    const out = new Database(':memory:');
    applyNavdataSchema(out);
    expect(() => writeLnmMeta(out, {
      ...metadataOf(msfs()), sourceFileName: 'x.sqlite', sourceBytes: 1, startedAt: START, completedAt: END,
    })).toThrow();
    expect(one(out, 'SELECT COUNT(*) FROM nav_meta')).toBe(0);
    out.close();
  });
});

// ── Fixture builder ──────────────────────────────────────────────────────────

describe('buildLnmFixture', () => {
  it('appends spec.extra rows to their table after the preset rows', () => {
    const base = openPreset('msfs');
    const before = one(base, 'SELECT COUNT(*) FROM com');
    const db = openFixture(msfs({ extra: { com: [{ com_id: 1000, airport_id: 1, type: 'CTAF', frequency: 122_900_000, name: 'EXTRA' }] } }));
    expect(one(db, 'SELECT COUNT(*) FROM com')).toBe(before + 1);
    expect(rows(db, 'SELECT airport_id, type, frequency, name FROM com WHERE com_id = 1000'))
      .toEqual([{ airport_id: 1, type: 'CTAF', frequency: 122_900_000, name: 'EXTRA' }]);
    expect(one(db, 'SELECT MAX(com_id) FROM com')).toBe(1000);
  });

  it('lets spec.metadata and spec.properties replace the preset metadata row', () => {
    const db = openFixture(navigraph({ metadata: { airac_cycle: '2611', last_load_timestamp: null }, properties: 'NavigraphUpdate=false\n' }));
    expect(rows(db, 'SELECT airac_cycle, last_load_timestamp, properties, data_source FROM metadata'))
      .toEqual([{ airac_cycle: '2611', last_load_timestamp: null, properties: 'NavigraphUpdate=false\n', data_source: 'NAVIGRAPH' }]);
    const cleared = openFixture(msfs({ properties: null }));
    expect(one(cleared, 'SELECT properties FROM metadata')).toBeNull();
    expect(one(openPreset('msfs'), 'SELECT properties FROM metadata')).toBe('NavigraphUpdate=true\n');
  });

  it('completes the NOT NULL columns an extra row leaves out', () => {
    const db = openFixture(msfs({ extra: { airport: [{ airport_id: 1000, ident: 'ZZAX', lonx: -160, laty: 10 }] } }));
    expect(rows(db, 'SELECT has_avgas, num_runways, file_id, name, region FROM airport WHERE airport_id = 1000'))
      .toEqual([{ has_avgas: 0, num_runways: 0, file_id: 0, name: null, region: null }]);
  });

  it('refuses a column the table lacks, and a row missing what identifies or places it', () => {
    expect(() => buildLnmFixture(dir, msfs({ extra: { com: [{ airport_id: 1, frequency: 1, bogus: 1 }] } })))
      .toThrow('lnm fixture: com has no column bogus');
    expect(() => buildLnmFixture(dir, msfs({ extra: { airport: [{ airport_id: 1000, lonx: -160, laty: 10 }] } })))
      .toThrow('lnm fixture: airport row must set ident');
    expect(() => buildLnmFixture(dir, msfs({ extra: { com: [{ airport_id: 1 }] } })))
      .toThrow('lnm fixture: com row must set frequency');
    expect(() => buildLnmFixture(dir, msfs({ extra: { approach_leg: [{ type: 'TF' }] } })))
      .toThrow('lnm fixture: approach_leg row must set approach_id');
  });

  it('writes to the named file inside the given directory, replacing an earlier one', () => {
    const file = buildLnmFixture(dir, msfs({ fileName: 'named.sqlite' }));
    expect(file).toBe(path.join(dir, 'named.sqlite'));
    expect(buildLnmFixture(dir, msfs({ fileName: 'named.sqlite' }))).toBe(file);
    expect(path.basename(buildLnmFixture(dir, navigraph()))).toBe('atools-navigraph.sqlite');
  });

  describe.each([['navigraph', navigraph], ['msfs', msfs]] as const)('the %s preset', (name, preset) => {
    const isNavigraph = name === 'navigraph';
    let db: Database.Database;
    beforeAll(() => {
      db = new Database(buildLnmFixture(dir, preset({ fileName: `preset-${name}.sqlite` })), { readonly: true });
    });
    afterAll(() => db.close());

    it('is accepted by flavour detection', () => {
      expect(detectFlavour(db).flavour).toBe(isNavigraph ? 'NAVIGRAPH' : 'MSFS');
    });

    it('holds an airport with two runways, one end named by true bearing and one runway of width 0', () => {
      expect(rows(db, 'SELECT COUNT(*) n FROM runway WHERE airport_id = 1')).toEqual([{ n: 2 }]);
      expect(rows(db, "SELECT name FROM runway_end WHERE name GLOB '[0-9][0-9]T'")).toEqual([{ name: '18T' }]);
      expect(rows(db, 'SELECT COUNT(*) n FROM runway WHERE width = 0')).toEqual([{ n: 1 }]);
    });

    it('holds a closed airport and an ILS-equipped runway end', () => {
      expect(rows(db, 'SELECT ident FROM airport WHERE is_closed = 1')).toEqual([{ ident: 'ZZAB' }]);
      expect(rows(db, "SELECT name FROM runway_end WHERE ils_ident = 'IZZA'")).toEqual([{ name: '27R' }]);
    });

    it('has a duplicated airport ident on Navigraph only', () => {
      expect(one(db, 'SELECT COUNT(*) FROM (SELECT ident FROM airport GROUP BY ident HAVING COUNT(*) > 1)')).toBe(isNavigraph ? 1 : 0);
    });

    it('has the .x20 and .x70 channels in the unit of its flavour, a UHF row and an orphan', () => {
      const f = (type: string, airport: number): number => one(db, 'SELECT frequency FROM com WHERE type = ? AND airport_id = ? ORDER BY com_id', type, airport);
      expect(f('T', 1)).toBe(isNavigraph ? 118_320 : 118_325_000);
      expect(rows(db, "SELECT frequency FROM com WHERE name = 'ZZAA APPROACH'")).toEqual([{ frequency: isNavigraph ? 119_370 : 119_375_000 }]);
      expect(rows(db, "SELECT frequency FROM com WHERE name = 'ZZAA APPROACH UHF'")).toEqual([{ frequency: isNavigraph ? 257_820 : 257_825_000 }]);
      expect(one(db, 'SELECT COUNT(*) FROM com WHERE airport_id = -1')).toBe(1);
      expect(one(db, 'SELECT MAX(frequency) < 1000000 FROM com')).toBe(isNavigraph ? 1 : 0);
      expect(one(db, 'SELECT MIN(frequency) >= 1000000 FROM com')).toBe(isNavigraph ? 0 : 1);
    });

    it('has a VOR, a TACAN and a DME-only VOR', () => {
      expect(rows(db, 'SELECT ident, type, dme_only FROM vor ORDER BY vor_id'))
        .toEqual([{ ident: 'ZZV', type: 'H', dme_only: 0 }, { ident: 'ZZT', type: 'TC', dme_only: 0 }, { ident: 'ZZD', type: 'L', dme_only: 1 }]);
    });

    it('has two NDBs sharing an ident and region, one of them an airway endpoint', () => {
      expect(rows(db, "SELECT ndb_id, airport_id FROM ndb WHERE ident = 'ZZN' AND region = 'ZZ' ORDER BY ndb_id"))
        .toEqual([{ ndb_id: 1, airport_id: null }, { ndb_id: 2, airport_id: 1 }]);
      expect(one(db, `SELECT COUNT(*) FROM airway a JOIN waypoint w ON w.waypoint_id IN (a.from_waypoint_id, a.to_waypoint_id)
                       WHERE w.type = 'N' AND w.nav_id = 2`)).toBe(1);
    });

    it('has an ILS sharing a VOR ident and region, with the ILS region set on Navigraph only', () => {
      expect(one(db, "SELECT COUNT(*) FROM ils i JOIN vor v ON v.ident = i.ident AND v.region = COALESCE(i.region, substr(i.loc_airport_ident, 1, 2)) WHERE i.ident = 'ZZV'")).toBe(1);
      expect(one(db, 'SELECT COUNT(*) FROM ils WHERE region IS NOT NULL')).toBe(isNavigraph ? 2 : 0);
    });

    it('has WN, WU and the edge waypoints, and a VFR fix sharing a VOR ident far away on MSFS only', () => {
      expect(one(db, "SELECT COUNT(*) FROM waypoint WHERE type = 'WN'")).toBeGreaterThan(0);
      expect(one(db, "SELECT COUNT(*) FROM waypoint WHERE type = 'WU'")).toBe(1);
      expect(one(db, 'SELECT COUNT(*) FROM waypoint WHERE lonx = 180')).toBe(1);
      expect(one(db, 'SELECT COUNT(*) FROM waypoint WHERE laty = 90')).toBe(1);
      expect(one(db, "SELECT COUNT(*) FROM waypoint WHERE type IN ('RNAV', 'VFR')")).toBe(isNavigraph ? 0 : 2);
      expect(one(db, "SELECT COUNT(*) FROM waypoint w JOIN vor v ON v.ident = w.ident AND v.region = w.region WHERE w.type = 'VFR' AND abs(w.lonx - v.lonx) > 3")).toBe(isNavigraph ? 0 : 1);
    });

    it('has an airway across the antimeridian', () => {
      expect(one(db, `SELECT COUNT(*) FROM airway a JOIN waypoint f ON f.waypoint_id = a.from_waypoint_id
                       JOIN waypoint t ON t.waypoint_id = a.to_waypoint_id WHERE abs(f.lonx - t.lonx) > 180`)).toBe(1);
    });

    it('has a SID on two runways sharing a tail, and a STAR with an ALL row', () => {
      expect(rows(db, "SELECT arinc_name FROM approach WHERE fix_ident = 'ZZ1D' AND suffix = 'D' AND has_gps_overlay = 1 ORDER BY approach_id"))
        .toEqual([{ arinc_name: 'RW09L' }, { arinc_name: 'RW27R' }]);
      const tail = (id: number): string[] => rows(db, 'SELECT fix_ident FROM approach_leg WHERE approach_id = ? ORDER BY approach_leg_id DESC LIMIT 2', id).map(r => r.fix_ident);
      expect(tail(1)).toEqual(tail(2));
      expect(rows(db, "SELECT arinc_name, runway_name FROM approach WHERE suffix = 'A' AND arinc_name = 'ALL'")).toEqual([{ arinc_name: 'ALL', runway_name: null }]);
    });

    it('has two approaches sharing a base key and an approach with duplicate transition names', () => {
      expect(rows(db, "SELECT approach_id FROM approach WHERE type = 'ILS' AND runway_name = '27R' ORDER BY approach_id")).toEqual([{ approach_id: 5 }, { approach_id: 6 }]);
      expect(rows(db, "SELECT COUNT(*) n FROM transition WHERE approach_id = 5 AND fix_ident = 'ZZW03'")).toEqual([{ n: 2 }]);
    });

    it('has RF and AF legs, a hold with a time, and a runway fix', () => {
      expect(one(db, "SELECT COUNT(*) FROM approach_leg WHERE type = 'RF'")).toBe(1);
      expect(one(db, "SELECT COUNT(*) FROM transition_leg WHERE type = 'AF'")).toBe(1);
      expect(one(db, "SELECT time FROM approach_leg WHERE type = 'HM'")).toBe(1);
      expect(one(db, "SELECT COUNT(*) FROM approach_leg WHERE fix_type = 'R'")).toBeGreaterThan(0);
    });

    it('differs from the other flavour in the encodings the importer must tell apart', () => {
      expect(one(db, 'SELECT COUNT(fix_laty) > 0 FROM approach_leg')).toBe(isNavigraph ? 1 : 0);
      expect(one(db, 'SELECT vertical_angle FROM approach_leg WHERE vertical_angle IS NOT NULL')).toBe(isNavigraph ? -3 : -3.57);
      expect(one(db, "SELECT COUNT(*) > 0 FROM approach_leg WHERE fix_type = 'TW'")).toBe(isNavigraph ? 0 : 1);
      expect(one(db, "SELECT COUNT(*) > 0 FROM approach_leg WHERE fix_type = 'TN'")).toBe(isNavigraph ? 0 : 1);
      expect(one(db, "SELECT COUNT(*) > 0 FROM approach_leg WHERE fix_type = 'N' AND fix_lonx IS NOT NULL")).toBe(isNavigraph ? 1 : 0);
      expect(one(db, "SELECT COUNT(*) > 0 FROM approach_leg WHERE recommended_fix_type = 'L'")).toBe(isNavigraph ? 0 : 1);
      expect(one(db, 'SELECT COUNT(arinc_descr_code) > 0 FROM approach_leg')).toBe(isNavigraph ? 1 : 0);
      expect(one(db, 'SELECT COUNT(altitude) + COUNT(heading) + COUNT(missed_altitude) FROM approach')).toBe(isNavigraph ? 0 : 6);
      expect(one(db, "SELECT COUNT(*) > 0 FROM transition WHERE dme_ident IS NOT NULL AND type = 'F'")).toBe(isNavigraph ? 0 : 1);
    });

    it('is built from invented names only', () => {
      for (const table of ['airport', 'vor', 'ndb', 'ils', 'waypoint']) {
        for (const r of rows(db, `SELECT ident, region FROM ${table}`)) {
          expect(r.ident).toMatch(/^(ZZ|IZZ)[A-Z0-9]*$/);
          expect([null, 'ZZ', 'ZY']).toContain(r.region ?? null);
        }
      }
      expect(rows(db, 'SELECT DISTINCT fix_region FROM approach_leg WHERE fix_region IS NOT NULL')).toEqual([{ fix_region: 'ZZ' }]);
    });
  });
});
