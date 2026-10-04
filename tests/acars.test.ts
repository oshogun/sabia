// tests/acars.test.ts — the ACARS rules in src/acars.ts.
//
// Scope: the direction and category validators, the canned set and the two ways
// of resolving an entry from a request, body normalisation, and the body guard
// every writer goes through. Nothing here touches a database, a clock or a
// server: src/acars.ts is pure by construction, and this file would stop
// compiling if that changed.
//
// The literal strings asserted below are the wire contract. cannedMessageIdList()
// in particular is the exact tail of the UNKNOWN_CANNED_MESSAGE error body the
// API returns, so the two cannot drift apart unnoticed.

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  ACARS_DIRECTIONS,
  CANNED_MESSAGES,
  CLIENT_DIRECTION,
  DEFAULT_POSITION_REPORT_INTERVAL_MIN,
  DISPATCH_RELEASE_LABEL,
  KNOWN_ACARS_CATEGORIES,
  LOADSHEET_LABEL,
  LOADSHEET_REQUEST_LABEL,
  MAX_ACARS_BODY_LENGTH,
  MAX_ACARS_IN_CHARS,
  MAX_ROUTE_BODY_CHARS,
  MIN_ETA_GROUND_SPEED_KTS,
  MIN_POSITION_REPORT_INTERVAL_MIN,
  NO_DISPATCH_DATA_MESSAGE,
  NO_FLIGHT_PLAN_MESSAGE,
  CLEARANCE_REQUEST_LABEL,
  CLEARANCE_LABEL,
  DEFAULT_INITIAL_ALTITUDE_FT,
  POSITION_REPORT_LABEL,
  buildDispatchPayload,
  buildDispatchReleaseBody,
  buildLoadsheetFigures,
  buildLoadsheetReplyBody,
  buildLoadsheetRequestBody,
  buildClearanceDetails,
  buildClearanceBody,
  buildCondensedClearanceMessage,
  parseClearancePayload,
  buildOooiBody,
  buildOooiMessage,
  buildOooiPayload,
  buildPositionReportBody,
  buildPositionReportMessage,
  buildPositionReportPayload,
  type OooiEventInput,
  type PositionReportInput,
  cannedMessageIdList,
  clampRoute,
  clearanceRequestDedupKey,
  clearanceDedupKey,
  deriveInitialAltitudeFt,
  squawkForLeg,
  dispatchDedupKey,
  estimateEnrouteSec,
  field,
  findCannedMessage,
  findCannedMessageByBody,
  formatLatLon,
  hhmm,
  hhmmz,
  isAcarsDirection,
  isKnownAcarsCategory,
  isValidAcarsCategory,
  levelText,
  loadsheetReplyDedupKey,
  loadsheetRequestDedupKey,
  normaliseCannedBody,
  oooiDedupKey,
  oooiEstimatedReason,
  parseDispatchPayload,
  parsePositionReportIntervalMs,
  positionReportDedupKey,
  qty,
  unitText,
  validateAcarsBody,
} from '../src/acars';
import { parseSimbriefPlan } from '../src/simbrief';
import type { ClearanceDetails, DispatchPayload, LoadsheetFigures } from '../src/types';

describe('isAcarsDirection', () => {
  it('accepts the two directions', () => {
    expect(isAcarsDirection('uplink')).toBe(true);
    expect(isAcarsDirection('downlink')).toBe(true);
    expect(ACARS_DIRECTIONS).toEqual(['uplink', 'downlink']);
    expect(CLIENT_DIRECTION).toBe('downlink');
  });

  it('rejects everything else, including a case variant', () => {
    for (const v of ['UPLINK', 'up', 'Downlink', '', null, undefined, 0, {}, []]) {
      expect(isAcarsDirection(v)).toBe(false);
    }
  });
});

describe('isValidAcarsCategory', () => {
  it('accepts every category the codebase knows', () => {
    for (const c of KNOWN_ACARS_CATEGORIES) expect(isValidAcarsCategory(c)).toBe(true);
  });

  it("accepts 'oooi', which the message centre's own five categories omit", () => {
    // This is the category that makes a CHECK constraint on the column
    // unworkable: position reports need it and the message centre never did.
    expect(isValidAcarsCategory('oooi')).toBe(true);
  });

  it('accepts a well-shaped category it has never heard of', () => {
    expect(isValidAcarsCategory('atis')).toBe(true);
    expect(isValidAcarsCategory('crew-schedule')).toBe(true);
  });

  it('rejects the wrong shape', () => {
    for (const v of ['PDC', '-pdc', 'pdc ', ' pdc', '', '1pdc', 'pdc_request', null, undefined, 12, {}]) {
      expect(isValidAcarsCategory(v)).toBe(false);
    }
  });

  it('rejects a category longer than 32 characters', () => {
    expect(isValidAcarsCategory('a'.repeat(32))).toBe(true);
    expect(isValidAcarsCategory('a'.repeat(33))).toBe(false);
  });
});

describe('isKnownAcarsCategory', () => {
  it('is membership, not validity', () => {
    for (const c of KNOWN_ACARS_CATEGORIES) expect(isKnownAcarsCategory(c)).toBe(true);
    // Well-shaped, so storable and valid, but not one this codebase labels.
    expect(isValidAcarsCategory('atis')).toBe(true);
    expect(isKnownAcarsCategory('atis')).toBe(false);
  });
});

describe('CANNED_MESSAGES', () => {
  it('is exactly the three entries, in render order', () => {
    expect(CANNED_MESSAGES.map(m => m.id)).toEqual(['wx-request', 'gate-request', 'request-pushback']);
    expect(CANNED_MESSAGES.map(m => m.label)).toEqual(['WX REQUEST', 'GATE REQUEST', 'REQUEST PUSHBACK']);
    expect(CANNED_MESSAGES.map(m => m.body)).toEqual(['WX REQUEST', 'GATE REQUEST', 'REQUEST PUSHBACK']);
  });

  it('is entirely downlink freetext — a client cannot forge an uplink', () => {
    for (const m of CANNED_MESSAGES) {
      expect(m.direction).toBe('downlink');
      expect(m.category).toBe('freetext');
    }
  });

  it('has unique ids', () => {
    expect(new Set(CANNED_MESSAGES.map(m => m.id)).size).toBe(CANNED_MESSAGES.length);
  });
});

describe('findCannedMessage', () => {
  it('resolves each id to its exact body', () => {
    expect(findCannedMessage('wx-request')?.body).toBe('WX REQUEST');
    expect(findCannedMessage('gate-request')?.body).toBe('GATE REQUEST');
    expect(findCannedMessage('request-pushback')?.body).toBe('REQUEST PUSHBACK');
  });

  it('matches exactly: an id is a wire value, not user typing', () => {
    for (const v of ['WX-REQUEST', 'wx_request', 'wx-request ', 'pushback', '', null, undefined, 42, {}]) {
      expect(findCannedMessage(v)).toBeNull();
    }
  });
});

describe('findCannedMessageByBody', () => {
  it('matches through trimming, whitespace collapse and case', () => {
    for (const v of ['WX REQUEST', '  wx request  ', 'wx\nrequest', 'WX  REQUEST', 'wx\trequest']) {
      expect(findCannedMessageByBody(v)?.id).toBe('wx-request');
    }
    expect(findCannedMessageByBody('request pushback')?.id).toBe('request-pushback');
  });

  it('refuses anything that is not one of the three', () => {
    for (const v of ['WX REQUEST EGLL', 'PUSHBACK', 'HELLO DISPATCH', '', '   ', null, undefined, 7]) {
      expect(findCannedMessageByBody(v)).toBeNull();
    }
  });
});

