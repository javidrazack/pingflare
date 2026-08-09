---
name: Pingflare
description: Calm, precise operational monitoring for self-hosters.
colors:
  primary: "#b45309"
  primary-hover: "#92400e"
  primary-active: "#78350f"
  primary-soft: "#fef3c7"
  primary-dark-mode: "#d97706"
  white: "#ffffff"
  canvas: "#ffffff"
  surface-subtle: "#f9fafb"
  surface-muted: "#f3f4f6"
  ink: "#030712"
  ink-muted: "#4b5563"
  border: "rgb(15 23 42 / 0.14)"
  dark-canvas: "#030712"
  dark-surface-subtle: "#0b1120"
  dark-surface: "#111827"
  dark-ink: "#f9fafb"
  dark-ink-muted: "#9ca3af"
  dark-border: "rgb(255 255 255 / 0.12)"
  success: "#15803d"
  success-soft: "#f0fdf4"
  danger: "#b91c1c"
  danger-soft: "#fef2f2"
  danger-solid: "#dc2626"
  danger-hover: "#b91c1c"
  danger-active: "#991b1b"
  warning: "#854d0e"
  warning-soft: "#fefce8"
  pending: "#475569"
  pending-soft: "#f1f5f9"
  chart-cpu: "#b45309"
  chart-ram: "#0369a1"
typography:
  headline:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 600
    lineHeight: "2.25rem"
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: "1.75rem"
    letterSpacing: "normal"
  body:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: "1.5rem"
    letterSpacing: "normal"
  body-small:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.25rem"
    letterSpacing: "normal"
  label:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: "1rem"
    letterSpacing: "0.07em"
  mono:
    fontFamily: "JetBrains Mono Variable, JetBrains Mono, monospace"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: "1.25rem"
    letterSpacing: "normal"
rounded:
  small: "0.25rem"
  control: "0.5rem"
  surface: "0.75rem"
  pill: "999px"
spacing:
  compact: "0.375rem"
  control-y: "0.625rem"
  control-x: "1rem"
  surface: "1.5rem"
  section: "1.5rem"
  page-mobile: "1rem"
  page-desktop: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.white}"
    typography: "{typography.body-small}"
    rounded: "{rounded.control}"
    padding: "0.625rem 1rem"
    height: "2.75rem"
  button-outline:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.body-small}"
    rounded: "{rounded.control}"
    padding: "0.625rem 1rem"
    height: "2.75rem"
  input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-small}"
    rounded: "{rounded.control}"
    padding: "0.5625rem 0.75rem"
    height: "2.75rem"
  card:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    padding: "1.5rem"
  nav-active:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.primary}"
    typography: "{typography.body-small}"
    rounded: "{rounded.control}"
    padding: "0.625rem 0.75rem"
    height: "2.75rem"
  badge-success:
    backgroundColor: "{colors.success-soft}"
    textColor: "{colors.success}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0.1875rem 0.5625rem"
---

# Design System: Pingflare

## Overview

**Creative North Star: "The Quiet Watchtower"**

Pingflare is a calm operational vantage point: always alert, never theatrical. The interface uses a restrained, dependable visual vocabulary so self-hosters can scan status, identify risk, and act without decorative noise competing with live system truth.

The system is flat and structural. Hierarchy comes from neutral surface shifts, fine borders, compact spacing, and disciplined typography; Signal Amber is reserved for the active path and decisive actions. Light and dark themes are equally first-class, with the same information hierarchy expressed through paired neutral roles rather than separate visual personalities.

The product should feel calm, precise, and self-possessed. It rejects glossy SaaS spectacle, oversized marketing typography inside the application, and color used without operational meaning.

**Key Characteristics:**

- Status-first information hierarchy
- Flat surfaces separated by fine borders and tonal shifts
- Compact 44px controls with gently curved corners
- Signal Amber used sparingly for action and active state
- Inter for interface clarity; JetBrains Mono for operational data
- Equal visual discipline in light and dark themes

## Colors

The palette combines warm Signal Amber with cool neutral canvases and explicit semantic status colors. Clear Canvas and Deep Watch form the light/dark foundation; neither theme changes the product's emotional temperature.

### Primary

- **Signal Amber:** The primary action and active-navigation color. Its darker steps handle hover and active feedback; its soft tint marks selection without becoming a large decorative field.
- **Dark Signal Amber:** The brighter dark-theme accent used where Deep Watch needs additional contrast. Filled primary controls retain the stable primary fill.

### Neutral

