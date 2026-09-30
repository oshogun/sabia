import { beforeEach, describe, expect, it } from 'vitest';
import { parseCSVLine, parseCSV, setAirports, findNearestAirport, type Airport } from '../src/airports';

// initAirports() is never called from a test — it reads airports.json from
// disk or downloads over HTTPS. All fixtures below are inline CSV strings or
// in-memory Airport[] arrays fed through setAirports().

beforeEach(() => setAirports([]));

describe('parseCSVLine', () => {
  it('splits a plain unquoted row on commas', () => {
    expect(parseCSVLine('1,2,3')).toEqual(['1', '2', '3']);
  });

  it('keeps a quoted comma inside one field', () => {
    expect(parseCSVLine('1,"Foo, Bar",3')).toEqual(['1', 'Foo, Bar', '3']);
  });

  it('handles a quoted field containing no comma', () => {
    expect(parseCSVLine('1,"Foo",3')).toEqual(['1', 'Foo', '3']);
  });

  it('keeps an empty trailing field', () => {
    expect(parseCSVLine('1,2,')).toEqual(['1', '2', '']);
  });

  it('returns a single field when there is no comma at all', () => {
    expect(parseCSVLine('onlyfield')).toEqual(['onlyfield']);
  });
});

describe('parseCSV', () => {
  // 19 OurAirports columns:
  // id,ident,type,name,latitude_deg,longitude_deg,elevation_ft,continent,
  // iso_country,iso_region,municipality,scheduled_service,icao_code,iata_code,
  // gps_code,local_code,home_link,wikipedia_link,keywords
  const HEADER =
    'id,ident,type,name,latitude_deg,longitude_deg,elevation_ft,continent,iso_country,iso_region,municipality,scheduled_service,icao_code,iata_code,gps_code,local_code,home_link,wikipedia_link,keywords';

  function row(over: Partial<{
    id: string; ident: string; type: string; name: string; lat: string; lon: string; icao_code: string; gps_code: string;
  }> = {}): string {
    const f = {
      id: '1',
      ident: over.ident ?? 'KSBA',
      type: over.type ?? 'medium_airport',
      name: over.name ?? 'Santa Barbara Muni',
      lat: over.lat ?? '34.426201',
      lon: over.lon ?? '-119.841507',
      icao_code: over.icao_code ?? 'KSBA',
      gps_code: over.gps_code ?? '',
    };
    // columns: 0 id, 1 ident, 2 type, 3 name, 4 lat, 5 lon, 6..11 filler, 12 icao_code, 13 iata_code, 14 gps_code, 15..18 filler
    return [f.id, f.ident, f.type, f.name, f.lat, f.lon, '', '', '', '', '', '', f.icao_code, '', f.gps_code, '', '', '', ''].join(',');
  }

  it('accepts large_airport, medium_airport and small_airport', () => {
    const csv = [HEADER, row({ type: 'large_airport' }), row({ type: 'medium_airport' }), row({ type: 'small_airport' })].join('\n');
    expect(parseCSV(csv)).toHaveLength(3);
  });

  it('rejects a type not in {large_airport, medium_airport, small_airport}', () => {
    const csv = [HEADER, row({ type: 'heliport' })].join('\n');
    expect(parseCSV(csv)).toEqual([]);
  });

  it('rejects a row with non-numeric latitude', () => {
    const csv = [HEADER, row({ lat: 'not-a-number' })].join('\n');
    expect(parseCSV(csv)).toEqual([]);
  });

  it('rejects a row with non-numeric longitude', () => {
    const csv = [HEADER, row({ lon: 'not-a-number' })].join('\n');
    expect(parseCSV(csv)).toEqual([]);
  });

  it('rejects an ICAO of length 3', () => {
    const csv = [HEADER, row({ icao_code: '', ident: 'KSB' })].join('\n');
    expect(parseCSV(csv)).toEqual([]);
  });

  it('rejects an ICAO of length 5', () => {
    const csv = [HEADER, row({ icao_code: '', ident: 'KSBAX' })].join('\n');
    expect(parseCSV(csv)).toEqual([]);
  });

  it('rejects an ICAO containing a non-alphanumeric character', () => {
    const csv = [HEADER, row({ icao_code: '', ident: 'K-BA' })].join('\n');
    expect(parseCSV(csv)).toEqual([]);
  });

  it('prefers icao_code (col 12) over ident (col 1) when both are present and valid', () => {
    const csv = [HEADER, row({ ident: 'ZZZZ', icao_code: 'ksba' })].join('\n');
    expect(parseCSV(csv)).toEqual([{ icao: 'KSBA', name: 'Santa Barbara Muni', lat: 34.426201, lon: -119.841507 }]);
  });

  it('prefers icao_code (col 12) over gps_code (col 14) when they differ', () => {
    const csv = [HEADER, row({ icao_code: 'KSBA', gps_code: 'ZZZZ' })].join('\n');
    expect(parseCSV(csv)[0].icao).toBe('KSBA');
  });

  it('falls back to gps_code (col 14) when icao_code (col 12) is empty', () => {
    const csv = [HEADER, row({ icao_code: '', gps_code: 'UAAM' })].join('\n');
    expect(parseCSV(csv)[0].icao).toBe('UAAM');
  });

  it('parses a UAAM-shaped row (empty icao_code, gps_code UAAM, no matching ident)', () => {
    const csv = [HEADER, row({
      icao_code: '', gps_code: 'UAAM', ident: 'KZ-0073', name: 'Chundzha Airfield',
      type: 'small_airport', lat: '43.598202', lon: '79.427366',
    })].join('\n');
    expect(parseCSV(csv)).toEqual([{ icao: 'UAAM', name: 'Chundzha Airfield', lat: 43.598202, lon: 79.427366 }]);
  });

  it('falls back to ident (col 1) when both icao_code and gps_code are empty', () => {
    const csv = [HEADER, row({ icao_code: '', gps_code: '', ident: 'ksba' })].join('\n');
    expect(parseCSV(csv)[0].icao).toBe('KSBA');
  });

  it('uppercases and trims the resulting icao', () => {
    const csv = [HEADER, row({ icao_code: '  ksba  ' })].join('\n');
    expect(parseCSV(csv)[0].icao).toBe('KSBA');
  });

  it('falls back to the icao for name when col 3 (name) is empty', () => {
    const csv = [HEADER, row({ name: '', icao_code: 'KSBA' })].join('\n');
    expect(parseCSV(csv)[0].name).toBe('KSBA');
  });

  it('skips the header row and blank lines, including a trailing newline at end of input', () => {
    const csv = [HEADER, '', row({ ident: 'KSBA', icao_code: 'KSBA' }), '', row({ ident: 'KMRY', icao_code: 'KMRY', lat: '36.586952', lon: '-121.843079' }), ''].join('\n') + '\n';
    const result = parseCSV(csv);
    expect(result).toHaveLength(2);
    expect(result.map(a => a.icao)).toEqual(['KSBA', 'KMRY']);
  });
});