describe('normaliseCannedBody', () => {
  it('trims, collapses whitespace runs and uppercases', () => {
    expect(normaliseCannedBody('  request   pushback\n')).toBe('REQUEST PUSHBACK');
    expect(normaliseCannedBody('wx\n\trequest')).toBe('WX REQUEST');
  });

  it('is idempotent', () => {
    for (const v of ['  wx  request ', 'GATE REQUEST', 'a\n\nb']) {
      expect(normaliseCannedBody(normaliseCannedBody(v))).toBe(normaliseCannedBody(v));
    }
  });
});

describe('validateAcarsBody', () => {
  it('returns the trimmed body', () => {
    expect(validateAcarsBody('  REQUEST PUSHBACK  ')).toEqual({ ok: true, body: 'REQUEST PUSHBACK' });
  });

  it('keeps interior newlines intact — a stored METAR or PDC is multi-line', () => {
    const metar = 'METAR EGLL 141020Z 25012KT 9999 FEW035 14/07 Q1014\nTAF EGLL 141100Z 1412/1518';
    expect(validateAcarsBody(metar)).toEqual({ ok: true, body: metar });
  });

  it('rejects an empty or whitespace-only body', () => {
    for (const v of ['', '   ', '\n\t']) {
      expect(validateAcarsBody(v)).toEqual({
        ok: false, code: 'INVALID_BODY', error: 'Message body must not be empty',
      });
    }
  });

  it('rejects a non-string', () => {
    for (const v of [null, undefined, 42, {}, ['REQUEST PUSHBACK']]) {
      expect(validateAcarsBody(v)).toEqual({
        ok: false, code: 'INVALID_BODY', error: 'Message body must be text',
      });
    }
  });

  it('bounds the length at MAX_ACARS_BODY_LENGTH', () => {
    expect(MAX_ACARS_BODY_LENGTH).toBe(4096);
    expect(validateAcarsBody('A'.repeat(MAX_ACARS_BODY_LENGTH)).ok).toBe(true);
    expect(validateAcarsBody('A'.repeat(MAX_ACARS_BODY_LENGTH + 1))).toEqual({
      ok: false, code: 'BODY_TOO_LONG', error: 'Message body is too long (max 4096 characters)',
    });
  });
});

describe('cannedMessageIdList', () => {
  it('is the exact tail of the UNKNOWN_CANNED_MESSAGE error body', () => {
    expect(cannedMessageIdList()).toBe('wx-request, gate-request, request-pushback');
    expect(`canned_id must be one of: ${cannedMessageIdList()}`)
      .toBe('canned_id must be one of: wx-request, gate-request, request-pushback');
  });
});

// ── Dispatch release + load sheet ───────────────────────────────────────────
//
// A SimBrief import files a dispatch release, and a pilot action files a
// load-sheet request/reply pair, both keyed to a planned leg. Every function
// under test here is pure: no clock, no database. `issuedAt` is always the
// caller's literal string, never a fresh Date().
//
// `buildDispatchPayload`/`parseDispatchPayload` are exercised against the real
// captured OFP (samples/simbrief/simbrief.userid.json, King Air 200, no
// alternate filed) via the real parser, so the payload under test is exactly
// what an import would produce — not a hand-typed stand-in for it. Everything
// else uses a hand-built DispatchPayload, which is plain data and does not
// need a parsed plan behind it.

const REAL_CAPTURE_PATH = path.resolve(__dirname, '../samples/simbrief/simbrief.userid.json');

function realDispatchPayload(): DispatchPayload {
  const plan = parseSimbriefPlan(fs.readFileSync(REAL_CAPTURE_PATH));
  return buildDispatchPayload(plan);
}

/** A fully-populated payload, independent of any parsed plan, for edge-case tests. */
function basePayload(over: Partial<DispatchPayload> = {}): DispatchPayload {
  return {
    v: 1,
    source: 'simbrief',
    ofp: { request_id: '186182026', sequence_id: '60bafd06304e', time_generated: '1789306516' },
    flight_number: 'SHG037',
    aircraft_type: 'BE20',
    aircraft_reg: 'N201SB',
    origin: 'UHPP',
    destination: 'UHSS',
    alternates: [],
    route: 'SAMI4L SAMIK T577 UB P176 NAMUL P175 ROMUK R810 BELNA DCT LEKPA LEKP4V',
    cruise_alt_ft: 28000,
    units: 'kgs',
    ete_sec: 12033,
    block_time_sec: 13713,
    fuel: {
      ramp: 1241, takeoff: 1159, landing: 287, taxi: 82,
      enroute_burn: 872, contingency: 65, reserve: 222, alternate_burn: 0,
    },
    weights: {
      oew: 3869, payload: 642, est_zfw: 4511, max_zfw: 4990,
      est_tow: 5670, est_ldw: 4798, pax_count: 7, cargo: 86,
    },
    ...over,
  };
}

describe('dispatch and load-sheet constants', () => {
  it('are the exact wire-contract strings', () => {
    expect(DISPATCH_RELEASE_LABEL).toBe('DISPATCH RELEASE');
    expect(LOADSHEET_REQUEST_LABEL).toBe('REQUEST LOADSHEET');
    expect(LOADSHEET_LABEL).toBe('LOADSHEET');
    expect(NO_DISPATCH_DATA_MESSAGE).toBe('NO DISPATCH DATA ON FILE');
    expect(MAX_ROUTE_BODY_CHARS).toBe(900);
  });
});

describe('dedup key builders', () => {
  it('build the three literal formulas, keyed on the planned leg id', () => {
    expect(dispatchDedupKey(42)).toBe('dispatch:leg:42');
    expect(loadsheetRequestDedupKey(42)).toBe('loadsheet-req:leg:42');
    expect(loadsheetReplyDedupKey(42)).toBe('loadsheet:leg:42');
  });

  it('gives a different leg its own keys, and never collides across the three kinds', () => {
    expect(dispatchDedupKey(1)).not.toBe(dispatchDedupKey(2));
    expect(dispatchDedupKey(42)).not.toBe(loadsheetRequestDedupKey(42));
    expect(loadsheetRequestDedupKey(42)).not.toBe(loadsheetReplyDedupKey(42));
    expect(dispatchDedupKey(42)).not.toBe(loadsheetReplyDedupKey(42));
  });
});

describe('hhmm', () => {
  it('formats seconds as HHMM, discarding seconds rather than rounding up', () => {
    expect(hhmm(0)).toBe('0000');
    expect(hhmm(59)).toBe('0000');
    expect(hhmm(12033)).toBe('0320');
  });

  it('keeps counting past 24 hours rather than wrapping', () => {
    expect(hhmm(86400)).toBe('2400');
    expect(hhmm(90000)).toBe('2500');
  });

  it('falls back to dashes for null, non-finite or negative input', () => {
    expect(hhmm(null)).toBe('----');
    expect(hhmm(NaN)).toBe('----');
    expect(hhmm(Infinity)).toBe('----');
    expect(hhmm(-1)).toBe('----');
  });
});

describe('levelText', () => {
  it('null -> UNKNOWN', () => {
    expect(levelText(null)).toBe('UNKNOWN');
  });

  it('renders a flight level at and above the 18000ft transition', () => {
    expect(levelText(28000)).toBe('FL280');
    expect(levelText(18000)).toBe('FL180');
  });

  it('renders a plain altitude below the transition', () => {
    expect(levelText(8000)).toBe('8000FT');
    expect(levelText(17999)).toBe('17999FT');
  });

  it('rounds before comparing to the transition, so a value that rounds up crosses it', () => {
    expect(levelText(17999.6)).toBe('FL180');
  });
});

