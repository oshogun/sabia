# Navdata

Navdata puts navigation data — airports, VORs/NDBs, fixes, airways,
runways, and the SID/STAR/approach legs a filed plan refers to — under the
flown track on the maps. It can come from two sources, and the map shows one
at a time:

- **Simulator (MCDU).** The **MCDU/CDU Windows client** (its own repository,
  `sabia_mcdu`) extracts it from the simulator over SimConnect and is the
  source of truth; this server keeps a **replica**, `navdata.db`, filled in as
  the client fetches detail.
- **Little Navmap import.** You give the server a Little Navmap (atools)
  database file and it builds its own complete replica from it,
  `navdata.db.lnm`. The import never changes `navdata.db`. See
  [Little Navmap import](#little-navmap-import).

You pick the source in **Settings → Navigation data**. With no replica for the
selected source, everything else works exactly as before.

## What you see

- **Navdata panel** on the flight, trip, live and journey maps (five
  checkboxes: airports, navaids, waypoints, airways, runways). The panel only
  appears once the server has a replica for the source that is shown, and every
  checkbox starts off — nothing is fetched until you turn one on. Layers draw
  *beneath* the flown track.
- **Dataset line.** Under the panel title, one line names the data shown:
  `Little Navmap · <label>` for an import (for example `Little Navmap · Navigraph
  AIRAC 2610 · valid 2026-10-01 – 2026-10-28`), or the simulator label
  (`Simulator (<app> <version>)`). When the dataset's validity has ended, a
  second line warns **Expired AIRAC — not for navigation**.
- **Zoom gates.** A layer below its zoom is greyed with the reason and returns no
  features (the server lists it under `gated`): airports 6, airways 7, navaids 8, waypoints 9, runways 12.
- **Coverage notes.** Simulator data: airports are complete worldwide; navaids
  and fixes are only known where the simulator has been asked, so the panel says
  *"Not fetched here yet"* (never looked) versus *"None here"* (looked, found
  nothing), and *"Partly fetched here (n%)"* in between. A Little Navmap import
  is complete everywhere, so for it only *"None here"* can appear, never *"Not
  fetched here yet"* or *"Partly fetched here"*. Too many results say *"zoom in
  for more"*.
- **Fetch detail** (simulator data only). An airport known only by position
  shows a *Fetch detail* button (for up to the five nearest such airports, while
  the Airports layer is on); it asks the sidecar to fetch runways and procedures
  the next time it polls. Only offered for real airport idents. It is hidden
  while Little Navmap data is shown, because every imported airport already has
  its detail.
- **Expanded planned routes.** For a plan with a SID/STAR/approach or airways,
  the planned line is replaced by the expanded chains when the replica can
  resolve them. Whatever cannot be resolved is explained in the route tooltip;
  an empty answer renders exactly as before (the planned line and the existing
  "planned route excludes SID/STAR/approach legs" note).
- **Computed procedures.** A Little Navmap *custom* departure or approach is not
  a simulator procedure, so it is drawn from the runway instead: a dashed line
  labelled *computed departure* / *computed straight-in*, from the runway's
  landing threshold outward (or back) by the plan's custom distance. Without
  runway detail for that airport the note says so and offers *Fetch detail*
  (simulator data only).
- **Settings → Navigation data.** A *Source* choice between *Simulator (MCDU)*
  and *Little Navmap import* (disabled until an import exists), each with its
  dataset label. It warns *"Expired — not for navigation"* for an expired
  import, and *"Little Navmap data is selected but unavailable, so the map is
  showing simulator data."* when the selected import file is missing. While
  Little Navmap data is shown it notes that the simulator keeps syncing in the
  background.
- **Settings → Import Little Navmap data.** Upload a `.sqlite` file, or pick one
  already in the server's import folder, then follow the import's progress by
  stage, with a *Cancel* button. A browser upload is cancelled if you leave the
  page before it finishes; an import from the server folder keeps running.

## Data provenance and licensing

Neither source is shipped by this project. Simulator data is whatever the
simulator's facility database serves; on an install with Navigraph's navdata in
the Community folder, that is Navigraph-derived. A Little Navmap database is a
file the user built or obtained themselves (Navigraph's, or one Little Navmap
compiled from the simulator's scenery). This project does not distribute or
fetch Navigraph data. Consequently:

- `navdata.db`, `navdata.db.lnm` and any Little Navmap `.sqlite` file must
  **never** be committed, baked into a Docker image, or used as a test fixture.
  They are git-ignored (`navdata.db*`, and `*.sqlite` with its
  `-journal`/`-wal`/`-shm` files in any letter case) and docker-ignored
  (`navdata.db`, `navdata.db-wal`, `navdata.db-shm`, `navdata.db.incoming-*`,
  `navdata.db.lnm*`, `navdata/`, and `**/*.sqlite` with its side files in any
  letter case), and live in a mounted directory.
- Tests use synthetic idents and coordinates only.

## Little Navmap import

### Supported files

An atools database as written by Little Navmap — for example
`little_navmap_navigraph.sqlite` or `little_navmap_msfs.sqlite`. Its
`metadata.data_source` decides how it is converted:

| `data_source` | Label shown | Notes |
|---|---|---|
| `NAVIGRAPH` | `Navigraph AIRAC <cycle>` | Navigraph's database. Covers the airports in Navigraph's data only (about 14,000), not small VFR fields. |
| `MSFS` | `MSFS 2020 scenery[ with Navigraph update], compiled <date>` | Built by Little Navmap from the simulator's scenery; carries every airport the simulator has (about 41,850 in a tested file). |
| `MSFS24` | `MSFS 2024 scenery…` | Converted with the same rules as `MSFS`. |

Any other `data_source`, a file that is not an atools database, or one with no
airports is refused. Converted: airports, runways, airport frequencies,
VORs/NDBs/ILS, waypoints (including VFR and RNAV points), airways, and
SID/STAR/approach procedures with their transitions and legs. Not converted
yet: airspace boundaries, MORA, airport MSA, holdings, and marker beacons (the
frozen replica schema has no table for them); GLS approaches are dropped.

### Running an import

- **Upload** from Settings: one file, at most 2 GiB. The browser sends it as
  multipart field `lnmDatabase`; the server spools it into the navdata directory
  (never the OS temp directory), then builds from it.
- **From the server's import folder:** put the file in the directory that holds
  `navdata.db` (`dirname(NAVDATA_DB_PATH)` — `./navdata` next to
  `docker-compose.yml` in Docker, `<root>/navdata` on an installer-managed
  instance, the server's working directory — beside `flights.db` — on a source
  install with `NAVDATA_DB_PATH` unset) and pick it in Settings. Only regular files whose name ends in
  `.sqlite` (any case) are listed; symlinks and names starting with `.` are not.
  This is the practical route for large files.
- One import runs at a time. Before starting, the server refuses with
  `507` if the import directory has less free space than the upload plus
  1.25 GiB, or if less than 1 GiB of memory is available.
- The build runs in a **worker thread** (heap capped at 1,024 MiB), so the
  server keeps answering requests. It writes a new file beside
  `navdata.db.lnm`, verifies it, and swaps it in only when everything has
  succeeded; a failed or cancelled import leaves the previous import in place.
  Measured on an 847 MB MSFS file: about 60–80 s, peak server memory about
  0.8 GiB above idle, a replica of about 400 MB.
- An import does **not** switch the source; select *Little Navmap import* in
  Settings afterwards.

### Validity and expiry

The dataset's validity comes from the file's own `valid_through` range, or else
from the AIRAC calendar for its cycle (28-day periods counted from AIRAC 2001,
2020-01-02). It is shown as `valid <from> – <through>`. The dataset counts as
**expired** from 00:00 UTC on the day after `<through>`. A file built from the
simulator's scenery has no cycle, so it shows its compile date and never
expires.

### While Little Navmap data is shown

- Every browser navdata read — features, status, airport detail, route geometry
  — uses `navdata.db.lnm`.
- The MCDU sidecar keeps syncing into `navdata.db` in the background, but
  `GET /api/navdata/demand` answers an empty want list, so the simulator is not
  asked to fetch anything. Queued manual requests are kept, not deleted, and are
  served again when the simulator source is selected.
- `POST /api/navdata/request` never queues: the imported dataset is treated as
  complete, so it answers `already-present` or `known-absent`, and `force` is
  ignored.
- If the selected import file is missing or unreadable, the server shows
  simulator data instead (`sourceFallback: 'lnm-unavailable'`) and logs one
  warning at startup; the stored choice is left as it is.

## Architecture

```
MSFS ──SimConnect──▶ MCDU sidecar (source of truth, own SQLite)
                         │  x-ingest-token
                         ├─ POST /api/navdata/snapshot   whole store, gzipped NDJSON
                         ├─ POST /api/navdata/rows       incremental JSON batches
                         ├─ GET  /api/navdata/demand     what the server wants fetched
                         └─ POST /api/navdata/state      sidecar health, fire-and-forget
                                       ▼
                             navdata.db (simulator replica) ─┐
                                                             ├─ the selected source ◀── session-gated queries ── web client
Little Navmap .sqlite ──▶ worker-thread import ──▶ navdata.db.lnm ─┘
   (upload, or a file in the import folder; session-gated, /api/navdata/lnm-import)
```

- **Replicas, not databases of record.** `navdata.db` can be deleted at any time;
  the next snapshot from the sidecar rebuilds it. `navdata.db.lnm` is rebuilt
  only by importing the Little Navmap file again. Both are separate SQLite files
  and are never opened by `flights.db` code paths. Sidecar routes always read
  and write `navdata.db`, whichever source is selected; browser routes read the
  selected one.
- **Epochs.** Every bulk extraction has an opaque `snapshotId`. A snapshot always
  wins and replaces the replica wholesale, regardless of revision numbers; a
  revision counter is only meaningful *within* one epoch. An incremental batch
  carrying a different epoch is refused (`NAVDATA_SNAPSHOT_MISMATCH`), which is
  the sidecar's signal to send a snapshot. A snapshot re-sent with the epoch the
  server already holds is a normal replace.
- **Schema.** 13 STRICT tables, `NAVDATA_SCHEMA_VERSION = 2` (v2 added
  `primary_threshold_m`/`secondary_threshold_m` on `nav_runway`). The schema is
  duplicated between the two repositories and shipped here as a TypeScript
  string (`src/navdata/schema.ts`). A peer or a batch with a different schema
  version is refused (`NAVDATA_SCHEMA_UNSUPPORTED`); a replica *file* of another
  version is treated as absent (`navdata.db` is replaced by the next snapshot,
  `navdata.db.lnm` by the next import). The Little Navmap replica uses the same
  13 tables plus one of its own, `lnm_dataset` (one row: source file, data
  source, cycle, validity, label), which is outside the frozen schema and never
  sent over the sidecar wire. Its `nav_meta` row carries `simAppName` `Little
  Navmap`, the dataset label as `simAppVersion`, and a `snapshotId` of the form
  `lnm-<provider>-<time>-<hex>`.
- **Merge rules (all tables).** A row is found by its key only. An incoming NULL
  or missing column keeps the stored value; an incoming value — including `0` —
  replaces it. An identical merged row writes nothing and does not advance the
  revision. `first_seen_at` on `nav_absent` never moves forward. `NULL` means "this
  fetch carried no value"; `0` means "the simulator reported zero" — never
  substitute one for the other. Writes are `INSERT … ON CONFLICT DO UPDATE`, never
  `INSERT OR REPLACE` (whose delete would cascade away an airport's runways and
  procedures).
- **Absence.** "The simulator does not have this facility" arrives as an
  `absent` row in the normal stream and stops the server asking for it again
  (within the same epoch).

## Sidecar endpoints (ingest token)

Authenticated by the `x-ingest-token` header only, checked per route. They are
mounted above the session middleware, so a request never touches the session
store, and a browser session cookie is rejected here. They are **not** in
`INGEST_SCOPED_ROUTES`: an ingest token still cannot reach any session route.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/navdata/snapshot` | Multipart upload, one part named `navdataSnapshot`: a gzipped NDJSON file (header line, `{"t":"<table>","r":{…}}` row lines in parent-before-child order, footer line with row counts). Max 64 MiB compressed. The upload is spooled to a per-process private temporary directory, then streamed into a temporary replica file beside `navdata.db`, verified (schema version, per-table counts against the footer, column check), then swapped in atomically. Answers a `SnapshotAck` with the per-table counts actually written. |
| POST | `/api/navdata/rows` | JSON `IncrementalBatch` (`snapshotId`, `fromRev`, `toRev`, `rows`, `more`). Up to 2000 rows is the sender's target; a batch of MORE than 2000 rows is accepted only when every row shares one `rev` (a whole transaction, for example one airport's detail), a mixed-`rev` batch over 2000 is refused, and 20 000 rows is a hard ceiling for any batch. The byte bound is 4 MiB. This one path is exempt from the global 100 kB JSON limit (a path-scoped `express.json({ limit: '4mb' })` sits above the global parser; every other path still rejects at 100 kB). The whole batch is one transaction. |
| GET | `/api/navdata/demand` | What the sidecar should fetch: `airports` (idents wanted in full detail) and `waypoints` (fixes wanted with their airway routes), at most 50 entries per poll (`cap`, echoed), `more: true` when truncated. Derived from manual requests, then active-trip legs, then planned legs, minus what the replica already holds. `USER`-type waypoints are never demanded. Each `waypoints` entry is `{ ident, region?, kind }` with `kind` `W` (a fix), `V` (a VOR) or `N` (an NDB), taken from the plan's waypoint type; all fixes and airports are listed ahead of every VOR/NDB before the cap applies, so navaids never starve fixes. A fix want is satisfied only by a fetched or absent fix row (or an absence row of kind W); a VOR/NDB want only by a fetched or absent navaid row (or an absence row of that kind); position-only candidate rows for an ambiguous ident never satisfy it. Optional query parameters `skipAirports` and `skipWaypoints` are comma-separated idents (percent-encoded commas are fine, decoded before the split; at most 200 distinct, 1-8 characters of A-Z0-9 after trimming and uppercasing; a malformed list is a `400 NAVDATA_BAD_BATCH`; empty items are ignored, and an ident is skipped whatever its kind): the sidecar reports parked idents there and the server excludes them before the cap, keeping no state. A skipped manual request is neither listed nor deleted. While Little Navmap data is shown, the answer is always an empty want list (`airports: []`, `waypoints: []`, `more: false`) and queued manual requests are left in place; a malformed skip list is still a `400`. |
| POST | `/api/navdata/state` | Sidecar health (`nav.off`/`nav.unavailable`/`nav.bulk`/`nav.ready`/`nav.error`). `204` on success (`400 NAVDATA_BAD_BATCH` if the body is not a state report; a failure while storing it is swallowed into `204`, since the sidecar never retries). Kept in memory only; `/status` reports it as `sidecar: null` when the newest report is older than 15 minutes. |

Error bodies are `{ "ok": false, "code", "message" }` (a bad or missing token is the ingest router's usual `401 { "error": … }`):

| HTTP | Code | Meaning |
|---|---|---|
| 409 | `NAVDATA_SNAPSHOT_MISMATCH` | Batch epoch differs from the replica's (or no replica). Carries `serverSnapshotId` (null if none) and `serverRev`. Send a snapshot. |
| 409 | `NAVDATA_SCHEMA_UNSUPPORTED` | Schema version differs. Carries `serverSchemaVersion`. Also used for a replica whose columns do not match the schema. Retrying cannot help. |
| 400 | `NAVDATA_BAD_BATCH` | A batch over 2000 rows that spans more than one `rev`, over 20 000 rows, or a snapshot with zero rows while the replica already holds rows (an empty snapshot would erase it); malformed input, unknown row type/column, or a row that violates a constraint (for example a runway whose airport row does not exist). The whole batch is rolled back. |
| 413 | `NAVDATA_TOO_LARGE` | Over a byte limit (a `/rows` body over 4 MiB, or a snapshot upload over 64 MiB). |
| 503 | `NAVDATA_BUSY` | The replica is being replaced (a snapshot is uploading or being swapped). `Retry-After` is set; `/rows` is refused for the whole import so a batch can never land in the epoch that is about to be replaced. A Little Navmap import never makes the sidecar wait: its swap shares the busy flag but runs synchronously, so no request can arrive during it. |

## Query endpoints (session)

All under the normal session login (`requireAuth`); the ingest token is rejected.
They read the replica of the source that is shown (see
[Little Navmap import](#while-little-navmap-data-is-shown)). With no replica
for it they answer with empty results and `200` (never a `500`).

| Method | Path | Returns |
|---|---|---|
| GET | `/api/navdata/status` | `present` (false hides the map toggles), schema/epoch/revision, counts and `snapshotAppliedAt` (the replica's creation time: the sidecar snapshot's, or the import's), all for the replica shown; `source` (`mcdu`\|`lnm`, the one shown), `selectedSource` (the stored choice), `sourceFallback` (`lnm-unavailable` when Little Navmap is selected but its file is missing, else `null`), and `dataset` (`source`, `label`, `provider`, `airacCycle`, `validFrom`, `validThrough`, `expired`, `compiledAt`, `navigraphUpdate`, `importedAt`; `null` with no replica). `lastRowsAt` and `sidecar` always describe the simulator feed. During a swap it answers `present: false`. |
| GET | `/api/navdata/features?bbox=w,s,e,n&zoom=&kinds=&limit=` | Airports, navaids, waypoints, airways, runways inside the box; `gated` (kinds suppressed by zoom), `truncated`, and `coverage` (per-kind harvested-cell counts on a 0.5° global grid). `bbox`/`zoom` required, `limit` default 2000, max 5000. A box with `w > e` crosses the antimeridian and is split into two ranges. Longitudes are always in [-180, 180]; the client does the unwrapping. |
| GET | `/api/navdata/airports/:ident` | Position, `detailState` (`index` = position only, the normal case), runways, frequencies, procedure summaries. `404` only when the ident is not in the index. |
| POST | `/api/navdata/request` | `{ kind: 'A'\|'W', ident, region?, force? }` — ask the sidecar to fetch detail. Also requires a same-origin request. Answers `queued`, `already-present` or `known-absent` (an airport the simulator does not have, whether or not its absence row has arrived); idempotent. While Little Navmap data is shown it never queues and ignores `force`: `already-present` or `known-absent`. |
| GET | `/api/planned-legs/:legId/route-geometry` | The plan expanded into `sid`, `enroute`, `star`, `approach` chains (points and arcs), `skippedLegs` (coordinate-less procedure legs, counted and never invented), and `unresolved` names with reasons. Every chain empty is a legal answer. |

Manual "Fetch detail" requests are remembered in the `navdata_requests` table in
`flights.db` (not in `navdata.db`, so a snapshot swap cannot wipe them). Rows
expire after 7 days and are deleted once the replica answers them; while Little
Navmap data is shown they are neither answered nor deleted. See
[data-model.md](data-model.md#navdata_requests).

## Source and import endpoints (session)

Session login (`requireAuth`) only; the ingest token is never accepted. `PUT`,
`POST` and `DELETE` also require a same-origin request. Errors are
`{ "error", "code" }`, except the navdata-source `503`, which is
`{ "ok": false, "code", "message" }`; the two `507` prechecks add
`requiredBytes` and `availableBytes`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/settings/navdata-source` | `{ selected, effective, fallback, mcdu: { present, dataset }, lnm: { present, dataset }, importDir }`. |
| PUT | `/api/settings/navdata-source` | `{ source: 'mcdu' \| 'lnm' }`. Stored in `flights.db` (`app_setting.navdata_source`) and applied at once, no restart. `400 INVALID_SOURCE` for any other value; `409 LNM_NOT_AVAILABLE` when choosing `lnm` with nothing imported. `503 NAVDATA_BUSY` (with `Retry-After`) is reserved for a request that finds a swap in progress; swaps run synchronously, so it is not expected in practice. |
| GET | `/api/navdata/lnm-import` | `{ job }`: the running or last import (`null` after a restart). A job has `id`, `origin` (`upload`\|`path`), `sourceFileName`, `sourceBytes`, `state` (`receiving`, `running`, `succeeded`, `failed`, `cancelled`), `stage`, `fraction` (0–1), `startedAt`, `finishedAt`, `error { code, message }` and `result { dataset, counts, warnings }`. |
| GET | `/api/navdata/lnm-import/files` | `{ dir, files: [{ name, sizeBytes, modifiedAt }], maxUploadBytes, availableBytes, reserveBytes }`: the `.sqlite` files in the import folder, the upload limit, free space (`null` if unmeasurable) and the space an import needs beyond the upload. |
| POST | `/api/navdata/lnm-import/path` | JSON `{ fileName }`: a bare file name in the import folder (no directory part). `202 { job }`. |
| POST | `/api/navdata/lnm-import/upload` | Multipart, exactly one part, field `lnmDatabase`, with a `Content-Length`. `202 { job }` once the whole file has arrived. |
| DELETE | `/api/navdata/lnm-import` | Cancel the running import. `202 { job }`; the job ends `cancelled` and the previous import stays in place. `409 LNM_NOT_RUNNING` when nothing runs. |

Refusals answered on the request itself:

| HTTP | Code | When |
|---|---|---|
| 400 | `LNM_BAD_REQUEST` | `fileName` is not a bare `.sqlite` name, the file is not a regular file or cannot be read, or the upload is not exactly one file in `lnmDatabase`. |
| 400 | `LNM_NOT_SQLITE` | The file does not start with the SQLite header. |
| 404 | `LNM_FILE_NOT_FOUND` | No such file in the import folder. |
| 409 | `LNM_IMPORT_BUSY` | Another import is running. |
| 411 | `LNM_LENGTH_REQUIRED` | An upload without `Content-Length`. |
| 413 | `LNM_TOO_LARGE` | An upload over 2 GiB. |
| 507 | `LNM_INSUFFICIENT_STORAGE` | Less free space in the import folder than the upload plus 1.25 GiB (adds `requiredBytes`, `availableBytes`), or the disk filled up while the upload was being written (no extra fields). |
| 507 | `LNM_INSUFFICIENT_MEMORY` | Less than 1 GiB of memory available. Adds `requiredBytes`, `availableBytes`. |
| 500 | `LNM_SPOOL_FAILED` | The upload could not be written to disk for another reason (for example a permission error); message *The server could not store the upload*. |

An upload refused once its job exists (`LNM_TOO_LARGE`,
`LNM_BAD_REQUEST`, `LNM_NOT_SQLITE`, `LNM_INSUFFICIENT_STORAGE`,
`LNM_SPOOL_FAILED`) also ends its job `failed` with the same code. Failures
found later end the job `failed`, with `job.error.code` one of:
`LNM_NOT_ATOOLS` (not a Little Navmap database), `LNM_UNSUPPORTED_SOURCE`
(`data_source` other than `NAVIGRAPH`, `MSFS`, `MSFS24`), `LNM_EMPTY` (no
airports), `LNM_FLAVOUR_MISMATCH` (values that contradict the declared
source), `LNM_OPEN_FAILED`, `LNM_DISK_FULL`, `LNM_BUILD_FAILED` (`import failed
in stage <stage>`), `LNM_VERIFY_FAILED`, `LNM_OUT_OF_MEMORY`,
`LNM_WORKER_FAILED`, `LNM_SWAP_FAILED`, `LNM_UPLOAD_ABORTED` (the page was
closed or the connection dropped mid-upload) and `LNM_INTERRUPTED` (the server
shut down). Messages never contain row values or absolute paths (an unsupported `data_source` is echoed, cut to 16 characters).
Stages, in order: `validating`, `indexing`, `airports`, `navaids`,
`waypoints`, `airways`, `procedures`, `finalising`, `coverage`, `verifying`,
`swapping`.

## Route geometry rules

- A planned waypoint's own coordinates are always drawn; the replica only
  enriches and validates them (more than 1 km disagreement is reported).
- A planned waypoint's `airway` names the airway used to reach *that* waypoint
  from the previous one. `DCT`, the plan's own SID/STAR (or transition) name, and
  any value at an airport endpoint are not airways: those segments are drawn
  direct. Only an unknown airway name is reported as unresolved.
- SIDs and STARs are matched by exact, case-insensitive name plus runway and
  suffix. An approach is NOT matched by name: the plan's `approach_name` is a fix
  ident. Candidates are the airport's approaches whose runway number and designator equal
  the plan's runway (an approach stored with runway 0, meaning "no runway", never
  matches a plan runway) with the same suffix (the simulator
  writes `0` for none, so a plan with no suffix matches `0`; any other value,
  digit or letter, is a real suffix); then the plan's ARINC letter gives a
  preferred approach type (I ILS, L LOC, B back course, R/H RNAV, P GPS, V/T VOR or
  TACAN, D VOR/DME, N NDB, Q NDB/DME, X LDA, S/U SDF; with no letter the plan's
  `approach_type` text is used instead). It is a preference, not a filter: if no
  candidate has that type, all stay. A candidate whose final-approach fix or
  transition has the plan's fix name wins a tie; then the smallest key. A plan
  with no approach runway is reported as "approach runway not specified" and
  drawn as nothing rather than guessed.
- A planned waypoint is resolved against its OWN coordinates (the previous
  point only if those are invalid). Candidates are the replica's fixes and
  navaids with the plan's ident — those in the plan's region when it has one
  and any exist there, otherwise every row with the ident. Among candidates
  within 1 km, an airway endpoint wins, then a navaid over a fix, then the
  nearest; with none within 1 km, the nearest overall. A chosen candidate more
  than 1 km away yields to an airway endpoint of the same ident within 1 km, if
  there is one. This keeps a same-named VFR or RNAV point from hiding the VOR
  an airway actually uses. Airway legs whose endpoints carry the same ident and
  region within 0.0001 degrees are one node.
- A negative speed limit on a procedure leg means "no limit" and is never drawn.
- Custom procedures are computed from `nav_runway`: the runway is matched on its
  primary end first, then the secondary end (never by which number is lower),
  the runway heading is a **true** bearing (measured), and the landing threshold
  is the pavement end moved inboard by the displaced threshold, if any.
  *Provisional:* the primary/secondary pairing of the displaced-threshold
  columns rests on one sample; the departure starting datum and the offset sign
  are assumptions.

## Operating it

- Location: `NAVDATA_DB_PATH`, default `./navdata.db`. The Little Navmap
  replica is the same path plus `.lnm` (`navdata.db.lnm`), and the directory
  holding them is the server-side import folder. Docker Compose mounts the
  **directory** `./navdata` at `/app/navdata` (a single-file bind mount cannot be
  swapped by rename) and sets `NAVDATA_DB_PATH=/app/navdata/navdata.db`, so in
  Docker you drop a `.sqlite` for import into `./navdata` on the host.
- Backups: neither replica is part of `npm run backup`. `navdata.db` needs none
  (the sidecar can always re-send its whole store); `navdata.db.lnm` is rebuilt
  by importing the `.sqlite` again, so keep that file. To reset, stop the server
  and delete the replica (and its `-wal`/`-shm`); with `navdata.db.lnm` gone and
  Little Navmap still selected, the map shows simulator data until you import
  again or switch back.
- A replica that is corrupt or of another schema version is logged and treated
  as absent; the server still starts.
- The server creates the navdata directory at startup if it is missing (and
  the import routes create it again before listing or receiving a file); if
  it cannot, it logs one line and carries on.
- At startup the server deletes leftover temporary files of both replicas
  (`navdata.db.incoming-*`, `navdata.db.lnm.incoming-*`, upload spools
  `navdata.db.lnm.upload-*`) and nothing else in the directory, so your own
  `.sqlite` files are kept. A server shutdown during an import cancels it and
  removes its files (`LNM_INTERRUPTED`).
- Disk and memory for a Little Navmap import: the uploaded file (if uploaded)
  plus about 1.25 GiB free in the import folder, and 1 GiB of available memory;
  the import refuses to start otherwise. The upload is spooled in the import
  folder, not the OS temp directory. A reverse proxy in front of the server must
  allow a request body of up to 2 GiB, pass `Content-Length` through, and allow
  the transfer time (the server gives an authenticated upload up to 1 h); with
  a smaller proxy limit, use the import folder instead.
- Every rejected sync request (any of the four sidecar routes) logs one warning line `navdata: <route> rejected <status> <code>: <message>` in the server log. The message names only structure (row index, table, column, limits), never a value or the token; identical consecutive rejections within a minute collapse into one line with a repeat count. An oversize body (a `/rows` body over 4 MiB, or an oversize snapshot upload) or unparseable JSON answered by the global error handler is not logged yet.
- Sidecar snapshot uploads are staged in a per-process private temporary
  directory and removed after import.
- Ingest cost: a full worldwide airport index from the sidecar imports in a few
  seconds on a desktop machine; a complete Little Navmap file takes about a
  minute (see [Running an import](#running-an-import)).

See also [api.md](api.md), [configuration.md](configuration.md),
[data-model.md](data-model.md), [security.md](security.md) and
[troubleshooting.md](troubleshooting.md#navdata).
