/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html"],
  theme: {
    // Warm-neutral base (stone) + a single considered blue accent. No purple anywhere.
    colors: {
      transparent: "transparent",
      current: "currentColor",
      white: "#ffffff",
      canvas: "#fbfaf9",
      ink: {
        50: "#f7f6f5",
        100: "#efedeb",
        200: "#e4e1de",
        300: "#d3cfcb",
        400: "#a8a29e",
        500: "#78716c",
        600: "#57534e",
        700: "#44403c",
        800: "#292524",
        900: "#1c1917",
      },
      accent: {
        50: "#eff5fd",
        100: "#dbe8fb",
        600: "#0a6ae0",
        700: "#0857b8",
      },
      ok: { fg: "#1a7f37", bg: "#e6f4ea", line: "#e6ffec", strong: "#116329" },
      danger: { fg: "#cf222e", bg: "#ffebe9", line: "#ffdcd7" },
      warn: { fg: "#8a6100", bg: "#fff8c5", border: "#e6c34a" },
    },
    fontFamily: {
      sans: ['"IBM Plex Sans"', "system-ui", "sans-serif"],
      mono: ['"IBM Plex Mono"', "ui-monospace", "monospace"],
    },
    extend: {
      borderRadius: { md: "6px" },
      maxWidth: { prose: "72ch" },
      fontSize: {
        micro: ["0.75rem", { lineHeight: "1rem" }],
        sm: ["0.8125rem", { lineHeight: "1.25rem" }],
        base: ["0.9375rem", { lineHeight: "1.6" }],
      },
    },
  },
  plugins: [],
};