- **Clear Canvas:** The light-theme page and card foundation.
- **Subtle Canvas:** Sidebar, table-header, and hover separation in light mode.
- **Muted Canvas:** Quiet controls, tags, and secondary grouping in light mode.
- **Operational Ink:** Primary text and high-confidence data.
- **Muted Ink:** Supporting labels, metadata, and low-priority navigation.
- **Deep Watch:** The dark-theme page foundation.
- **Night Panel:** The primary raised-tonal surface in dark mode.
- **Fine Border:** Low-contrast structural separation in both themes.

### Secondary

- **Operational Green:** Confirmed healthy and successful state only.
- **Incident Red:** Confirmed failure, destructive action, and blocking error only.
- **Caution Ochre:** Warning state that requires attention without implying failure.
- **Pending Slate:** Unknown, pending, paused, or not-yet-evaluated state.

### Named Rules

**The Signal Economy Rule.** Signal Amber is scarce: use it for the primary action, active location, focus, or a meaningful selected state—not as ambient decoration.

**The Status Truth Rule.** Green, red, caution, and pending colors describe real system state. Never use them decoratively or let color carry status without text or icon support.

## Typography

**Display Font:** Inter Variable (with Inter and system-ui fallbacks)

**Body Font:** Inter Variable (with Inter and system-ui fallbacks)
**Label/Mono Font:** JetBrains Mono Variable (with JetBrains Mono and monospace fallbacks)

**Character:** The pairing is functional and quiet. Inter carries navigation, headings, forms, and explanations; JetBrains Mono is reserved for URLs, percentages, intervals, identifiers, and other values where alignment and technical cadence aid scanning.

### Hierarchy

- **Headline** (600, `1.875rem`, `2.25rem`): Primary page titles on medium and larger screens; tighter tracking adds authority without becoming promotional.
- **Title** (600, `1.125rem`, `1.75rem`): Section titles, card headings, and task-step headings.
- **Body** (400, `1rem`, `1.5rem`): Primary explanatory text and reading content.
- **Body Small** (400, `0.875rem`, `1.25rem`): Dense application copy, metadata, controls, and table content.
- **Label** (600, `0.6875rem`, `0.07em`, uppercase): Compact categorical metadata only; never place it above a heading as an eyebrow.
- **Mono** (500, `0.875rem`, `1.25rem`): Operational values, endpoints, timings, and compact technical evidence.

### Named Rules

**The Operational Readability Rule.** Use mono type for data that benefits from stable character widths, never as a general-purpose technical costume. Everything else stays in Inter.

## Layout

The authenticated application uses a persistent left navigation rail at large breakpoints: `16rem` expanded and `5rem` collapsed. Content occupies the remaining width, with a maximum working canvas of `80rem`. Standard pages use `1rem` horizontal padding on small screens and `2rem` from the medium breakpoint upward; major sections follow a `1.5rem` vertical rhythm.

The density is compact but not cramped. Controls retain a `2.75rem` minimum height, cards usually use `1.5rem` internal padding, and dashboard statistics tighten slightly to `1.25rem 1.5rem`. Repeated data favors tables at large breakpoints and stacked cards on smaller screens.

The responsive model uses familiar transitions rather than shrinking the desktop shell: the sidebar becomes a sticky mobile header and right-side navigation drawer below `1024px`; multi-column dashboard regions collapse to one column; and secondary monitor metrics progressively hide at small widths. The implemented breakpoint vocabulary is `640px`, `768px`, `1024px`, and `1280px`.

## Elevation & Depth

Pingflare is flat by default. Fine borders and surface-tone changes carry almost all hierarchy: Clear Canvas against Subtle Canvas in light mode, and Night Panel against Deep Watch in dark mode. Small shadows are response cues, not decoration—a `0 1px 2px rgb(0 0 0 / 0.12)` shadow grounds filled primary buttons, while stronger depth is reserved for mobile drawers and the blocking loader. Input focus uses a three-pixel tinted halo around the primary border.

### Shadow Vocabulary

- **Control Grounding** (`0 1px 2px rgb(0 0 0 / 0.12)`): Filled primary buttons only.
- **Focus Halo** (`0 0 0 3px color-mix(in srgb, var(--color-primary) 18%, transparent)`): Focused inputs and fields.
- **Blocking Float** (`0 8px 32px rgb(0 0 0 / 0.12)`): The compact loader panel over its blurred scrim.
- **Drawer Lift** (`0 25px 50px -12px rgb(0 0 0 / 0.25)`): Temporary mobile navigation above the application.

### Named Rules

**The Flat-by-Default Rule.** If a border or tonal shift can establish the relationship, do not add a shadow. Elevation belongs to transient layers and focused interaction.

## Shapes

The form language is gently curved and practical. Standard controls and navigation use an `0.5rem` radius; cards, alerts, and major containers use `0.75rem`; compact status marks and simple inline tags may use `0.25rem`; badges use a full pill. Status dots and icon wells are circular when they represent a singular signal.

