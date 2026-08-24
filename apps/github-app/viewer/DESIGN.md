# Viewer design notes

The viewer must read as a serious developer tool, not a generated demo. This file records
the AI-"slop" tells we deliberately avoid and the rules we follow, so the look doesn't
regress. Sources reviewed: Developers Digest "16 patterns", DEV "catalogue of tells",
prg.sh "purple gradient", 925studios "AI slop tells".

## Banned (documented AI tells) — do not reintroduce

Color
- The AI purples: indigo `#4F46E5`, Linear-ish `#5E6AD2`, "VibeCode" lavender. No purple/violet accent at all.
- Gradient headlines and gradient fills for decoration.
- Colored glows / brand-colored `box-shadow`.
- Rainbow status: a differently-colored badge/dot for every row, including neutral states.
- Four different accent colors in one screen. We use ONE accent (blue) + semantic-only red/green/amber.
- Pure `#000` on pure `#fff`.

Type
- Inter (the single most common tell), plus Geist / Space Grotesk / Instrument Serif.
- Serif-italic single-word accents inside a sans layout.
- Body type below the screen's floor (no 14px body on wide screens).
- ALL-CAPS overlines / section labels.

Layout & components
- Permanent dark mode with medium-grey body text. (We default to light.)
- Centered hero + centered sans headline; small colored "badge above the H1".
- Colored top/left card borders (3–4px accent edges).
- Icon-top feature cards; identical repeated modules (4 KPI cards, 3 pricing columns).
- Emoji used as UI icons or nav icons.
- shadcn/ui *default* theme (zinc + default radius) leaking through — a known tell. If a
  primitive is shadcn-shaped, it must be fully re-themed.
- Glassmorphism / frosted glass.
- Gen-two tells (also avoid): ghost index numbers `01 · 02 · 03`, uppercase overline +
  giant number cards, text-left/visual-right hero with dual pill CTAs.

## Rules we follow

- **One accent** (a considered blue, `#0a6ae0`), used only for interaction and the current
  item. Neutral states are grey. Color carries meaning (add/remove/warn), never decoration.
- **Light theme** on a warm-neutral canvas (`stone`), near-black text (`#1c1917`), AA contrast.
- **Borders, not shadows.** Elevation is a 1px border + a faint surface shift. No `box-shadow`.
- **Type**: IBM Plex Sans (UI) + IBM Plex Mono (code/IDs). 15–16px body, 1.6 line-height.
  Deliberate scale; headings by weight, not size alone.
- **Spacing**: 4px base grid, generous; measure capped ~72ch for prose.
- **Radius**: 6px (`rounded-md`). No pills for buttons; no fully-round chips.
- **Labels are plain and functional**: "Overview", "Walkthrough", "Reviewer note",
  "Uncovered changes", "Accept / Flag" — no "Start here ✨", no emoji.
- **Vary anatomy**: the overview, a walkthrough stop, and the verification page are laid
  out differently on purpose; nothing is a repeated identical module.
- **Instrument register, held to three devices.** The product should read like a measuring
  instrument, not a spaceship. Exactly three moves carry that, and no more may be added
  without removing one: (1) structural labels in mono — eyebrows, nav, tags, ordinals
  (`01`, `02`) — so a readout is distinguishable from prose without a colour or a weight;
  (2) a 20px accent tick at the head of each section rule (`.section-h`), a scale mark, not
  a coloured card edge; (3) a hairline grid behind page mastheads only (`.grid-field`),
  1px lines at ~5% alpha on a 28px pitch, masked on both axes so it has no hard edge on
  any side and fades out before the content. Never behind a diff, and never at an alpha
  where it reads as a graphic. It marks a page's *entry point* — the landing hero, the
  releases index, a release post, the document overview — not every tab: landing on
  Verification or Uncovered changes mid-review is not an arrival. Light and dark carry
  differently at equal alpha, so the two palettes are set to different values and matched
  by eye (ΔL* ≈ 4.3 and 4.8), not by number.
- **Still banned, and the grid does not reopen them**: glows, gradient fills as decoration,
  neon, glassmorphism, scanline animation, monospace body copy, a terminal-green accent.
- **Marketing pages obey the same rules as the tool.** The landing page and the release
  notes share the tool's header, type and palette — no separate marketing skin. Sections
  vary anatomy on purpose (numbered steps, definition rows, plain prose, a linked list of
  releases); nothing is a grid of identical cards, and nothing is an icon-topped feature
  tile.
- **Release notes say what broke and why.** Each entry is the fix plus its rationale, in
  the same register as a commit message here. No changelog bullets without reasons, no
  "improvements and bug fixes".
- Styling comes from a Tailwind theme (tokens in `tailwind.config.js`), not ad-hoc CSS.
- **Theme tokens live in `src/brand.css`** as CSS variables, with a light and a dark
  palette. Dark follows the OS `prefers-color-scheme` and can be overridden by the header
  toggle (`data-theme`). Tailwind color names map to these variables, so both modes stay
  in sync from one source. Semantic colors (add/remove/caution) keep their meaning in dark.