describe('qty', () => {
  it('null -> dashes', () => {
    expect(qty(null)).toBe('----');
  });

  it('rounds to the nearest whole unit, no separator, no suffix', () => {
    expect(qty(1241)).toBe('1241');
    expect(qty(0)).toBe('0');
    expect(qty(642.5)).toBe('643');
    expect(qty(642.4)).toBe('642');
  });
});

describe('unitText', () => {
  it('maps the kg and lb spellings, case-insensitively', () => {
    expect(unitText('kgs')).toBe('KG');
    expect(unitText('kg')).toBe('KG');
    expect(unitText('KGS')).toBe('KG');
    expect(unitText('lbs')).toBe('LB');
    expect(unitText('lb')).toBe('LB');
    expect(unitText('LB')).toBe('LB');
  });

  it('falls back to UNITS UNKNOWN for anything else, including null', () => {
    expect(unitText('tonnes')).toBe('UNITS UNKNOWN');
    expect(unitText(null)).toBe('UNITS UNKNOWN');
  });
});

describe('clampRoute', () => {
  it('null -> NIL', () => {
    expect(clampRoute(null)).toBe('NIL');
  });

  it('leaves a route at or under the cap verbatim', () => {
    const atCap = 'A'.repeat(MAX_ROUTE_BODY_CHARS);
    expect(clampRoute(atCap)).toBe(atCap);
    expect(clampRoute(atCap)).toHaveLength(MAX_ROUTE_BODY_CHARS);
  });

  it('truncates one character past the cap to 897 characters plus an ellipsis', () => {
    const overCap = 'A'.repeat(MAX_ROUTE_BODY_CHARS + 1);
    const result = clampRoute(overCap);
    expect(result).toHaveLength(MAX_ROUTE_BODY_CHARS);
    expect(result).toBe('A'.repeat(MAX_ROUTE_BODY_CHARS - 3) + '...');
  });
});

describe('field', () => {
  it('pads the label to 14 and right-aligns the value to 6', () => {
    expect(field('TRIP FUEL', '872')).toBe('TRIP FUEL        872');
    expect(field('BLOCK FUEL', '1241')).toBe('BLOCK FUEL      1241');
    expect(field('ZERO FUEL WT', '4511')).toBe('ZERO FUEL WT    4511');
  });

  it('does not truncate a label already at or past 14 characters', () => {
    expect(field('A VERY LONG LABEL', '1')).toBe('A VERY LONG LABEL     1');
  });
});

describe('buildDispatchPayload', () => {
  it('is a straight field copy of the real captured OFP, including the no-alternate case', () => {
    const payload = realDispatchPayload();
    expect(payload).toEqual({
      v: 1,
      source: 'simbrief',
      ofp: { request_id: '186182026', sequence_id: '60bafd06304e', time_generated: '1789306516' },
      flight_number: 'SHG037',
      aircraft_type: 'BE20',
      aircraft_reg: 'N201SB',
      origin: 'UHPP',
      destination: 'UHSS',
      alternates: [],
      route: 'SAMI4L SAMIK T577 UB P176 NAMUL P175 ROMUK R810 BELNA DCT LEKPA LEKP4V',
      cruise_alt_ft: 28000,
      units: 'kgs',
      ete_sec: 12033,
      block_time_sec: 13713,
      fuel: {
        ramp: 1241, takeoff: 1159, landing: 287, taxi: 82,
        enroute_burn: 872, contingency: 65, reserve: 222, alternate_burn: 0,
      },
      weights: {
        oew: 3869, payload: 642, est_zfw: 4511, max_zfw: 4990,
        est_tow: 5670, est_ldw: 4798, pax_count: 7, cargo: 86,
      },
    });
  });

  it('stringifies to exactly the stored form', () => {
    // The wire form actually written to payload_json — a change here changes
    // every row already on disk.
    expect(JSON.stringify(realDispatchPayload())).toBe(
      '{"v":1,"source":"simbrief","ofp":{"request_id":"186182026","sequence_id":"60bafd06304e","time_generated":"1789306516"},"flight_number":"SHG037","aircraft_type":"BE20","aircraft_reg":"N201SB","origin":"UHPP","destination":"UHSS","alternates":[],"route":"SAMI4L SAMIK T577 UB P176 NAMUL P175 ROMUK R810 BELNA DCT LEKPA LEKP4V","cruise_alt_ft":28000,"units":"kgs","ete_sec":12033,"block_time_sec":13713,"fuel":{"ramp":1241,"takeoff":1159,"landing":287,"taxi":82,"enroute_burn":872,"contingency":65,"reserve":222,"alternate_burn":0},"weights":{"oew":3869,"payload":642,"est_zfw":4511,"max_zfw":4990,"est_tow":5670,"est_ldw":4798,"pax_count":7,"cargo":86}}',
    );
  });
});

describe('parseDispatchPayload', () => {
  it('round-trips exactly what buildDispatchPayload produced', () => {
    const built = realDispatchPayload();
    const roundTripped = parseDispatchPayload(JSON.stringify(built));
    expect(roundTripped).toEqual(built);
  });

  it('treats absent data as no dispatch data on file', () => {
    expect(parseDispatchPayload(null)).toBeNull();
    expect(parseDispatchPayload('')).toBeNull();
  });

  it('rejects malformed JSON rather than throwing', () => {
    expect(parseDispatchPayload('{not valid json')).toBeNull();
    expect(parseDispatchPayload('"just a string"')).toBeNull();
  });

  it('rejects a missing or wrong schema version', () => {
    expect(parseDispatchPayload(JSON.stringify({ source: 'simbrief' }))).toBeNull();
    expect(parseDispatchPayload(JSON.stringify({ v: 2, source: 'simbrief' }))).toBeNull();
    expect(parseDispatchPayload(JSON.stringify({ v: '1', source: 'simbrief' }))).toBeNull();
  });

  it('rejects a wrong or missing source', () => {
    expect(parseDispatchPayload(JSON.stringify({ v: 1 }))).toBeNull();
    expect(parseDispatchPayload(JSON.stringify({ v: 1, source: 'other' }))).toBeNull();
  });

  it('rejects a value that is not an object, including null and an array', () => {
    expect(parseDispatchPayload(JSON.stringify(null))).toBeNull();
    expect(parseDispatchPayload(JSON.stringify(42))).toBeNull();
    expect(parseDispatchPayload(JSON.stringify([1, 2, 3]))).toBeNull();
  });

  it('drops a scalar written as a string rather than coercing it', () => {
    // This blob is written by us, in one place; a numeric field arriving as a
    // string means the stored data is not what we wrote.
    const raw = JSON.stringify({
      v: 1, source: 'simbrief', cruise_alt_ft: '28000',
      fuel: { ramp: '1241' }, weights: { oew: '3869' },
    });
    const parsed = parseDispatchPayload(raw);
    expect(parsed?.cruise_alt_ft).toBeNull();
    expect(parsed?.fuel.ramp).toBeNull();
    expect(parsed?.weights.oew).toBeNull();
  });

  it('substitutes an all-null fuel/weights node when the source object omits it', () => {
    const parsed = parseDispatchPayload(JSON.stringify({ v: 1, source: 'simbrief' }));
    expect(parsed?.fuel).toEqual({
      ramp: null, takeoff: null, landing: null, taxi: null,
      enroute_burn: null, contingency: null, reserve: null, alternate_burn: null,
    });
    expect(parsed?.weights).toEqual({
      oew: null, payload: null, est_zfw: null, max_zfw: null,
      est_tow: null, est_ldw: null, pax_count: null, cargo: null,
    });
    expect(parsed?.alternates).toEqual([]);
  });

  it('filters a non-string entry out of alternates rather than rejecting the whole payload', () => {
    const parsed = parseDispatchPayload(JSON.stringify({
      v: 1, source: 'simbrief', alternates: ['UHSH', 42, null, 'ZZZZ'],
    }));
    expect(parsed?.alternates).toEqual(['UHSH', 'ZZZZ']);
  });
});

