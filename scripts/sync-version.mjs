/**
 * One version, three files.
 *
 * packages/mcp-server/package.json is the source of truth (it is what `npm version`
 * bumps). src/index.ts reads it directly, so the only copy that cannot be derived at
 * runtime is manifest.json: the .mcpb format requires a literal version in the file.
 * This regenerates it, so a release can never ship an extension whose manifest
 * disagrees with the package it wraps.
 *
 * Runs as part of the mcp-server build, which `prepublishOnly` re-runs after the
 * version bump, so publish and `mcpb pack` both see the correct value.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(root, "packages/mcp-server/package.json");
const version = JSON.parse(readFileSync(pkgPath, "utf8")).version;

const manifestPath = join(root, "packages/mcp-server/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.version !== version) {
  manifest.version = version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

console.log(`sync-version: ${version}`);
