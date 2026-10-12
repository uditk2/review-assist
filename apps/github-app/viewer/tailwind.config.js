/** @type {import('tailwindcss').Config} */
// Colors are driven by CSS variables defined in src/brand.css (light + dark).
// Keep values as var() references so every utility follows the active theme.
export default {
  content: ["./index.html"],
  theme: {
    colors: {
      transparent: "transparent",
      current: "currentColor",
      white: "#ffffff",
      canvas: "var(--canvas)",
      surface: "var(--surface)",
      ink: {
        50: "var(--ink-50)",
        100: "var(--ink-100)",
        200: "var(--ink-200)",
        300: "var(--ink-300)",
        400: "var(--ink-400)",
        500: "var(--ink-500)",
        600: "var(--ink-600)",
        700: "var(--ink-700)",
        800: "var(--ink-800)",
        900: "var(--ink-900)",
      },
      accent: {
        50: "var(--accent-50)",
        100: "var(--accent-100)",
        600: "var(--accent-600)",
        700: "var(--accent-700)",
        fg: "var(--accent-fg)",
      },
      ok: {
        fg: "var(--ok-fg)",
        bg: "var(--ok-bg)",
        line: "var(--ok-line)",
        border: "var(--ok-border)",
        strong: "var(--ok-strong)",
      },
      danger: {
        fg: "var(--danger-fg)",
        bg: "var(--danger-bg)",
        line: "var(--danger-line)",
      },
      warn: {
        fg: "var(--warn-fg)",
        bg: "var(--warn-bg)",
        border: "var(--warn-border)",
      },
    },
    // The only sizes available: each is a token from src/brand.css, with Carbon's line height
    // for that step. Defined at the theme level rather than under `extend`, so Tailwind's
    // default scale (text-xs, text-lg, ...) is not generated and cannot drift in beside it.
    fontSize: {
      micro: ["var(--text-micro)", { lineHeight: "1.33" }],
      sm: ["var(--text-sm)", { lineHeight: "1.43" }],
      base: ["var(--text-base)", { lineHeight: "1.5" }],
      title: ["var(--text-title)", { lineHeight: "1.4" }],
      heading: ["var(--text-heading)", { lineHeight: "1.29" }],
      display: ["var(--text-display)", { lineHeight: "1.2" }],
      hero: ["var(--text-hero)", { lineHeight: "1.2" }],
    },
    fontFamily: {
      sans: ['"IBM Plex Sans"', "system-ui", "sans-serif"],
      mono: ['"IBM Plex Mono"', "ui-monospace", "monospace"],
    },
    extend: {
      borderRadius: { md: "6px" },
      maxWidth: { prose: "72ch" },
    },
  },
  plugins: [],
};