describe('buildDispatchReleaseBody', () => {
  const ISSUED_AT = '2026-09-14T09:22:01.000Z';

  it('renders the real captured OFP to the exact ten-line body', () => {
    const body = buildDispatchReleaseBody(realDispatchPayload(), ISSUED_AT);
    expect(body).toBe([
      'DISPATCH RELEASE',
      'FLT SHG037',
      'UHPP UHSS ALTN NONE',
      'ACFT BE20 N201SB',
      'CRZ FL280',
      'ETE 0320',
      'FUEL KG BLOCK 1241 TRIP 872 RESV 222 ALTN 0 CONT 65 TAXI 82',
      'RTE SAMI4L SAMIK T577 UB P176 NAMUL P175 ROMUK R810 BELNA DCT LEKPA LEKP4V',
      'OFP 186182026 ISSUED 2026-09-14T09:22:01.000Z',
      'SIMULATED DISPATCH RELEASE - NOT FOR REAL WORLD USE',
    ].join('\n'));
  });

  it('joins two or more alternates with a space rather than listing NONE', () => {
    const body = buildDispatchReleaseBody(basePayload({ alternates: ['UHSH', 'UHSA'] }), ISSUED_AT);
    expect(body.split('\n')[2]).toBe('UHPP UHSS ALTN UHSH UHSA');
  });

  it('falls back to placeholders for every field that can be missing', () => {
    const empty = basePayload({
      flight_number: null, origin: null, destination: null, aircraft_type: null,
      aircraft_reg: null, cruise_alt_ft: null, ete_sec: null, route: null,
      ofp: { request_id: null, sequence_id: null, time_generated: null },
      fuel: { ramp: null, takeoff: null, landing: null, taxi: null, enroute_burn: null, contingency: null, reserve: null, alternate_burn: null },
      units: null,
    });
    const body = buildDispatchReleaseBody(empty, ISSUED_AT);
    expect(body).toBe([
      'DISPATCH RELEASE',
      'FLT UNKNOWN',
      '???? ???? ALTN NONE',
      'ACFT UNKNOWN NOREG',
      'CRZ UNKNOWN',
      'ETE ----',
      'FUEL UNITS UNKNOWN BLOCK ---- TRIP ---- RESV ---- ALTN ---- CONT ---- TAXI ----',
      'RTE NIL',
      `OFP UNKNOWN ISSUED ${ISSUED_AT}`,
      'SIMULATED DISPATCH RELEASE - NOT FOR REAL WORLD USE',
    ].join('\n'));
  });

  it('always ends with the simulation disclaimer', () => {
    expect(buildDispatchReleaseBody(basePayload(), ISSUED_AT).split('\n').at(-1))
      .toBe('SIMULATED DISPATCH RELEASE - NOT FOR REAL WORLD USE');
  });
});

describe('buildLoadsheetFigures', () => {
  it('takes block fuel, payload and ZFW straight from SimBrief when all three are present', () => {
    const sheet = buildLoadsheetFigures(realDispatchPayload());
    expect(sheet).toEqual({
      units: 'kgs',
      block_fuel: 1241,
      taxi_fuel: 82,
      takeoff_fuel: 1159,
      trip_fuel: 872,
      payload: 642,
      payload_source: 'simbrief',
      zero_fuel_weight: 4511,
      zfw_source: 'simbrief',
      max_zero_fuel_weight: 4990,
      dry_operating_weight: 3869,
      takeoff_weight: 5670,
      landing_weight: 4798,
      pax_count: 7,
      cargo: 86,
      estimated: true,
    });
  });

  it('falls back to takeoff + taxi for block fuel when ramp is absent', () => {
    const sheet = buildLoadsheetFigures(basePayload({ fuel: { ...basePayload().fuel, ramp: null } }));
    expect(sheet.block_fuel).toBe(1159 + 82);
  });

  it('leaves block fuel null when ramp is absent and either of takeoff/taxi is too', () => {
    const noTaxi = buildLoadsheetFigures(basePayload({ fuel: { ...basePayload().fuel, ramp: null, taxi: null } }));
    expect(noTaxi.block_fuel).toBeNull();
    const noTakeoff = buildLoadsheetFigures(basePayload({ fuel: { ...basePayload().fuel, ramp: null, takeoff: null } }));
    expect(noTakeoff.block_fuel).toBeNull();
  });

  it('derives payload from est_zfw - oew when SimBrief payload is absent, and marks it derived', () => {
    const p = basePayload({ weights: { ...basePayload().weights, payload: null } });
    const sheet = buildLoadsheetFigures(p);
    expect(sheet.payload).toBe(4511 - 3869);
    expect(sheet.payload_source).toBe('derived');
    // ZFW itself is still the SimBrief figure, unaffected by the payload fallback.
    expect(sheet.zero_fuel_weight).toBe(4511);
    expect(sheet.zfw_source).toBe('simbrief');
  });

  it('derives ZFW from oew + payload when SimBrief est_zfw is absent', () => {
    const p = basePayload({ weights: { ...basePayload().weights, est_zfw: null } });
    const sheet = buildLoadsheetFigures(p);
    expect(sheet.zero_fuel_weight).toBe(3869 + 642);
    expect(sheet.zfw_source).toBe('derived');
  });

  it('marks payload and ZFW unavailable, never both derived at once, when neither input is present', () => {
    const p = basePayload({ weights: { ...basePayload().weights, payload: null, est_zfw: null } });
    const sheet = buildLoadsheetFigures(p);
    expect(sheet.payload).toBeNull();
    expect(sheet.payload_source).toBe('unavailable');
    // ZFW's fallback needs the payload it would have resolved to; with payload
    // itself unavailable, ZFW cannot derive either.
    expect(sheet.zero_fuel_weight).toBeNull();
    expect(sheet.zfw_source).toBe('unavailable');
  });

  it('passes weights and pax/cargo straight through with no rounding', () => {
    const p = basePayload({ weights: { ...basePayload().weights, oew: 3869.4, max_zfw: 4990.6 } });
    const sheet = buildLoadsheetFigures(p);
    expect(sheet.dry_operating_weight).toBe(3869.4);
    expect(sheet.max_zero_fuel_weight).toBe(4990.6);
  });

  it('is always marked estimated', () => {
    expect(buildLoadsheetFigures(basePayload()).estimated).toBe(true);
    expect(buildLoadsheetFigures(basePayload({ fuel: { ramp: null, takeoff: null, landing: null, taxi: null, enroute_burn: null, contingency: null, reserve: null, alternate_burn: null }, weights: { oew: null, payload: null, est_zfw: null, max_zfw: null, est_tow: null, est_ldw: null, pax_count: null, cargo: null } })).estimated).toBe(true);
  });
});

describe('buildLoadsheetRequestBody', () => {
  it('renders the real captured OFP to the exact two-line body', () => {
    const body = buildLoadsheetRequestBody(realDispatchPayload());
    expect(body).toBe('REQUEST LOADSHEET\nUHPP UHSS FLT SHG037');
  });

  it('omits the FLT clause entirely when flight_number is null, rather than a dangling FLT', () => {
    const body = buildLoadsheetRequestBody(basePayload({ flight_number: null }));
    expect(body).toBe('REQUEST LOADSHEET\nUHPP UHSS');
  });

  it('falls back to ???? for a missing origin or destination', () => {
    const body = buildLoadsheetRequestBody(basePayload({ origin: null, destination: null }));
    expect(body).toBe('REQUEST LOADSHEET\n???? ???? FLT SHG037');
  });
});

