---
name: DataCenterOS dashboard
description: Dark operator console for GPU placement, training durability, and recovery evidence.
colors:
  background: "#10151c"
  shell: "#111922"
  surface: "#171e27"
  surface-raised: "#202a35"
  foreground: "#e8edf2"
  muted: "#a6b4c3"
  line: "#303c49"
  agent: "#8bd6b1"
  warning: "#efc589"
  danger: "#f0a29d"
  job-a: "#9abedc"
  job-b: "#c4b5dc"
  job-c: "#dbc18f"
  focus: "#b3d4ed"
  selection: "#395367"
  primary-text: "#14291f"
  primary-hover: "#abe8c9"
typography:
  headline:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "27px"
    fontWeight: 620
    lineHeight: 1.3
    letterSpacing: "-0.025em"
  title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.015em"
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "14px"
    lineHeight: 1.5
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "12px"
    fontWeight: 550
    lineHeight: 1.5
  clock:
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace'
    fontSize: "16px"
    fontWeight: 450
    lineHeight: 1.5
  metric:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "20px"
    fontWeight: 500
    lineHeight: 1
rounded:
  track: "2px"
  badge: "4px"
  control: "6px"
  disclosure: "10px"
  panel: "12px"
spacing:
  tight: "4px"
  control: "8px"
  compact: "12px"
  inset-small: "16px"
  inset: "20px"
  section: "24px"
  page: "32px"
components:
  button-primary:
    backgroundColor: "{colors.agent}"
    textColor: "{colors.primary-text}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "7px 13px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "7px 13px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "7px 13px"
  button-destructive:
    backgroundColor: "#532d32"
    textColor: "#ffe3df"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "7px 13px"
  select:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    padding: "6px 28px 6px 10px"
  navigation:
    backgroundColor: "{colors.shell}"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "11px 12px"
  badge:
    backgroundColor: "#293440"
    textColor: "#c1cbd5"
    rounded: "{rounded.badge}"
    padding: "3px 7px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.panel}"
  gpu-cell:
    backgroundColor: "#273d4b"
    textColor: "#d8e7f2"
    rounded: "{rounded.badge}"
    height: "35px"
  job-progress:
    backgroundColor: "#2b3642"
    rounded: "{rounded.track}"
    height: "8px"
---

# Design System: DataCenterOS dashboard

## Overview

The implemented dashboard follows the team's dark operator console brief. Ink-blue shell surfaces surround slate panels; measured off-white typography keeps dense operational information readable. Mint identifies agent activity and primary actions, while amber and red communicate concern and failure.

This document records the current implementation. The source of truth is [src/styles.css](src/styles.css), supported by [PRODUCT.md](PRODUCT.md) and the [cluster surface brief](.impeccable/surfaces/cluster.md). Source locations below refer to the stylesheet at documentation time. Spacing and radius names in the frontmatter describe repeated values; the stylesheet does not define a corresponding CSS variable for every entry.

**Key Characteristics:**

- Compact controls, fixed-size system typography, and tabular measurements.
- Flat bordered surfaces with restrained tonal layering.
- Thermal state, job identity, and selection use separate visual treatments.
- Provenance, unavailable data, and failure states remain explicit.

## Colors

### Primary

Mint (`agent`) marks primary controls, agent feed metadata, checkpoint notices, and confirmed control messages. Its hover and dark text colors are recorded separately. The actual primary button text differs from the Tailwind primary-foreground alias; the component token above records the rendered button rule.

### Secondary

Amber (`warning`) marks thermal concern and data caveats. Soft red (`danger`) marks failures, lost work, blocked reasons, and connection errors. Job colors (`job-a`, `job-b`, `job-c`) identify allocations and durable work; these colors do not encode thermal health.

### Neutral

`background` is the page canvas, `shell` the masthead/navigation, `surface` the panel and select background, and `surface-raised` the raised neutral control fill. `foreground` and `muted` establish text hierarchy; `line` separates regions. `focus` is the keyboard outline. `selection` is the text-selection background, paired with white text.