describe('findNearestAirport', () => {
  const KSBA: Airport = { icao: 'KSBA', name: 'Santa Barbara Muni', lat: 34.426201, lon: -119.841507 };
  const KMRY: Airport = { icao: 'KMRY', name: 'Monterey Rgnl', lat: 36.586952, lon: -121.843079 };

  it('returns null for an empty airport list', () => {
    setAirports([]);
    expect(findNearestAirport(34.426201, -119.841507)).toBeNull();
  });

  it('returns null when the nearest airport is beyond the default maxNm of 10', () => {
    setAirports([KMRY]); // ~162 nm from KSBA's coordinates
    expect(findNearestAirport(34.426201, -119.841507)).toBeNull();
  });

  it('returns the icao and name of a seeded airport inside 10 nm', () => {
    setAirports([KSBA]);
    expect(findNearestAirport(34.4262, -119.84)).toEqual({ icao: 'KSBA', name: 'Santa Barbara Muni' });
  });

  it('widens the result with a custom maxNm', () => {
    setAirports([KMRY]); // beyond the default 10 nm, within a generous custom radius
    expect(findNearestAirport(34.426201, -119.841507, 200)).toEqual({ icao: 'KMRY', name: 'Monterey Rgnl' });
  });

  it('picks the genuinely nearer of two airports', () => {
    setAirports([KMRY, KSBA]);
    expect(findNearestAirport(34.4262, -119.84)).toEqual({ icao: 'KSBA', name: 'Santa Barbara Muni' });
  });
});
