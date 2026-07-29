/**
 * Assert the cross-file invariants a release depends on.
 *
 * This does NOT re-check what sync-version.mjs already derives — CI runs the build and
 * then fails on any resulting diff, which proves the generated files are committed and
 * current. What it checks is the things no generator owns: identifiers that must agree
 * across files, and the absence of a hand-written version literal that would drift.
 *
 * Both of the release bugs this repo hit were of that kind. server.json advertised a
 * version sync-version did not know it owned, and the registry's required mcpName was
 * missing entirely. A "did you run the generator" hook catches neither.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));

const pkg = read("packages/mcp-server/package.json");
const manifest = read("packages/mcp-server/manifest.json");
const server = read("server.json");
const index = readFileSync(join(root, "packages/mcp-server/src/index.ts"), "utf8");

const problems = [];
const eq = (a, b, what) => a === b || problems.push(`${what}: ${a} !== ${b}`);

eq(manifest.version, pkg.version, "manifest.json version vs package.json");
eq(server.version, pkg.version, "server.json version vs package.json");
for (const p of server.packages ?? []) {
  if (p.registryType === "npm") {
    eq(p.version, pkg.version, "server.json npm package version vs package.json");
    eq(p.identifier, pkg.name, "server.json npm identifier vs package name");
  }
}

// The registry verifies ownership by matching this against the published package.
eq(pkg.mcpName, server.name, "package.json mcpName vs server.json name");
if (!/^io\.github\.[^/]+\/.+/.test(server.name ?? "")) {
  problems.push(`server.json name must be io.github.<owner>/<server>, got ${server.name}`);
}

// SERVER_VERSION must stay derived. A literal here is exactly how 0.2.2 shipped
// reporting 0.2.1.
if (/SERVER_VERSION[^=]*=\s*"/.test(index)) {
  problems.push("SERVER_VERSION is a hard-coded literal; it must be read from package.json");
}

// Every tool the server registers must be declared in the .mcpb manifest, or clients
// show a short list. The manifest said eight while the server registered ten.
const registered = [...index.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
const declared = new Set((manifest.tools ?? []).map((t) => t.name));
const undeclared = registered.filter((t) => !declared.has(t));
const phantom = [...declared].filter((t) => !registered.includes(t));
if (undeclared.length) problems.push(`tools registered but missing from manifest: ${undeclared.join(", ")}`);
if (phantom.length) problems.push(`tools in manifest that the server does not register: ${phantom.join(", ")}`);

if (problems.length) {
  console.error("release consistency check failed:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(`release consistency ok — ${pkg.version}, ${registered.length} tools, ${server.name}`);