Thermal cells use dedicated background/text/border combinations rather than the global warning color alone. Normal, warm, hot, fault, and missing data each have a distinct treatment. Source: stylesheet lines 14–46, 89–103, 127–144, and 171–191.

## Typography

System sans is used for headings, controls, and prose. The monospace stack is reserved for identifiers, numeric table cells, timestamps, GPU readings, and clocks; these use tabular numerals. There are no downloaded fonts or fluid heading scales.

The page headline is `headline`, reducing to 25px at the mobile breakpoint. Panel headings use `title`; subsection headings are 13px at weight 550. The root body is `body`, while most operational content uses 12px, supporting labels use 10–11px, and dense secondary annotations use 9px. Clock and progress roles are recorded in the frontmatter. Paragraphs have a 75ch maximum except explicitly wider notices and layouts. Source: stylesheet lines 29–32, 51, 58–82, 113–114, 179–182, and 320–351.

## Layout

The desktop masthead is sticky at 66px high. A fixed 190px sidebar starts beneath it. Main content has a matching left offset, a 1770px maximum width, and horizontal padding of `clamp(20px, 2.6vw, 44px)`. The overview uses `minmax(0, 1.3fr) minmax(330px, 1fr)` columns with 20px gaps. Activity panels use two equal columns. Panel headings and repeated content rows generally use 20px horizontal insets.

The GPU matrix retains eight columns, with a separate rack-label column. Its default cells are 35px high with 5px gaps. Tables scroll horizontally within their own container. Long identifiers and evidence strings wrap. Feed lists have a 600px maximum height and scroll internally.

| Viewport rule | Implemented change |
| --- | --- |
| At least 1700px | GPU cell height increases to 42px. |
| At most 1200px | Sidebar contracts to 64px icons; main inset becomes 24px; overview gap becomes 16px and the right column minimum becomes 300px; matrix labels narrow to 49px. |
| At most 930px | Main overview and activity grids stack; overview subgroups use a two-column arrangement, with topology spanning both; toolbar wraps; GPU cells become 39px high. |
| At most 680px | Masthead becomes 58px; navigation moves into a horizontal row; main inset becomes 16px; overview subgroups stack; controls wrap; inspector becomes two columns; matrix cells become 32px high. |
| At most 380px | Navigation icons hide; matrix label width becomes 29px and gaps become 3px. |

The body supports a 320px minimum width. Source: stylesheet lines 38, 57–78, 109–124, 227–250, and 289–378. The responsive rules resize and rearrange the interface; they do not remove the eight GPU columns.

## Elevation & Depth

The implementation uses no box shadows, gradients, or glows. Distinction comes from surface fills, one-pixel borders, separators, and contained inspector backgrounds. The masthead and skip link use stacking order to remain usable, not to suggest floating cards. Source: stylesheet lines 55–69, 111–112, 146, 206, and 274–280.

Motion is limited to background/border transitions on buttons (160ms ease-out), GPU background transitions (180ms ease-out), and smooth anchor scrolling. Reduced-motion preference disables transitions and animations and restores automatic scrolling. Source: stylesheet lines 37, 89, 127, and 375–378.

## Shapes

Panels use the largest repeated corner radius; disclosures and connection banners use the next smaller radius. Buttons, selects, and navigation items share the control radius. GPU cells and badges share compact corners; progress tracks and job markers use the smallest radius. Status dots are circular. Borders are usually one pixel; missing GPU data and the real-hardware section use dashed boundaries.

Keyboard focus has a 2px light-blue outline with a 3px offset. Selected GPU cells have a separate 2px pale outline with a 1px offset. Text selection uses the recorded selection background and white text. Source: stylesheet lines 44–45, 84, 88–111, 127–138, 162–184, and 206.

## Components

### Buttons and fields

