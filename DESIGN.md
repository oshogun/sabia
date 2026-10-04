---
name: Sabiá
description: Self-hosted flight logbook for MSFS and FSX — the logbook web app (client/)
colors:
  interactive-blue: "#0f62fe"
  ops-floor: "#161616"
  console-panel: "#262626"
  panel-seam: "#393939"
  readout-white: "#f4f4f4"
  annotation-gray: "#c6c6c6"
  placeholder-gray: "#8d8d8d"
  link-blue: "#78a9ff"
  focus-white: "#ffffff"
  track-blue: "#78a9ff"
  departure-green: "#42be65"
  arrival-red: "#fa4d56"
  planned-gray: "#a8a8a8"
  caution-yellow: "#f1c21b"
  navaid-cyan: "#33b1ff"
  waypoint-purple: "#be95ff"
  leg-orange: "#ff832b"
  leg-magenta: "#ff7eb6"
  sabia-cobalt: "#03159f"
  sabia-ember: "#f54a1c"
  sabia-plum: "#710284"
  sabia-wordmark: "#e2e8f0"
typography:
  brand:
    fontFamily: "Montserrat, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.02em"
  display:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 400
    lineHeight: 1.25
  headline:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 400
    lineHeight: 1.28572
  title:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 400
    lineHeight: 1.4
  body:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.42857
    letterSpacing: "0.16px"
  label:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.33333
    letterSpacing: "0.32px"
  readout:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 400
    lineHeight: 1.25
  mono:
    fontFamily: "IBM Plex Mono, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
rounded:
  none: "0px"
spacing:
  "03": "0.5rem"
  "04": "0.75rem"
  "05": "1rem"
  "06": "1.5rem"
  "07": "2rem"
components:
  button-primary:
    backgroundColor: "{colors.interactive-blue}"
    textColor: "{colors.readout-white}"
    rounded: "{rounded.none}"
    height: "48px"
  button-ghost:
    textColor: "{colors.link-blue}"
    rounded: "{rounded.none}"
    height: "48px"
  tile:
    backgroundColor: "{colors.console-panel}"
    textColor: "{colors.readout-white}"
    rounded: "{rounded.none}"
    padding: "1rem"
  stat-tile-value:
    typography: "{typography.readout}"
    textColor: "{colors.readout-white}"
  text-input:
    backgroundColor: "{colors.console-panel}"
    textColor: "{colors.readout-white}"
    rounded: "{rounded.none}"
    height: "40px"
  header:
    backgroundColor: "{colors.ops-floor}"
    textColor: "{colors.readout-white}"
    height: "48px"
  map-frame:
    backgroundColor: "{colors.console-panel}"
    rounded: "{rounded.none}"
---

# Design System: Sabiá

This file governs the logbook web app in `client/`. The project website
(`/home/guilherme/sabia-site/`) is a separate visual world with its own
DESIGN.md; nothing here applies to it.

## Overview

**Creative North Star: "The Dispatch Office"**

An airline operations room after hours. The room is dark and quiet. Every
screen is a working console: dense tables, tiles of readouts, a map with the
aircraft on it, and status tags that change colour only when something has
changed. Nothing decorates. Colour is information, so a pilot glancing over
from the sim during a flight reads the header tag and the live panel at once,
and at the desk after the flight the same room holds the whole logbook in
tables that reward scanning.

The system is IBM Carbon, Gray 100 theme, used as a base rather than a
costume. Carbon supplies the components, the `--cds-*` tokens, the grid, the
square geometry and the flat surfaces. Sabiá's identity sits on top in a few
deliberate places: the bird logo and the Montserrat product name in the
header, the map as a first-class instrument with a dark-inverted basemap,
and a fixed colour vocabulary for flight data and status that means the same
thing on every screen. New Sabiá-specific touches are welcome when they are
as deliberate as those; they draw on the logo's own colours and never
compete with status colour.

The PDF/print export is a second, deliberately different sub-system: a light
paper document. It is documented under Components → Print documents.