describe('buildLoadsheetReplyBody', () => {
  const ISSUED_AT = '2026-09-14T09:22:01.000Z';

  it('renders the real captured OFP to the exact seventeen-line body', () => {
    const payload = realDispatchPayload();
    const sheet = buildLoadsheetFigures(payload);
    const body = buildLoadsheetReplyBody(payload, sheet, ISSUED_AT);
    expect(body).toBe([
      'LOADSHEET',
      'FLT SHG037 UHPP UHSS',
      'ACFT BE20 N201SB',
      'UNITS KG',
      'BLOCK FUEL      1241',
      'TAXI FUEL         82',
      'TAKEOFF FUEL    1159',
      'TRIP FUEL        872',
      'PAX                7',
      'CARGO             86',
      'PAYLOAD          642',
      'DRY OPER WT     3869',
      'ZERO FUEL WT    4511 MAX 4990',
      'TAKEOFF WT      5670',
      'LANDING WT      4798',
      `ISSUED ${ISSUED_AT}`,
      'ESTIMATED FIGURES - SIMULATION ONLY - NOT FOR ACTUAL LOADING',
    ].join('\n'));
    expect(body.split('\n')).toHaveLength(17);
  });

  it('appends MAX <n> to the ZFW line only when max_zero_fuel_weight is present', () => {
    const payload = basePayload();
    const withMax = buildLoadsheetReplyBody(payload, buildLoadsheetFigures(payload), ISSUED_AT);
    expect(withMax.split('\n').find(l => l.startsWith('ZERO FUEL WT'))).toBe('ZERO FUEL WT    4511 MAX 4990');

    const noMaxPayload = basePayload({ weights: { ...basePayload().weights, max_zfw: null } });
    const withoutMax = buildLoadsheetReplyBody(noMaxPayload, buildLoadsheetFigures(noMaxPayload), ISSUED_AT);
    expect(withoutMax.split('\n').find(l => l.startsWith('ZERO FUEL WT'))).toBe('ZERO FUEL WT    4511');
  });

  it('renders every unresolved figure as dashes rather than crashing', () => {
    const empty = basePayload({
      flight_number: null, origin: null, destination: null, aircraft_type: null, aircraft_reg: null, units: null,
      fuel: { ramp: null, takeoff: null, landing: null, taxi: null, enroute_burn: null, contingency: null, reserve: null, alternate_burn: null },
      weights: { oew: null, payload: null, est_zfw: null, max_zfw: null, est_tow: null, est_ldw: null, pax_count: null, cargo: null },
    });
    const sheet = buildLoadsheetFigures(empty);
    const body = buildLoadsheetReplyBody(empty, sheet, ISSUED_AT);
    expect(body).toBe([
      'LOADSHEET',
      'FLT UNKNOWN ???? ????',
      'ACFT UNKNOWN NOREG',
      'UNITS UNITS UNKNOWN',
      'BLOCK FUEL      ----',
      'TAXI FUEL       ----',
      'TAKEOFF FUEL    ----',
      'TRIP FUEL       ----',
      'PAX             ----',
      'CARGO           ----',
      'PAYLOAD         ----',
      'DRY OPER WT     ----',
      'ZERO FUEL WT    ----',
      'TAKEOFF WT      ----',
      'LANDING WT      ----',
      `ISSUED ${ISSUED_AT}`,
      'ESTIMATED FIGURES - SIMULATION ONLY - NOT FOR ACTUAL LOADING',
    ].join('\n'));
  });

  it('always ends with the simulation disclaimer', () => {
    const payload = basePayload();
    expect(buildLoadsheetReplyBody(payload, buildLoadsheetFigures(payload), ISSUED_AT).split('\n').at(-1))
      .toBe('ESTIMATED FIGURES - SIMULATION ONLY - NOT FOR ACTUAL LOADING');
  });
});

describe('LoadsheetFigures shape sanity', () => {
  it('matches the shape stored in payload_json and returned as the API response sheet', () => {
    // A LoadsheetFigures built here must be assignable to what the reply row
    // and the request/reply endpoint's response both carry.
    const sheet: LoadsheetFigures = buildLoadsheetFigures(realDispatchPayload());
    expect(JSON.parse(JSON.stringify(sheet))).toEqual(sheet);
  });
});

// ── OOOI events + position reports ──────────────────────────────────────────
//
// Server-generated: FlightManager builds these from in-memory state and files
// them through src/acarsEvents.ts. Every function under test here is pure —
// no clock, no database — and `at` is always the caller's literal ISO string.

function baseOooiInput(over: Partial<OooiEventInput> = {}): OooiEventInput {
  return {
    flightId: 12,
    event: 'OUT',
    at: '2026-09-16T14:32:07.000Z',
    airportIcao: 'KSBA',
    stand: 'A4',
    aircraft: 'Airbus A320neo',
    destinationIdent: 'KLAX',
    plannedLegId: 34,
    estimated: false,
    ...over,
  };
}

function basePositionReportInput(over: Partial<PositionReportInput> = {}): PositionReportInput {
  return {
    flightId: 12,
    windowIndex: 1,
    at: '2026-09-16T14:32:07.000Z',
    lat: 34.426201,
    lon: -119.841507,
    altitudeFt: 33000,
    groundSpeedKnots: 200,
    headingDeg: 98,
    nextWaypointIdent: 'RZS',
    destinationIdent: 'KLAX',
    remainingDistanceNm: 100,
    plannedLegId: 34,
    ...over,
  };
}

describe('oooiDedupKey', () => {
  it('builds the frozen formula for all four events', () => {
    expect(oooiDedupKey(12, 'OUT')).toBe('oooi:flight:12:OUT');
    expect(oooiDedupKey(12, 'OFF')).toBe('oooi:flight:12:OFF');
    expect(oooiDedupKey(12, 'ON')).toBe('oooi:flight:12:ON');
    expect(oooiDedupKey(12, 'IN')).toBe('oooi:flight:12:IN');
  });

  it('never collides across flights or events', () => {
    expect(oooiDedupKey(1, 'OUT')).not.toBe(oooiDedupKey(2, 'OUT'));
    expect(oooiDedupKey(12, 'OUT')).not.toBe(oooiDedupKey(12, 'OFF'));
    expect(oooiDedupKey(12, 'ON')).not.toBe(oooiDedupKey(12, 'IN'));
  });
});

describe('positionReportDedupKey', () => {
  it('builds the frozen formula, keyed on flight and window', () => {
    expect(positionReportDedupKey(12, 1)).toBe('position-report:flight:12:1');
    expect(positionReportDedupKey(12, 7)).toBe('position-report:flight:12:7');
  });

  it('never collides across flights or windows', () => {
    expect(positionReportDedupKey(1, 1)).not.toBe(positionReportDedupKey(2, 1));
    expect(positionReportDedupKey(12, 1)).not.toBe(positionReportDedupKey(12, 2));
  });
});

describe('oooiEstimatedReason', () => {
  it('is total, with the frozen wording for all four events', () => {
    expect(oooiEstimatedReason('OUT')).toBe('NO GROUND SESSION, TIME TAKEN AT TAKEOFF');
    expect(oooiEstimatedReason('ON')).toBe('NO TOUCHDOWN DETECTED, TIME TAKEN AT FLIGHT END');
    expect(oooiEstimatedReason('OFF')).toBe('TIME APPROXIMATE');
    expect(oooiEstimatedReason('IN')).toBe('TIME APPROXIMATE');
  });
});

describe('hhmmz', () => {
  it('renders midnight', () => {
    expect(hhmmz('2026-09-16T00:00:00.000Z')).toBe('0000Z');
  });

  it('zero-pads a value under ten', () => {
    expect(hhmmz('2026-09-16T05:03:00.000Z')).toBe('0503Z');
  });

  it('falls back to dashes for an unparseable string', () => {
    expect(hhmmz('not a date')).toBe('----Z');
  });
});