[Button](src/components/ui/button.tsx) exposes default, secondary, ghost, and destructive variants, plus default, small, and icon sizes. Default buttons have a 36px minimum height; small controls use 34px and 5px by 11px padding; icon buttons are 36px wide. Primary hover lightens mint, secondary hover uses a lighter slate, ghost hover gains a raised fill and foreground text, and destructive hover lightens the red fill. There is no custom pressed-state transform. Disabled buttons/selects use 0.48 opacity and a not-allowed cursor; keyboard focus uses the shared outline.

Native selects are the implemented field primitive, with a 34px minimum height, surface fill, one-pixel line border, and room for the native arrow. The current screen has no custom text-input component. Source: stylesheet lines 39–46 and 88–99; [Controls](src/components/controls/Controls.tsx).

### Navigation, panels, and badges

The shell navigation uses compact icon-and-label links. The first link currently receives the selected treatment; hover uses the raised surface. Preserve the responsive behavior described in Layout. [Panel](src/components/ui/panel.tsx) renders a labelled section with a heading and optional detail. Internal rows are divided with borders rather than separate floating cards.

Badges are small, noninteractive labels. Neutral, warning, danger, and agent tones pair a darker fill with a brighter corresponding text color. Do not treat a badge as an actionable control. Source: stylesheet lines 64–70, 100–103, and 111–114.

### GPU topology and training progress

[Heatmap](src/components/heatmap/Heatmap.tsx) uses normal below 80°C, warm from 80°C to below 85°C, and hot from 85°C; unavailable GPUs or GPUs with an XID code take fault styling. Fault and throttle icons supplement color. A job-colored bottom border indicates allocation independently of temperature. Missing readings use an em dash and a dashed border. Selection opens an inline inspector and supports arrow keys, Home, and End through roving focus. A thin cooling-domain line groups racks R2–R4. Source: stylesheet lines 118–152.

[Jobs](src/components/jobs/Jobs.tsx) distinguishes work in progress from durable work using two overlaid fills. The work fill mixes the job color at 42% with dark slate; the durable fill uses the full job color. A pale vertical checkpoint marker extends beyond the track. Checkpoints being written are explicitly labelled not durable yet; unknown checkpoint age stays unavailable. Source: stylesheet lines 168–194.

### Evidence, empty states, and data honesty

Simulation badges and provenance copy stay close to the data. Fixture playback and scripted recovery examples are labelled; the recovery notice explicitly says it is not a live diagnosis, executed plan, or benchmark. Simulation time and wall time have separate labels. Connection errors disclose whether last-received data is being shown and provide Retry; stale state is named in the status treatment. Source: [App](src/app/App.tsx), stylesheet lines 78–86 and 271–279.

[RealGpu](src/components/heatmap/RealGpu.tsx) lives in a distinct dashed section labelled REAL. It accepts only hardware telemetry from the named collector, shows missing readings as No data, and labels stale samples; the observation-only device is never presented as a training allocation. [Scoreboard](src/components/scoreboard/Scoreboard.tsx) shows a descriptive empty state until matched evaluation results exist, exposes unavailable fields, and describes excluded results and missing provenance. Examples, placeholders, and absence of data must not visually imply measured results. Source: stylesheet lines 195–214 and 256–273.

## Do's and Don'ts

### Do:

- Do preserve the team's dark operator console palette and compact density.
- Do reserve mint for agent activity and primary actions, and keep job identity separate from thermal state.
- Do preserve keyboard focus, GPU selection outlines, native controls, and horizontal table scrolling.
- Do distinguish durable checkpoints from work in progress and label unavailable values.
- Do keep simulation, scripted examples, hardware readings, and evaluation provenance visible beside their data.

### Don't:

- Don't add shadows or glows to the existing flat surface system.
- Don't rely on color alone for faults, selection, or data provenance.
- Don't collapse or omit GPU columns to make a narrow viewport fit.
- Don't present fixture playback as a live agent or populate missing benchmarks with invented values.
- Don't replace the fixed operational type scale with fluid promotional headings.