**Key Characteristics:**
- Dark, flat, square: Gray 100 background (#161616), panels one step up (#262626), zero corner radius.
- Colour is reserved for meaning: status tags, flight data on maps, support states.
- IBM Plex Sans throughout; Montserrat only for the header product name.
- The map is an instrument, not an illustration: inverted dark tiles, Carbon-ramp data colours.
- Dense at the desk, glanceable in flight.

## Colors

A near-black neutral ground with Carbon's one interactive blue, plus a fixed
data-visualisation vocabulary drawn from Carbon's 40-tint ramps.

### Primary
- **Interactive Blue** (#0f62fe): Carbon `--cds-button-primary` / `--cds-interactive`. Primary buttons only (Save, Import, Sign in). One primary action per view.

### Secondary
- **Link Blue** (#78a9ff): Carbon `--cds-link-primary`; ghost-button text and inline links. The same value is **Track Blue** on maps (the flown track), which is why links and the track feel related.

### Tertiary: flight-data vocabulary (maps and charts)
Mirrored as JS strings in `client/src/components/maps/palette.ts` and `navdata/navdataPalette.ts`, because Leaflet can't read CSS tokens. Import from those modules; never hard-code.
- **Track Blue** (#78a9ff, blue-40): the flown track; towered airports.
- **Departure Green** (#42be65, green-40): departure marker, positive vertical speed.
- **Arrival Red** (#fa4d56, red-50): arrival marker, negative vertical speed.
- **Planned Gray** (#a8a8a8, gray-40): the planned route and its waypoint dots.
- **Caution Yellow** (#f1c21b, yellow-30): warnings; AI traffic in the air.
- **Navaid Cyan** (#33b1ff, cyan-40): navaids.
- **Waypoint Purple** (#be95ff, purple-40): enroute waypoints and untowered airports (the chart "magenta" convention).
- **Leg cycle**: blue-40 → green-40 → **Leg Orange** (#ff832b) → purple-40 → **Leg Magenta** (#ff7eb6), repeating, for trip legs on the Atlas map.

### Sabiá brand (logo)
- **Sabiá Cobalt** (#03159f), **Sabiá Ember** (#f54a1c), **Sabiá Plum** (#710284): the dominant fills of the bird in `client/public/sabia-logo.svg`. Currently used only inside the logo. They are the allowed source for any new Sabiá-specific accent.
- **Wordmark Slate** (#e2e8f0): the logo's wordmark, recoloured from the original near-black so it reads on the dark header and login screen.

### Neutral
- **Ops Floor** (#161616): `--cds-background`. Page ground, header, side nav.
- **Console Panel** (#262626): `--cds-layer-01`. Tiles, table rows, inputs, the map frame and the map's empty ground.
- **Panel Seam** (#393939): `--cds-border-subtle-01` / `--cds-layer-02`. Hairline borders around maps and panels; nested layers.
- **Readout White** (#f4f4f4): `--cds-text-primary`. All primary text and values.
- **Annotation Gray** (#c6c6c6): `--cds-text-secondary`. Labels, captions, stat-tile labels, map attribution.
- **Placeholder Gray** (#8d8d8d): placeholders, disabled text, airways, AI traffic on the ground.

### Named Rules
**The Status Owns Colour Rule.** A hue on a tag or chip means one thing everywhere. Live status: green *Recording*, magenta *Paused*, blue *Connected · Idle*, gray *Sim not connected* / *Waiting for sim* (a flight held open while the sim's data has stopped) / *Checking...*, red *Server unreachable*. Legs: cool-gray *planned*, green *flown*, red *diverted*, gray *skipped*, purple *active trip*. ACARS: blue PDC, teal WX, cyan position report, purple dispatch, green OOOI, gray free text. New statuses get a new entry in `StatusTag.tsx`'s `KINDS` table, never an inline colour.

**The Logo-Only Brand Colour Rule.** Sabiá's own colours come from the bird, are used sparingly (a mark, an edge, a moment, never a surface fill or a button), and never on anything that could be mistaken for a status.

## Typography

**Display Font:** IBM Plex Sans (with system-ui, sans-serif). Regular 400 and SemiBold 600, self-hosted.
**Brand Font:** Montserrat 700 (with sans-serif). Header product name only.
**Mono Font:** IBM Plex Mono 400, for codes, tokens and raw ACARS text.

**Character:** Plex is the engineer's voice of the room: neutral and exact, with tabular-feeling numerals that suit readouts. Montserrat's heavy geometric caps echo the logo's wordmark and appear exactly once per screen.

### Hierarchy
Each role is a class in `client/src/styles/index.scss` ("Type roles"). Components apply the class; they never set font size, weight or family inline.
- **Display** (400, 2rem, 1.25): page title (`.sabia-heading-05`, Carbon heading-05). One h1 per page.
- **Headline** (400, 1.75rem, 1.28572): major section headings (`.sabia-heading-04`). Reserved; unused today.
- **Title** (400, 1.25rem, 1.4): every page-section and tile/panel title (`.sabia-heading-03`), with no per-page overrides.
- **Subtitle** (600, 1rem, 1.5): a subsection inside a section or disclosure, e.g. Home's *Recent flights* and *Manual entry* (`.sabia-heading-02`, Carbon heading-02).
- **Body** (400, 0.875rem, 1.42857, 0.16px): Carbon body-01. Tables, forms, prose.
- **Helper** (body-01, Annotation Gray): explanatory text under a title (`.sabia-helper`).
- **Label / meta** (400, 0.75rem, 1.33333, 0.32px): Carbon label-01. Field labels, captions, map tooltips; secondary lines in tables and leg rows (`.sabia-meta`).
- **Readout** (400, 2rem, 1.25, tabular numerals): stat-tile values and the live panel's readouts (`.sabia-readout`), with an Annotation Gray 0.875rem label above (`.sabia-readout-label`) and a 0.875rem unit after (`.sabia-unit`). Regular weight; the size carries it.
- **Compact readout** (400, 1.25rem, 1.4, tabular): a readout too long for 2rem, such as coordinates or the remaining distance (`.sabia-readout--compact`).
- **Code** (IBM Plex Mono): token ids and identifiers (`.sabia-code`); raw ACARS text.

Data tables and structured lists use tabular numerals throughout, so columns of times and distances line up.

### Named Rules
**The Outline-First Rule.** Heading elements follow the document outline (one h1, no level jumps). The `sabia-heading-0x` classes set the look independently of the element, so never pick an `h` level for its size.

**The Light Readout Rule.** Numbers are large and regular, never bold. Weight is for emphasis in prose; size is for data.

## Layout

Carbon UI Shell: a fixed 3rem (48px) header, a side nav docked at Carbon's
`lg` breakpoint (≥66rem) and an overlay behind the menu button below it
(not remembered between visits), and a content region to its right. At
<42rem the header drops the username and the product name, leaving the logo
and the account action.

Spacing comes from Carbon's scale: `Stack` gaps of 4 (0.75rem), 5 (1rem) and
6 (1.5rem) between blocks; `--cds-spacing-05` (1rem) as the default gutter;
`--cds-spacing-07` (2rem) inside the login card. Stat tiles use a CSS grid,
not Carbon columns: 2 equal columns, 4 at ≥66rem, 1rem gap, every tile
stretched to its row's height so a long value never leaves a ragged edge.

Density is Carbon default. Tables are paginated. The map sits at full content
width with the altitude profile directly under it on flight detail.

## Elevation & Depth

Flat. Depth is tonal layering, not shadow: #161616 ground → #262626 panel
→ #393939 nested layer or seam. Hairline #393939 borders separate a map or
panel from the ground. Shadows don't exist in the app chrome; the map's
Leaflet controls have their default shadow removed. The only z-axis rule is
functional: maps use `isolation: isolate` so the fixed header and side nav
(z-index 8000) always paint above them.

### Named Rules
**The Lights-Off Rule.** Nothing glows, lifts or floats. If something needs to stand out, it changes layer or takes a status colour.

## Shapes

Square. Zero radius everywhere, inherited from Carbon, including map
tooltips (`border-radius: 0`) and the login card. Rectangles, hairlines and
full-bleed maps. The only curves are Carbon's pill-shaped status tags, the
bird, and the map markers (dot markers with a #f4f4f4 ring); the pill shape
is part of what marks a tag as status.

## Components

### Buttons
- **Shape:** square (0px), Carbon heights (48px default; `sm` 32px in table toolbars).
- **Primary:** Interactive Blue fill, white text. One per view.
- **Ghost:** the workhorse (28 uses): row actions, header actions, secondary controls. Link Blue text, no fill until hover (`--cds-layer-hover-01`).
- **Tertiary:** outlined, for the secondary action next to a primary.
- **Danger / danger--ghost / danger--tertiary:** delete, remove, skip. Always behind a confirmation Modal.
- **Focus:** Carbon's 2px white inset focus ring (`--cds-focus`), also on Leaflet zoom controls.

### Tags (status)
- **Style:** Carbon `Tag` in its stock pill shape, the one rounded element in the chrome; colour from the `KINDS` table in `client/src/components/StatusTag.tsx`.
- **Live status tag:** in the header, the one element that's always glanceable. See The Status Owns Colour Rule.

### Tiles / Containers
- **Corner Style:** 0px.
- **Background:** Console Panel (#262626).
- **Shadow Strategy:** none; see Elevation & Depth.
- **Internal Padding:** Carbon tile default (1rem); login card 2rem.
- **`.cds--g90` inset zone:** available for a panel that needs one more step of contrast (background #262626 as its ground).

### Stat tiles (signature)
A grid of readouts: Annotation Gray label (0.875rem) above a Readout White value (2rem, regular, tabular). Used on Home (aggregate stats) and flight/trip detail. Home's in-flight live panel uses the same readout roles, four to a row at ≥66rem.

### Inputs / Fields
- **Style:** Carbon text input: #262626 fill, bottom border only, square.
- **Focus:** 2px white focus outline.
- **Error:** Carbon invalid state (red-50 outline and helper text). Errors on submit come as an inline `InlineNotification` (kind="error"), the most-used feedback component in the app.

### Navigation
- **Header:** Ops Floor, logo at 28px plus "Sabiá" in Montserrat 700; live status tag; username; log-out as a `HeaderGlobalAction`.
- **Side nav:** Home, All flights, Prefiles, Settings, then a tree of trips (each a `SideNavMenu`) with their flights, and loose flights. Active route is Carbon's selected state.

### Maps (signature)
- **Frame:** Console Panel ground, 1px Panel Seam border, square.
- **Basemap:** OpenStreetMap tiles inverted to dark with one constant filter, `invert(1) hue-rotate(180deg) brightness(0.92) contrast(0.9)`, on the tile pane only. Data layers stay uninverted.
- **Data:** colours from the flight-data vocabulary above; navdata symbols keep their shape encoding (towered/surface/size) and use the navdata palette.
- **Tooltips:** inverse (light) background, dark text, 0.75rem, square, no shadow.
- **Controls:** Leaflet bar restyled to Console Panel with Panel Seam borders and no shadow.

### Print documents (sub-system)
The PDF export routes (`/print/...`) never load the app theme; `client/src/print/print.css` is self-contained.
- **World:** a light A4 paper document, 703px fixed content width (186mm), 12mm page margin.
- **Palette:** white page (#ffffff), slate surface (#f8fafc), border #d8dee9, text #0f172a, muted #64748b, accent #2563eb. Print map and chart lines use Tailwind-400 tints (#60a5fa track, #34d399 departure, #f87171 arrival, #a78bfa / #f59e0b leg colours).
- **Type:** the system UI stack (`-apple-system, Segoe UI, DejaVu Sans, Liberation Sans`), not Plex.
- **Shape:** unlike the app, rounded: stat cards 10px, notes box 8px.
- Treat it as its own world: a change to the app's look does not propagate here, and vice versa.

## Do's and Don'ts

### Do:
- **Do** use Carbon components and `--cds-*` tokens for everything the app draws; add a component's SCSS `@use` line to `client/src/styles/index.scss` when you introduce it, or it renders unstyled.
- **Do** take map and chart colours from `palette.ts` / `navdataPalette.ts`, and status colours from `StatusTag.tsx`'s `KINDS`.
- **Do** keep surfaces flat and square: layer #161616 → #262626 → #393939, hairline borders.
- **Do** keep one primary button per view; row and toolbar actions are ghost buttons.
- **Do** confirm every destructive action in a Modal.
- **Do** draw Sabiá-specific accents from the logo's colours (#03159f, #f54a1c, #710284), sparingly.

### Don't:
- **Don't** hard-code hex values in components; the Override easter egg's fallbacks are the only exception.
- **Don't** add shadows, glows, gradients or rounded corners to app chrome.
- **Don't** reuse a status hue for decoration, or give one status two colours.
- **Don't** use Montserrat anywhere but the header product name, or bold weights for numeric readouts.
- **Don't** invert data layers on the map; only the tile pane is filtered.
- **Don't** import the full `@carbon/react` style barrel (929 kB vs 527 kB CSS).
- **Don't** apply these rules to the print export or the project website; each has its own world.
