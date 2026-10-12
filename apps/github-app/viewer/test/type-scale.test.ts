/**
 * One type scale. Every font size comes from the seven tokens in src/brand.css, through the
 * Tailwind utilities mapped to them in tailwind.config.js. Before this, the viewer used
 * about 37 sizes, set one element at a time, and related text drifted apart (a 13px
 * outcome under a 15px title beside an 18px problem statement).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const VIEWER = fileURLToPath(new URL("..", import.meta.url));
const read = (f: string) => readFileSync(VIEWER + f, "utf8");
const sources: Record<string, string> = { "index.html": read("index.html"), "src/theme.css": read("src/theme.css") };

describe("the type scale", () => {
  it("is seven sizes, defined once in brand.css", () => {
    const tokens = read("src/brand.css").match(/--text-[a-z-]+(?=:)/g) ?? [];
    expect(new Set(tokens).size).toBe(7);
    expect(tokens.length).toBe(7);
  });

  for (const [file, src] of Object.entries(sources)) {
    it(`${file} sets no one-off font size`, () => {
      expect(src.match(/text-\[\d[^\]]*\]/g) ?? []).toEqual([]);
      expect(src.match(/font-size\s*:/g) ?? []).toEqual([]);
    });

    it(`${file} uses no size outside the scale`, () => {
      // Tailwind's default steps are not generated (the scale replaces them), so one of
      // these would silently render at the inherited size.
      expect(src.match(/\btext-(xs|lg|[2-9]?xl)\b/g) ?? []).toEqual([]);
    });
  }
});
