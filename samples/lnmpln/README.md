# LNMPLN fixtures

## Layout

    samples/lnmpln/*.lnmpln            real Little Navmap exports
    samples/lnmpln/synthetic/*.lnmpln  hand-built fixtures

**The real files keep their original Little Navmap filenames, verbatim.** Do not
rename or prefix them. Their names are themselves evidence: LNM's default
`VFR <depname> (ICAO) to <destname> (ICAO).lnmpln` is what makes a file picker's
alphabetical order come out as the exact reverse of the route, which is the
defect that `design.md` §9.2 exists to fix. Renaming them would quietly destroy
the fixture that proves the chain-sort works.

This is why the real files sit at the top level rather than under a `real/`
directory, and why the `real-*` prefix suggested during design was rejected:
`samples/lnmpln/*.lnmpln` must keep matching exactly the genuine exports, since
that glob is written into T-002's and T-004's acceptance criteria.

## The real files

All four are Little Navmap 3.0.18 exports.

**The VFR trio** chains into one trip, and is the ordering fixture:

    KSBA -> KMRY   201.2 nm   7500 ft
    KMRY -> KSTS   140.0 nm   2500 ft
    KSTS -> KACV   191.1 nm   3500 ft

Alphabetical filename order is `KSTS->KACV, KMRY->KSTS, KSBA->KMRY` — the reverse
of the route. Importing all three in that order and getting `seq` 1,2,3 in route
order is the sharpest regression test this feature has.

**The KMRY -> KSFO plan** is the richest of the five. It is the first real file
to carry a **published** (non-`CUSTOM`) approach — `DUYET`, type `ILS`, ARINC
`I28L` — the first with a `SID Type=CUSTOMDEPART` (`KMRY28L`, 3.0 nm runway
extension, a form the XSD does not declare), and the first with a `<Departure>`
element at all (`PARKING 112`, heading 112.424). Between them those retire three
gaps that until now only synthesized fixtures covered, and `approach_arinc` /
`sid_type` finally have real evidence behind them.

It also makes the fixture set genuinely ambiguous, on purpose: with
`KMRY -> KSTS` already present, **KMRY has two successors**, so chain-sorting the
whole `VFR*` set correctly returns `AMBIGUOUS_SUCCESSOR` and falls back to upload
order. That is §9.2.1 refusing to guess, demonstrated by real data.

**This is why no test may glob for its inputs.** The chain-sort assertion names
the three files of the KSBA->KACV trip explicitly. A glob would keep compiling
and keep passing while quietly asserting something else every time a file is
added here.

**The IFR plan** (KSFO -> KLAX, FL270) is the procedures fixture. It carries a
full `<Procedures>` block — SID `WESLA5`/28L/`SUSEY`, STAR `IRNMN2`/24R/`BURGL`,
and a `Type=CUSTOM` approach with `CustomDistance`, `CustomAltitude` and
`CustomOffsetAngle`. Two facts from this file explain behaviour in
`src/lnmpln.ts` and `src/flight/legProgress.ts`:

- **`<CustomOffsetAngle>` does not appear anywhere in the official XSD.** The
  schema is not an exhaustive description of what LNM writes, which is why the
  parser tolerates undocumented elements and never validates against the XSD.
- **It quantifies the procedure gap.** Its en-route waypoint list measures
  293.5 nm against a direct great-circle of 293.2 nm — with one waypoint between the airports the
  planned route is essentially a straight line, while the real track curves away
  through the SID and STAR. A planned route drawn under a flown track will
  visibly diverge at both ends, and that is correct, not a rendering bug.

It does not chain with the VFR trio; a batch mixing them falls back on
`NO_UNIQUE_HEAD`, as intended.

## What the real files still do not cover

`synthetic/` has to supply: multiple `<Waypoints>` blocks, **`<Alternates>` of
any kind — no real file has one, and that is now the largest remaining gap**,
XML comments, a missing `Pos/@Alt`, the two-digit `+02` CreationDate offset
form, a UTF-8 BOM, and every rejection path (`bad-*.lnmpln`).

Retired by the KMRY->KSFO file: `<Departure>`, a published approach with an
ARINC identifier, and `SID Type=CUSTOMDEPART`.
See `design.md` §21 for the full table.

## The synthesized fixtures (`synthetic/`)

Built by T-002 to cover the format surface the four real files leave untouched.
Every one of them exists to make a specific rule falsifiable, so **do not "tidy"
one into looking like a normal export** — the deviation is the point.

| File | What it proves |
|---|---|
| `bom.lnmpln` | trap 11: a UTF-8 BOM is stripped, `BOM_STRIPPED` |
| `two-waypoint-blocks-two-alternate-blocks.lnmpln` | trap 4: 2+2 blocks concatenated in document order (4 waypoints, 3 alternates), `MULTIPLE_WAYPOINT_BLOCKS` |
| `alternates-optional-pos.lnmpln` | one alternate with a `Pos` and no `Alt`, one with no `Pos` at all → `ALTERNATE_POSITION_MISSING` |
| `remarks-comment-tag.lnmpln` | trap 2: the XSD's `<Comment>` in Header and Waypoint |
| `remarks-description-after-pos.lnmpln` | traps 2+3: the manual's `<Description>`, placed *after* `<Pos>` |
| `remarks-comment-and-description.lnmpln` | trap 2: both spellings disagree; `<Comment>` wins |
| `snippet-non-airport-endpoints.lnmpln` | trap 6: `isSnippet`, both endpoint warnings |
| `waypoint-pos-without-alt.lnmpln` | trap 8: a `Pos` with no `Alt`, and an `Alt` that is not a number |
| `cruising-alt-disagree.lnmpln` | trap 9: `CruisingAlt` 8000 vs `CruisingAltF` 8500.75 — the parser must report 8500.75 |
| `cruising-alt-f-missing.lnmpln` | trap 9: `CRUISE_ALT_F_MISSING` fallback |
| `creation-date-two-digit-offset.lnmpln` | trap 10: `2020-09-11T18:05:15+02` → a valid ISO instant |
| `creation-date-no-offset.lnmpln` | trap 10: `CREATION_DATE_NO_OFFSET` |
| `xml-comments-nested-unbalanced.lnmpln` | trap 7: a comment containing a second unclosed `<!--`, around the custom SID. Parses; the SID inside it is correctly absent |
| `departure-parking.lnmpln` | trap 12: `<Departure>` with `Pos`/`Start`/`Type`/`Heading`, plus an `<AircraftPerformance>` that *does* carry `<FilePath>` |
| `approach-published-arinc-suffix.lnmpln` | a published (non-`CUSTOM`) approach with `ARINC`, `Suffix`, `TransitionType` |
| `sid-customdepart.lnmpln` | the manual's `SID Type=CUSTOMDEPART` + `CustomDistance`, which the XSD does not declare |
| `unknown-elements.lnmpln` | §5.4e: **eleven** elements no schema version declares, one planted in every container the parser opens — including `Procedures/MissedApproach`, the case that proved `<Procedures>` was going unscanned. Must import, with one `UNKNOWN_ELEMENT` warning naming the first ten and counting the rest — never a rejection |
| `chain-roundtrip-1-KAAA-to-KBBB.lnmpln`, `chain-roundtrip-2-KBBB-to-KAAA.lnmpln` | §9.2.1: a round trip has zero heads → `NO_UNIQUE_HEAD`, upload order kept |

### The rejection fixtures

One per `LnmplnRejectCode`. Each must produce one line and a non-zero exit —
never a stack trace, never a partial object.

| File | Code |
|---|---|
| `bad-empty.lnmpln` | `EMPTY_FILE` |
| `bad-truncated-comment.lnmpln` | `NOT_XML` |
| `bad-not-xml.lnmpln` | `NO_FLIGHTPLAN` — plain prose. fast-xml-parser is lenient enough that it does not throw, so the semantic check is what catches it; that is the §5.2 trap-7 fallback check rejecting it as designed, not a mis-mapping |
| `bad-no-flightplan.lnmpln` | `NO_FLIGHTPLAN` |
| `bad-zero-waypoints.lnmpln`, `bad-one-waypoint.lnmpln` | `TOO_FEW_WAYPOINTS` |
| `bad-comment-swallowed-waypoints.lnmpln` | `TOO_FEW_WAYPOINTS` — an unbalanced comment whose stray `</SID>` reparents the rest of the tree. The observable symptom of a swallowed block |
| `bad-missing-ident.lnmpln` | `MISSING_IDENT` |
| `bad-missing-pos.lnmpln` | `MISSING_POSITION` |
| `bad-lat-91.lnmpln`, `bad-lon-minus-181.lnmpln` | `BAD_COORDINATE` |

### The scan is total, and that is the point

`UNKNOWN_ELEMENT` scans **every** element the parser opens as a container, not a
list of the interesting ones: `LittleNavmap`, `Flightplan`, `Header`, `SimData`,
`NavData`, `AircraftPerformance`, `Departure`, `Procedures`, `SID`, `STAR`,
`Approach`, each `Waypoints` and `Alternates` block, each `Waypoint` and
`Alternate`, and every `Pos`. Elements read as *text* (`<Ident>`, `<CruisingAlt>`,
`<Name>`, …) are not scanned; if one ever grows children it stops being a string
and reads back as null, which is visible rather than silent.

Keep it that way. A container holding a fixed set of known children is exactly
where Little Navmap adds the next thing, and `<CustomOffsetAngle>` was caught only
because a human happened to grep the XSD. This mechanism is what replaces that
human, and it is worth nothing on the containers it skips.

### Running them

    npx ts-node src/inspect-lnmpln.ts samples/lnmpln/*.lnmpln            # the real four
    npx ts-node src/inspect-lnmpln.ts 'samples/lnmpln/VFR*.lnmpln'       # chains: KSBA→KMRY→KSTS→KACV
    npx ts-node src/inspect-lnmpln.ts 'samples/lnmpln/synthetic/bad-*.lnmpln'

Note that the all-four glob reports `NO_UNIQUE_HEAD`, not `CHAINED`: the IFR plan
belongs to a different trip from the VFR trio, so the batch has two heads and
falls back, exactly as Amendment B describes. The chain-sort demonstration in
design.md §9.2.3 predates that file and is stated against the VFR trio.
