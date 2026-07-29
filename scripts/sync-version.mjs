/**
 * One version, three files.
 *
 * packages/mcp-server/package.json is the source of truth (it is what `npm version`
 * bumps). src/index.ts reads it directly, so the copies that cannot be derived at
 * runtime are manifest.json (the .mcpb format requires a literal version) and
 * server.json (the MCP registry manifest). This regenerates both, so a release can never ship an extension whose manifest
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

// server.json is the official MCP registry manifest. It carries the version twice — the
// server entry and the npm package entry — and both must match what is actually on npm,
// or the registry advertises a version nobody can install.
const serverPath = join(root, "server.json");
const server = JSON.parse(readFileSync(serverPath, "utf8"));
let serverChanged = false;
if (server.version !== version) {
  server.version = version;
  serverChanged = true;
}
for (const pkg of server.packages ?? []) {
  if (pkg.registryType === "npm" && pkg.version !== version) {
    pkg.version = version;
    serverChanged = true;
  }
}
if (serverChanged) writeFileSync(serverPath, JSON.stringify(server, null, 2) + "\n");

console.log(`sync-version: ${version}`);