describe('buildOooiBody', () => {
  it('renders OUT with a known stand and destination', () => {
    expect(buildOooiBody(baseOooiInput())).toBe(
      'OUT KSBA 1432Z\nACFT Airbus A320neo STAND A4 DEST KLAX',
    );
  });

  it('omits STAND and DEST when neither is known', () => {
    expect(buildOooiBody(baseOooiInput({ stand: null, destinationIdent: null }))).toBe(
      'OUT KSBA 1432Z\nACFT Airbus A320neo',
    );
  });

  it('renders ---- for an unresolved airport and appends the OUT estimated reason', () => {
    const body = buildOooiBody(baseOooiInput({
      airportIcao: null, stand: null, destinationIdent: null, estimated: true,
    }));
    expect(body).toBe(
      'OUT ---- 1432Z\nACFT Airbus A320neo\nOUT TIME ESTIMATED - NO GROUND SESSION, TIME TAKEN AT TAKEOFF',
    );
  });

  it('appends the ON estimated reason for a fallback ON', () => {
    const body = buildOooiBody(baseOooiInput({ event: 'ON', stand: null, estimated: true }));
    expect(body.split('\n')).toHaveLength(3);
    expect(body.split('\n')[2]).toBe('ON TIME ESTIMATED - NO TOUCHDOWN DETECTED, TIME TAKEN AT FLIGHT END');
  });

  it('renders IN with a destination and no stand', () => {
    const body = buildOooiBody(baseOooiInput({
      event: 'IN', at: '2026-09-16T15:19:00.000Z', airportIcao: 'KLAX', stand: null,
    }));
    expect(body).toBe('IN KLAX 1519Z\nACFT Airbus A320neo DEST KLAX');
  });

  it('renders UNKNOWN for a null, empty or blank aircraft', () => {
    for (const aircraft of [null, '', '   ']) {
      expect(buildOooiBody(baseOooiInput({ aircraft, stand: null, destinationIdent: null }))).toBe(
        'OUT KSBA 1432Z\nACFT UNKNOWN',
      );
    }
  });

  it('never appends a third line when not estimated', () => {
    expect(buildOooiBody(baseOooiInput({ estimated: false })).split('\n')).toHaveLength(2);
  });

  it('falls back to UNKNOWN for a missing aircraft', () => {
    const body = buildOooiBody(baseOooiInput({ aircraft: null, stand: null, destinationIdent: null }));
    expect(body.split('\n')[1]).toBe('ACFT UNKNOWN');
  });
});

describe('buildOooiPayload', () => {
  it('is the straight field mapping, v=1', () => {
    expect(buildOooiPayload(baseOooiInput())).toEqual({
      v: 1,
      event: 'OUT',
      at: '2026-09-16T14:32:07.000Z',
      airport_icao: 'KSBA',
      stand: 'A4',
      estimated: false,
      planned_leg_id: 34,
    });
  });

  it('carries nulls through for an unresolved, unlinked, estimated event', () => {
    const payload = buildOooiPayload(baseOooiInput({
      airportIcao: null, stand: null, destinationIdent: null, plannedLegId: null, estimated: true,
    }));
    expect(payload.airport_icao).toBeNull();
    expect(payload.stand).toBeNull();
    expect(payload.planned_leg_id).toBeNull();
    expect(payload.estimated).toBe(true);
  });
});

describe('buildOooiMessage', () => {
  it('builds the whole row, flight-scoped with no planned_leg_id column set', () => {
    const msg = buildOooiMessage(baseOooiInput());
    expect(msg.flight_id).toBe(12);
    expect(msg.planned_leg_id).toBeUndefined();
    expect(msg.direction).toBe('downlink');
    expect(msg.category).toBe('oooi');
    expect(msg.label).toBe('OUT');
    expect(msg.dedup_key).toBe('oooi:flight:12:OUT');
    expect(msg.sent_at).toBe('2026-09-16T14:32:07.000Z');
    expect(msg.body).toBe(buildOooiBody(baseOooiInput()));
    expect(JSON.parse(msg.payload_json as string)).toEqual(buildOooiPayload(baseOooiInput()));
  });

  it('labels and keys each event with its own word', () => {
    for (const event of ['OUT', 'OFF', 'ON', 'IN'] as const) {
      const msg = buildOooiMessage(baseOooiInput({ event }));
      expect(msg.label).toBe(event);
      expect(msg.dedup_key).toBe(`oooi:flight:12:${event}`);
    }
  });
});

describe('formatLatLon', () => {
  it('renders the sample position', () => {
    expect(formatLatLon(34.426201, -119.841507)).toBe('N3425.6 W11950.5');
  });

  it('renders a negative latitude near zero as S, not N', () => {
    expect(formatLatLon(-0.0004, 0)).toBe('S0000.0 E00000.0');
  });

  it('carries longitude minutes past the antimeridian rather than special-casing it', () => {
    expect(formatLatLon(0, 179.9999)).toBe('N0000.0 E18000.0');
  });

  it('carries when minutes round to 60', () => {
    expect(formatLatLon(10.9995, 0)).toBe('N1100.0 E00000.0');
  });

  it('renders exactly 0 and -0 the same, as N/E', () => {
    expect(formatLatLon(0, 0)).toBe('N0000.0 E00000.0');
    expect(formatLatLon(-0, -0)).toBe('N0000.0 E00000.0');
  });
});

describe('estimateEnrouteSec', () => {
  it('MIN_ETA_GROUND_SPEED_KTS is 30', () => {
    expect(MIN_ETA_GROUND_SPEED_KTS).toBe(30);
  });

  it('computes seconds to destination at a normal cruise speed', () => {
    expect(estimateEnrouteSec(100, 200)).toBe(1800); // 0.5 h
  });

  it('is null strictly below the ground-speed floor', () => {
    expect(estimateEnrouteSec(100, 29.999)).toBeNull();
    expect(estimateEnrouteSec(100, 0)).toBeNull();
  });

  it('is null for a non-finite ground speed', () => {
    expect(estimateEnrouteSec(100, NaN)).toBeNull();
    expect(estimateEnrouteSec(100, Infinity)).toBeNull();
  });

  it('is null for a negative or non-finite remaining distance', () => {
    expect(estimateEnrouteSec(-1, 200)).toBeNull();
    expect(estimateEnrouteSec(NaN, 200)).toBeNull();
  });
});

describe('buildPositionReportBody', () => {
  it('renders the normal five-line body', () => {
    const body = buildPositionReportBody(basePositionReportInput());
    expect(body).toBe([
      'POSITION REPORT',
      'N3425.6 W11950.5 1432Z',
      'FL330 GS 200 HDG 098',
      'NEXT RZS DEST KLAX 100.0 NM',
      'ETE 0030 ETA 1502Z',
    ].join('\n'));
  });

  it('renders ETE ---- ETA ----Z at zero ground speed, matching a below-transition altitude', () => {
    const body = buildPositionReportBody(basePositionReportInput({
      lat: 35.0, lon: -120.0, altitudeFt: 900, groundSpeedKnots: 0, headingDeg: 0,
      nextWaypointIdent: 'WPT', destinationIdent: 'KSBA', remainingDistanceNm: 0,
    }));
    expect(body).toBe([
      'POSITION REPORT',
      'N3500.0 W12000.0 1432Z',
      '900FT GS 0 HDG 000',
      'NEXT WPT DEST KSBA 0.0 NM',
      'ETE ---- ETA ----Z',
    ].join('\n'));
  });
});

