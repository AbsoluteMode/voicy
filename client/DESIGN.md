# Voicy design book

> **Temporary draft.** Written alongside the profile customization work and
> likely to change: treat it as a working reference, not a settled spec.

What the app looks like and why, so new screens and art fit in without
guessing. Everything here is already in `src/styles.css` and
`src/components/icons.tsx`; this file names the rules behind them.

## Character

A quiet, near-black room where the only loud thing is the voice. Voicy
does not decorate its chrome: surfaces are flat and dark, text is plain,
and color is spent on one thing at a time — who is talking, what is
selected, what needs a click.

The brand mark is a sound wave (`Logo`): one thick line, round caps, a
dip and a rise. Waves, levels and rings that react to the voice are the
app's own motifs; reach for them before anything borrowed.

## Color

| Token | Value | Use |
|---|---|---|
| `--bg` | `#09090b` | window, inputs |
| `--surface` | `#111113` | the main panel |
| `--panel` / `--panel-2` | `#17171a` / `#1f1f24` | dialogs, menus, buttons |
| `--line` / `--line-soft` | `#26262b` / `#1f1f24` | 1 px borders, dividers |
| `--text` / `--muted` / `--faint` | `#f4f4f5` / `#b6b6be` / `#9a9aa4` | three steps of text, no more |
| `--accent` | `#c6f36b` | the voice, the selection, the go button |
| `--accent-ink` | `#09090b` | text on the accent |
| `--warn`, `--danger` | `#ff8b5e`, `#e5484d` | muted mic, leaving, deleting |

- One accent per view. Lime marks *live* things (speaking, selected,
  primary action); it is never a background for large areas, only
  10–20 % tints of it (`color-mix(in oklch, var(--accent) 14%, transparent)`).
- The primary button is white on black (`.btn.primary`), not lime: lime is
  kept for "go" moments (join, update).
- Member colors (name color, the glow while talking) replace the accent
  *for that member only*.

## Type

- UI: Segoe UI Variable Text, Display for titles (`--ui`, `--display`).
  It is hinted for ClearType and stays crisp at 12–14 px on Windows,
  which web fonts do not.
- Mono: Cascadia Mono (`--mono`) for codes, links, logs and tiny status.
- Section labels: 12 px, 600, uppercase, `.05em` tracking, `--faint`
  (`.sec-label`, `.field > span`, `.set-section h3`).
- Body 14 px; hints 12.5 px in `--faint`; titles 18–19 px, slightly
  negative tracking.
- Display fonts belong to members (their names), never to the chrome.

## Shape and space

- Radii: 8 (small controls), 10 (buttons, inputs), 12 (rows, menus),
  16 (cards, the main panel), 22 (dialogs). Pills for chips and small
  header buttons.
- Borders are 1 px `--line`; cards are `rgba(255,255,255,.025)` with a
  border, not a shadow. Shadows only on things that float (dialogs,
  menus, the dock, the drag ghost).
- Rows: 52 px in a call, 38 px otherwise; 10–14 px side padding; hover is
  `rgba(255,255,255,.04)`, never a border.
- The main panel has a faint 18 px dot grid, lit in lime under the
  cursor. Previews of "how you look in a room" sit on that grid.

## Icons

Voicy's own glyphs are **filled shapes with cut-out details**: a solid
body in `currentColor`, details punched out in `--cut` (the color of the
surface underneath). No outlines-only icons in the main controls; Lucide
line icons are fine in menus and dialogs.

## Motion

- Short and springy: 120–160 ms for color, 220–280 ms for dialogs
  (`cubic-bezier(.2, .9, .3, 1.15)` pops, `.2, .9, .25, 1` sheets).
- The voice drives motion: `--level` (0..1, 20 times a second) grows the
  speaking ring and lights the level segments. Things that move on their
  own are rare and slow (the update button's glow).
- Anything decorative that loops holds still in lists and moves only
  while its owner talks or is hovered. `prefers-reduced-motion` stops it.

## Decoration art

Avatar decorations are drawn here, in one style, as SVG
(`src/components/decorations.tsx`):

- **Sticker style**: flat fills in two or three tones (base, shade, one
  highlight), every piece outlined in `#0b0b0e` at 2.4 units so it reads
  on any picture and any background. No gradients except glow and fire.
- Details are cut out, like the icons: gems, dots, grilles are holes or
  dark insets, not extra colors.
- Canvas: `viewBox="0 0 120 120"`, the avatar is the circle
  `cx=60 cy=60 r=50` — Discord's layout, a square 1.2 times the avatar.
  Pieces hug that circle; they may cover its rim, never its middle
  third, where the face is.
- Palette per piece: at most three hues plus the outline; warm pieces
  (gold, flame) use `#ffd84d`/`#ffab3d`/`#ff6b3d`, cool ones
  `#9fe8ff`/`#5ec4f0`, and `var(--c1)` wherever the member's own color
  belongs (cat ears, the equalizer, headphones).
- Motion comes from the voice first (the equalizer, the headphone
  waves), then from small loops: a flicker, a sway, a spin — never more
  than a few pixels of travel at 34 px.
- Check every decoration at 34 px (a call row), 26 px (lists) and 72 px
  (the profile card) before shipping it.
