# Decorations

Each file here is one avatar decoration. The file name is its id (what the
server stores), so never rename a shipped one. `src/lib/deco.ts` turns the
files into SVG when the app starts; a file that does not parse is left out
and its error goes to the console.

Draw them in the style of `DESIGN.md` ("Decoration art"): flat fills in
two or three tones, a dark outline on every piece, details cut out.

## Layout of a `.deco` file

```
// Comments start with two slashes (in the header).
name: Корона          // shown in the picker
order: 40             // place in the picker, smaller first
$gold: #ffd84d        // colors, used as $gold below
$me: #c6f36b          // fallback for the member's own color
---
<g transform="translate(74 3) rotate(20)">
  <path d="…" fill="$gold" outline/>
</g>
```

Below `---` is SVG for a **120 × 120 canvas**; the avatar is the circle
`(60, 60) r 50`, Discord's layout (a square 1.2 times the avatar). Keep the
middle of the circle clear: that is where the face is. `<!-- … -->`
comments work there.

## Colors

- `$ink` — the outline color, in every file.
- `$me` — the member's own color (their name color), falling back to the
  file's `$me` or voicy's lime.
- Anything else you declare in the header.

## Additions to SVG

| Write | Get |
|---|---|
| `outline` on any shape | the standard ink outline, 2.4 wide; `outline="1.6"` for another width |
| `anim="sway"`, `delay=".3"` | one of the loops in `styles.css` (`bob sway pulse twinkle flicker twitch flap-l flap-r fall rise blink`), which run only while the owner talks or is hovered |
| `@(deg, r)` in any value | the point `x y` on a circle around the avatar center, 0° up, clockwise |
| `{expr}` in any value | arithmetic on numbers and parameters: `{r * 0.52}`, `{-w/2}` |
| `<band d="…" color="…" width="3"/>` | a thick outlined stroke |
| `<pair>…</pair>` | the drawing plus its mirror image (left and right ears) |
| `<mirror>…</mirror>` | only the mirror image |
| `<sticker>…</sticker>` | one outline around everything inside, not one per piece |
| `<ring n="5" around="x y" turn="10" span="120">…</ring>` | `n` copies turned around a point (the avatar center by default), over the whole circle or over `span` degrees from `turn`; `{i}` and CSS `--i` are the copy's number |
| `<text>30</text>` | text as in SVG; a shipped font (`Unbounded`, `Press Start 2P`…) loads when it is used |
| `<blob points="x y x y …"/>` | a smooth closed shape through the points |
| `<glint x y r delay color/>` | a twinkling four-point star |
| `<pixels x y size fill light dark>` rows `</pixels>` | pixel art with an outline: `X` fill, `o` light, `d` dark, `.` empty |
| `<define name="petal" params="turn=0">…</define>` | a template; `<petal x="6" y="72"/>` draws it with those parameters |

Voice-driven parts: CSS `--level` (0..1) is the owner's loudness, and the
classes `voice` (fades in with the voice), `eqbar` (grows with it) and
`mana` (drains with it) are styled in `styles.css`, as is `glow` (a soft
halo in the color of `--glow`).

Check a new decoration at 26, 34 and 72 px before committing it.