describe('buildPositionReportPayload', () => {
  it('is the straight field mapping, with the derived ETE/ETA pair', () => {
    const payload = buildPositionReportPayload(basePositionReportInput());
    expect(payload).toEqual({
      v: 1,
      at: '2026-09-16T14:32:07.000Z',
      window: 1,
      lat: 34.426201,
      lon: -119.841507,
      altitude_ft: 33000,
      groundspeed_kts: 200,
      heading_deg: 98,
      next_waypoint: 'RZS',
      destination: 'KLAX',
      remaining_nm: 100,
      ete_sec: 1800,
      eta: '2026-09-16T15:02:07.000Z',
      planned_leg_id: 34,
    });
  });

  it('leaves ete_sec and eta null together when no ETA can be estimated', () => {
    const payload = buildPositionReportPayload(basePositionReportInput({ groundSpeedKnots: 0 }));
    expect(payload.ete_sec).toBeNull();
    expect(payload.eta).toBeNull();
  });
});

describe('buildPositionReportMessage', () => {
  it('builds the whole row, flight-scoped with no planned_leg_id column set', () => {
    const msg = buildPositionReportMessage(basePositionReportInput());
    expect(msg.flight_id).toBe(12);
    expect(msg.planned_leg_id).toBeUndefined();
    expect(msg.direction).toBe('downlink');
    expect(msg.category).toBe('position-report');
    expect(msg.label).toBe(POSITION_REPORT_LABEL);
    expect(msg.dedup_key).toBe('position-report:flight:12:1');
    expect(msg.sent_at).toBe('2026-09-16T14:32:07.000Z');
    expect(msg.body).toBe(buildPositionReportBody(basePositionReportInput()));
    expect(JSON.parse(msg.payload_json as string)).toEqual(buildPositionReportPayload(basePositionReportInput()));
  });
});

describe('parsePositionReportIntervalMs', () => {
  it('DEFAULT_POSITION_REPORT_INTERVAL_MIN is 10, MIN_POSITION_REPORT_INTERVAL_MIN is 0.5', () => {
    expect(DEFAULT_POSITION_REPORT_INTERVAL_MIN).toBe(10);
    expect(MIN_POSITION_REPORT_INTERVAL_MIN).toBe(0.5);
  });

  it('defaults to 600000 ms when unset, empty, or blank', () => {
    expect(parsePositionReportIntervalMs(undefined)).toBe(600_000);
    expect(parsePositionReportIntervalMs('')).toBe(600_000);
    expect(parsePositionReportIntervalMs('  ')).toBe(600_000);
  });

  it('parses a plain number of minutes to milliseconds', () => {
    expect(parsePositionReportIntervalMs('10')).toBe(600_000);
    expect(parsePositionReportIntervalMs('2.5')).toBe(150_000);
  });

  it('0 disables reporting', () => {
    expect(parsePositionReportIntervalMs('0')).toBe(0);
  });

  it('defaults on a negative value rather than treating it as an opt-out', () => {
    expect(parsePositionReportIntervalMs('-5')).toBe(600_000);
  });

  it('floors a small positive value at 30 seconds', () => {
    expect(parsePositionReportIntervalMs('0.1')).toBe(30_000);
  });

  it('defaults on an unparseable value', () => {
    expect(parsePositionReportIntervalMs('abc')).toBe(600_000);
  });
});

describe('PDC constants and dedup keys', () => {
  it('are the exact wire-contract strings', () => {
    expect(NO_FLIGHT_PLAN_MESSAGE).toBe('NO FLIGHT PLAN ON FILE');
    expect(CLEARANCE_REQUEST_LABEL).toBe('REQUEST CLEARANCE');
    expect(CLEARANCE_LABEL).toBe('PDC');
    expect(DEFAULT_INITIAL_ALTITUDE_FT).toBe(5000);
  });

  it('build the two literal formulas, keyed on the planned leg id', () => {
    expect(clearanceRequestDedupKey(42)).toBe('clearance-req:leg:42');
    expect(clearanceDedupKey(42)).toBe('clearance:leg:42');
  });

  it('gives a different leg its own keys, and the request and reply never collide', () => {
    expect(clearanceRequestDedupKey(1)).not.toBe(clearanceRequestDedupKey(2));
    expect(clearanceDedupKey(1)).not.toBe(clearanceDedupKey(2));
    expect(clearanceRequestDedupKey(42)).not.toBe(clearanceDedupKey(42));
  });
});

describe('deriveInitialAltitudeFt', () => {
  it('defaults to 5000 when cruise altitude is unknown', () => {
    expect(deriveInitialAltitudeFt(null)).toBe(DEFAULT_INITIAL_ALTITUDE_FT);
  });

  it('uses the cruise altitude when it is below the default', () => {
    expect(deriveInitialAltitudeFt(3500)).toBe(3500);
    expect(deriveInitialAltitudeFt(0)).toBe(0);
  });

  it('caps at 5000 when the cruise altitude is above it', () => {
    expect(deriveInitialAltitudeFt(28000)).toBe(DEFAULT_INITIAL_ALTITUDE_FT);
  });

  it('a cruise altitude exactly at 5000 stays 5000', () => {
    expect(deriveInitialAltitudeFt(5000)).toBe(5000);
  });
});