Borders are thin and low contrast. A component may add one directional accent—such as the three-pixel active-navigation inset or the two-pixel monitor-status rail—but should not stack multiple ornamental outlines. The faint ten-pixel diagonal header pattern is the system's only recurring decorative texture.

## Components

### Buttons

Restrained and dependable: buttons communicate hierarchy through fill, border, and label weight rather than scale.

- **Shape:** Gently curved (`0.5rem`) with a `2.75rem` minimum height and `0.625rem 1rem` standard padding.
- **Primary:** Signal Amber fill, white text, semibold small-body typography, and the Control Grounding shadow.
- **Hover / Focus:** Hover moves to the deeper amber step; keyboard focus uses the global two-pixel outline with a three-pixel offset. State transitions run for `180ms` with standard easing.
- **Outline:** Canvas surface, Fine Border, and Muted Ink; hover shifts to the muted neutral surface and Operational Ink.
- **Ghost:** Transparent at rest with Muted Ink; hover gains only a muted neutral surface.
- **Danger:** Solid incident red with white text; reserve for destructive actions.

### Chips

- **Style:** Full-pill status badges combine a soft semantic background, semantic foreground, and compact label typography. Tags use compact rounded rectangles and either muted-neutral or soft-primary treatment.
- **State:** Status chips must include visible text. A static dot may reinforce the state but cannot replace the label.

### Cards / Containers

- **Corner Style:** Gently curved surfaces (`0.75rem`).
- **Background:** Clear Canvas in light mode and Night Panel in dark mode.
- **Shadow Strategy:** None at rest; use Fine Border and surface contrast.
- **Border:** One-pixel Fine Border, with semantic border emphasis only for actionable risk.
- **Internal Padding:** `1.5rem` standard; `1.25rem 1.5rem` for dense statistic cards.

### Inputs / Fields

- **Style:** Canvas background, Fine Border, `0.5rem` radius, `2.75rem` minimum height, and `0.5625rem 0.75rem` padding.
- **Focus:** Signal Amber border plus the Focus Halo; do not remove the global focus-visible outline from non-input controls.
- **Error / Disabled:** Error copy sits beside the affected field in Incident Red. Disabled controls retain shape and structure while reducing opacity to `0.4`.

### Navigation

Desktop navigation is a vertical labeled list on Subtle Canvas. Default links use Muted Ink; hover adds Muted Canvas and Operational Ink. The active link uses a soft Signal Amber background, Signal Amber text, and a three-pixel inset marker on the leading edge. Collapsed desktop navigation keeps icons with accessible tooltips; mobile navigation becomes a right-side drawer with full labels.

### Monitor Card

The signature operational row is a bordered, linkable card with a two-pixel status rail, a localized status badge, a flexible name-and-tag cluster, and right-aligned mono-friendly metrics. Risk changes the rail and border before it changes layout. Secondary metrics progressively disappear on narrow screens so the monitor name and state remain dominant.

### Alerts and Loading

Alerts use the standard card radius, border, semantic soft background, icon, message, and a labeled recovery or dismissal action. Blocking loading uses a translucent canvas scrim with four-pixel blur and a compact floating panel; this is an exceptional transient layer, not a general surface treatment.

### Freshness Receipt

When a current-status request succeeds, a compact waveform beside the localized timestamp draws once over `480ms` with exponential ease-out. The trace confirms receipt; it never loops, never replaces the timestamp, and collapses to an effectively instant update under reduced motion. Newly inserted alerts and recovery panels use a single `220ms` clipped reveal so state changes feel connected without turning the dashboard into an entrance sequence.

## Do's and Don'ts

### Do:

- **Do** keep operational state, freshness, and required action visually dominant over decoration.
- **Do** use Signal Amber sparingly for primary actions, focus, selection, and active navigation.
- **Do** preserve `2.75rem` minimum interactive height and visible keyboard focus.
- **Do** use neutral surface shifts and one-pixel borders as the default hierarchy mechanism.
- **Do** reserve JetBrains Mono for URLs, identifiers, intervals, percentages, and aligned technical evidence.
- **Do** carry the same semantic hierarchy into dark mode rather than merely inverting colors.

### Don't:

- **Don't** use the legacy `#ff6633` Tailwind-config orange as a new visual source of truth; the rendered system uses Signal Amber.
- **Don't** add glossy gradients, glass surfaces, or broad decorative shadows to routine application UI.
- **Don't** use success, danger, warning, or pending colors without genuine system meaning and a non-color cue.
- **Don't** introduce oversized marketing headlines or a separate display typeface inside the authenticated application.
- **Don't** place shadows on every card; reserve elevation for transient layers and interaction response.
- **Don't** replace labeled operational actions with unexplained icon-only controls.
