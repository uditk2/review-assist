import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

/**
 * The MCP server imports its role prose as text — the build does that with esbuild's
 * `--loader:.md=text --loader:.toml=text`, which keeps the prose in real files instead
 * of string literals in TypeScript. Vitest has no equivalent flag, so without this
 * `roles.ts` cannot be imported under test at all, and the role definitions stay
 * untested precisely because they were factored out properly.
 */
const textLoader: Plugin = {
  name: "review-assist:text-loader",
  enforce: "pre",
  transform(_code, id) {
    const path = id.split("?")[0];
    if (!/\.(md|toml)$/.test(path)) return null;
    return { code: `export default ${JSON.stringify(readFileSync(path, "utf8"))};`, map: null };
  },
};

export default defineConfig({
  plugins: [textLoader],
  test: {
    include: ["packages/**/test/**/*.test.ts"],
  },
});