describe('squawkForLeg', () => {
  const RESERVED = new Set(['0000', '7500', '7600', '7700']);
  const SAMPLE_LEG_IDS = [1, 2, 3, 7, 42, 100, 4096, 999999];

  it('is deterministic: the same leg id always yields the same code', () => {
    for (const legId of SAMPLE_LEG_IDS) {
      expect(squawkForLeg(legId)).toBe(squawkForLeg(legId));
    }
  });

  it('is always four characters, each an octal digit 0-7', () => {
    for (const legId of SAMPLE_LEG_IDS) {
      expect(squawkForLeg(legId)).toMatch(/^[0-7]{4}$/);
    }
  });

  it('never returns a reserved code', () => {
    for (const legId of SAMPLE_LEG_IDS) {
      expect(RESERVED.has(squawkForLeg(legId))).toBe(false);
    }
  });

  it('is not a constant function: different legs get different codes', () => {
    const codes = new Set(SAMPLE_LEG_IDS.map(squawkForLeg));
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe('buildClearanceDetails', () => {
  it('maps the dispatch payload fields, clamping the route the same way the load sheet does', () => {
    const details = buildClearanceDetails(basePayload(), 42);
    expect(details).toEqual<ClearanceDetails>({
      v: 1,
      departure_icao: 'UHPP',
      destination_icao: 'UHSS',
      route: basePayload().route,
      initial_altitude_ft: DEFAULT_INITIAL_ALTITUDE_FT,
      squawk: squawkForLeg(42),
    });
  });

  it('carries a null origin, destination or route through rather than substituting a fallback', () => {
    const details = buildClearanceDetails(basePayload({ origin: null, destination: null, route: null }), 1);
    expect(details.departure_icao).toBeNull();
    expect(details.destination_icao).toBeNull();
    expect(details.route).toBe('NIL');
  });

  it('gives the same leg the same clearance twice, and a different leg a different squawk', () => {
    const a = buildClearanceDetails(basePayload(), 5);
    const b = buildClearanceDetails(basePayload(), 5);
    expect(a).toEqual(b);
    const c = buildClearanceDetails(basePayload(), 6);
    expect(a.squawk).not.toBe(c.squawk);
  });
});

describe('buildClearanceBody', () => {
  it('renders the fixed six-line body with the real captured OFP', () => {
    const payload = realDispatchPayload();
    const details = buildClearanceDetails(payload, 42);
    const body = buildClearanceBody(details);
    expect(body).toBe([
      'PDC',
      'UHPP TO UHSS',
      `CLEARED VIA ${payload.route}`,
      'CLIMB AND MAINTAIN 5000FT',
      `SQUAWK ${details.squawk}`,
      'SIMULATED CLEARANCE - NOT FOR REAL WORLD USE',
    ].join('\n'));
    expect(body.split('\n')).toHaveLength(6);
  });

  it('falls back to ???? for a missing departure or destination and NIL for a missing route', () => {
    const details = buildClearanceDetails(basePayload({ origin: null, destination: null, route: null }), 1);
    const body = buildClearanceBody(details);
    expect(body.split('\n')[1]).toBe('???? TO ????');
    expect(body.split('\n')[2]).toBe('CLEARED VIA NIL');
  });

  it('always carries the simulation disclaimer as the last line', () => {
    const body = buildClearanceBody(buildClearanceDetails(basePayload(), 1));
    expect(body.split('\n').at(-1)).toBe('SIMULATED CLEARANCE - NOT FOR REAL WORLD USE');
  });
});

describe('parseClearancePayload', () => {
  it('round-trips exactly what buildClearanceDetails wrote', () => {
    const details = buildClearanceDetails(basePayload(), 42);
    expect(parseClearancePayload(JSON.stringify(details))).toEqual(details);
  });

  it('null and empty string both mean "nothing stored"', () => {
    expect(parseClearancePayload(null)).toBeNull();
    expect(parseClearancePayload('')).toBeNull();
  });

  it('unparseable JSON, a non-object, an array, and the wrong version all fail total', () => {
    expect(parseClearancePayload('not json')).toBeNull();
    expect(parseClearancePayload('"a string"')).toBeNull();
    expect(parseClearancePayload('[1,2,3]')).toBeNull();
    expect(parseClearancePayload(JSON.stringify({ ...buildClearanceDetails(basePayload(), 1), v: 2 }))).toBeNull();
  });

  it('falls back field by field rather than failing the whole parse', () => {
    const parsed = parseClearancePayload(JSON.stringify({
      v: 1, departure_icao: 42, destination_icao: null, route: 7, initial_altitude_ft: 'high', squawk: 9999,
    }));
    expect(parsed).toEqual<ClearanceDetails>({
      v: 1,
      departure_icao: null,
      destination_icao: null,
      route: null,
      initial_altitude_ft: DEFAULT_INITIAL_ALTITUDE_FT,
      squawk: '0000',
    });
  });
});

describe('buildCondensedClearanceMessage', () => {
  // Seven worked examples, reproduced here byte for byte.

  it('A — short route, fits whole (63 chars)', () => {
    const details: ClearanceDetails = {
      v: 1, departure_icao: 'KSFO', destination_icao: 'KLAX',
      route: 'SSTIK3 BSR Q13 RZS KWANG2', initial_altitude_ft: 5000, squawk: '2451',
    };
    const out = buildCondensedClearanceMessage(details);
    expect(out).toBe('PDC KSFO KLAX CLRD SSTIK3 BSR Q13 RZS KWANG2 CLB 5000FT SQ 2451');
    expect(out.length).toBe(63);
  });

  it('B — long route, clipped keeping the first and last fix (127 chars)', () => {
    const details: ClearanceDetails = {
      v: 1, departure_icao: 'EGLL', destination_icao: 'LFPG',
      route:
        'DET2F DET L6 DVR UL9 KONAN UL607 SPI UZ739 PIGOS UN872 LUMEN UM605 TANGO ' +
        'UP600 REVTU UL610 SITET UN862 BIBAX UM728 OKRIX UY111 LORKU RANUX6A',
      initial_altitude_ft: 5000, squawk: '5123',
    };
    const out = buildCondensedClearanceMessage(details);
    expect(out).toBe(
      'PDC EGLL LFPG CLRD DET2F DET L6 DVR UL9 KONAN UL607 SPI UZ739 PIGOS UN872 LUMEN UM605 TANGO UP600 .. RANUX6A CLB 5000FT SQ 5123',
    );
    expect(out.length).toBe(127);
  });

  it('C — route === null (41 chars)', () => {
    const details: ClearanceDetails = {
      v: 1, departure_icao: 'SBGR', destination_icao: 'SBRJ', route: null, initial_altitude_ft: 4000, squawk: '0361',
    };
    const out = buildCondensedClearanceMessage(details);
    expect(out).toBe('PDC SBGR SBRJ CLRD NIL CLB 4000FT SQ 0361');
    expect(out.length).toBe(41);
  });

  it("D — route is the literal 'NIL' clampRoute() emits (41 chars, same as C)", () => {
    const details: ClearanceDetails = {
      v: 1, departure_icao: 'SBGR', destination_icao: 'SBRJ', route: 'NIL', initial_altitude_ft: 4000, squawk: '0361',
    };
    const out = buildCondensedClearanceMessage(details);
    expect(out).toBe('PDC SBGR SBRJ CLRD NIL CLB 4000FT SQ 0361');
    expect(out.length).toBe(41);
  });

  it('E — both ICAOs null, 18000 ft renders as a flight level (40 chars)', () => {
    const details: ClearanceDetails = {
      v: 1, departure_icao: null, destination_icao: null, route: 'DCT', initial_altitude_ft: 18000, squawk: '7401',
    };
    const out = buildCondensedClearanceMessage(details);
    expect(out).toBe('PDC ???? ???? CLRD DCT CLB FL180 SQ 7401');
    expect(out.length).toBe(40);
  });

  it('F — one 400-character token with no whitespace to clip on (128 chars, the cap exactly)', () => {
    const details: ClearanceDetails = {
      v: 1, departure_icao: 'KJFK', destination_icao: 'EGLL', route: 'X'.repeat(400), initial_altitude_ft: 5000, squawk: '1234',
    };
    const out = buildCondensedClearanceMessage(details);
    expect(out).toBe(
      `PDC KJFK EGLL CLRD ${'X'.repeat(88)}.. CLB 5000FT SQ 1234`,
    );
    expect(out.length).toBe(128);
  });

  it("G — a 900-char route at clampRoute()'s own ceiling (127 chars)", () => {
    const route = `${'WAYPT ABCDE FIXES UN123 '.repeat(37).trim().slice(0, 897)}...`;
    const details: ClearanceDetails = {
      v: 1, departure_icao: 'KJFK', destination_icao: 'EGLL', route, initial_altitude_ft: 5000, squawk: '1234',
    };
    const out = buildCondensedClearanceMessage(details);
    expect(out).toBe(
      'PDC KJFK EGLL CLRD WAYPT ABCDE FIXES UN123 WAYPT ABCDE FIXES UN123 WAYPT ABCDE FIXES UN123 WAYPT .. UN123... CLB 5000FT SQ 1234',
    );
    expect(out.length).toBe(127);
  });

  it('never exceeds MAX_ACARS_IN_CHARS (128) for any route length from 0 to 900 tokens, with or without separators', () => {
    expect(MAX_ACARS_IN_CHARS).toBe(128);
    let worst = 0;
    for (let n = 0; n <= 900; n++) {
      for (const sep of [' ', '']) {
        const route = Array.from({ length: n }, (_, i) => `F${i}`).join(sep).slice(0, 900);
        const out = buildCondensedClearanceMessage({
          v: 1, departure_icao: 'AAAA', destination_icao: 'BBBB', route, initial_altitude_ft: 5000, squawk: '7401',
        });
        worst = Math.max(worst, out.length);
        expect(out.length).toBeLessThanOrEqual(MAX_ACARS_IN_CHARS);
      }
    }
    expect(worst).toBe(128);
  });

  it('never exceeds the cap even for a maximally long single-token route with no ICAOs and a null squawk-adjacent field', () => {
    const out = buildCondensedClearanceMessage({
      v: 1, departure_icao: null, destination_icao: null, route: 'Z'.repeat(900), initial_altitude_ft: 18000, squawk: '7700',
    });
    expect(out.length).toBeLessThanOrEqual(MAX_ACARS_IN_CHARS);
  });
});
