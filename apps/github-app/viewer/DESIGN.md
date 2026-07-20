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
- Styling comes from a Tailwind theme (tokens in `tailwind.config.js`), not ad-hoc CSS.
