/**
 * Refresh the generated parts of the Claude Code plugin in plugins/review-assist/ from the
 * server build. Run after `npm run build`; the release workflow runs it for every release.
 *
 *   server/dist/index.js  the built server, copied as is. One file: esbuild bundles every
 *                         dependency into it, so the plugin installs nothing.
 *   server/package.json   beside it, for two things the bundle needs at runtime: the server
 *                         reads its version from ../package.json, and Node needs
 *                         "type": "module" to load the bundle as ESM. Kept in server/ rather
 *                         than the plugin root, where a package.json reads as dependencies
 *                         to install. The .mcpb bundle is laid out the same way.
 *   agents/*.md           the two roles, rendered by the server itself from the same prose
 *                         as every other client's, with the tool names a plugin's tools get.
 *   plugin.json version   the server's version, so the plugin and npm never disagree.
 *
 * Everything else in the folder (README, PRIVACY, TERMS, the skill, .mcp.json) is written
 * by hand and left alone.
 *
 *   node scripts/build-plugin.mjs             take the bundle from this checkout's build
 *   node scripts/build-plugin.mjs --from-npm  take it from the version published on npm
 *
 * Use --from-npm anywhere but a clean CI checkout. esbuild names each bundled module by its
 * path, so a build whose node_modules lives elsewhere (a worktree borrowing another
 * checkout's, say) writes absolute paths from that machine into a file the plugin then
 * publishes. The npm package is built in CI from a fresh `npm ci`, so it has neither the
 * paths nor any drift from what users of the npm package run.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = join(root, "plugins/review-assist");
const pkg = JSON.parse(readFileSync(join(root, "packages/mcp-server/package.json"), "utf8"));

let bundle = join(root, "packages/mcp-server/dist/index.js");
let scratch;
if (process.argv.includes("--from-npm")) {
  scratch = mkdtempSync(join(tmpdir(), "build-plugin-"));
  execFileSync("npm", ["pack", `${pkg.name}@${pkg.version}`, "--silent"], { cwd: scratch, stdio: "ignore" });
  execFileSync("tar", ["xzf", `${pkg.name}-${pkg.version}.tgz`], { cwd: scratch });
  bundle = join(scratch, "package/dist/index.js");
}

if (!existsSync(bundle)) {
  console.error(`build-plugin: no server bundle at ${bundle}; run \`npm run build\` first, or pass --from-npm`);
  process.exit(1);
}
const leaked = readFileSync(bundle, "utf8").match(/\/(?:Users|home)\/[^/\s"]+\//);
if (leaked) {
  console.error(`build-plugin: the bundle names a home directory (${leaked[0]}); build in a clean checkout or pass --from-npm`);
  process.exit(1);
}

mkdirSync(join(plugin, "server/dist"), { recursive: true });
copyFileSync(bundle, join(plugin, "server/dist/index.js"));
writeFileSync(
  join(plugin, "server/package.json"),
  JSON.stringify(
    { name: pkg.name, version: pkg.version, private: true, type: "module", license: pkg.license },
    null,
    2
  ) + "\n"
);

execFileSync(process.execPath, [bundle, "plugin-agents", join(plugin, "agents")], { stdio: "ignore" });
if (scratch) rmSync(scratch, { recursive: true, force: true });

const manifestPath = join(plugin, ".claude-plugin/plugin.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.version !== pkg.version) {
  manifest.version = pkg.version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

console.log(`build-plugin: plugins/review-assist at ${pkg.version}`);
