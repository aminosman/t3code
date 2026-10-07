# The phone's design system (Granola)

The home pager (Meetings, Home, Chats) and the meeting pages are drawn in
Granola's design: its palette ("oats", from granola.ai's own stylesheet), its
type pairing, its radii and its 4-point grid, read off its desktop app and the
iPhone screenshots on its App Store page (Oct 2026). Roost's web Meetings pages
use the same values (`apps/web/src/index.css`, `.meetings-surface`).

Build new screens here from `granola.tsx` and these tokens only. If something
needs a value that is not below, add it here first.

## Colour — `gr-*` tokens

Defined in `scripts/generate-uniwind-themes.mts` (light and dark) and used as
classes: `bg-gr-surface`, `text-gr-ink-2`, `border-gr-hairline`,
`accent-gr-ink` (icon tint).

| Token                             | Use                                                |
| --------------------------------- | -------------------------------------------------- |
| `gr-surface`                      | the page                                           |
| `gr-sunken`                       | tracks, pressed rows, quote boxes                  |
| `gr-raised`                       | cards, inputs, round buttons, the tab capsule      |
| `gr-ink`                          | titles, text the user wrote                        |
| `gr-ink-2` / `gr-ink-2-strong`    | secondary text, meta, model text / labels on chips |
| `gr-ink-3`                        | placeholders, counts, ages                         |
| `gr-hairline`                     | every border (warm, ~16% olive-black)              |
| `gr-accent` / `gr-accent-tint`    | working, live, toggles / its soft fill             |
| `gr-bars`                         | recording level bars                               |
| `gr-attention` / `-tint`          | needs you                                          |
| `gr-danger` / `-tint`             | failed, recording, delete                          |
| `gr-button` / `gr-button-ink`     | primary capsules (Granola's black "Start now")     |
| `gr-bubble-them` / `gr-bubble-me` | transcript bubbles                                 |

Statuses: working = accent, needs you = attention, failed = danger, done and
stopped = ink-3.

## Type

- Titles are serif (`SERIF`: New York on iOS): page title 30/36, meeting
  title 28/34, card title 15.5–16/19–20, note headings 19.
- Everything else is the app's sans: body 16/24, row title 15, label 14,
  meta 12–13, micro 11.
- Section labels are sentence case ("Needs you"), never upper case.

## Space and shape

- **One page margin: 20** (`GUTTER`) for headers, section labels, the first
  card of a row, list rows and input surfaces.
- **Grid of 4** (`SPACE`): 4, 8, 12, 16, 20, 24, 32.
- **Radii** (`RADIUS`): 8 tiles and small controls, **12 cards and every input**
  (composer, ask box, search), 16 panels; chips, buttons and the tab capsule
  are full capsules.
- Floating things (round buttons, inputs, the tab capsule) carry
  `FLOAT_SHADOW`; cards on the page carry only the hairline.

## Pages

- `GrPage`: the header stays put; only the body scrolls.
- `GrHeader`: eyebrow (13, ink-2), serif title, actions as `GrIconButton`s
  (round 40, raised) on the right, an optional row below (search).
- The tab capsule floats just over the home indicator; inputs sit 8 above it.

## Parts

`GrSectionLabel`, `GrCard`, `GrChip` (outline capsule, 32 tall), `GrButton`
(primary / secondary capsule, 40 tall), `GrSegments` (white on a sunken
track), `GrInputSurface`, `GrTile` (pastel tile with a serif initial, 28).
