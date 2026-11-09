/**
 * Build the server into dist/: index.js plus a few chunks beside it, every file under 256 KiB.
 *
 * Why not one file: Anthropic's plugin directory reads every file in a plugin before it
 * publishes a version, and holds any file that isn't an image or font at 256 KiB or more for a
 * human ("Files or downloads the validator couldn't inspect"). One bundle of the server and its
 * dependencies is about 985 KiB, so the build splits it along package lines, and fails rather
 * than produce a file the directory cannot read. npm, the .mcpb and the plugin all ship this
 * same dist/.
 *
 * esbuild has no manual chunks, but code reached from more than one entry point goes into a
 * shared chunk, one chunk per distinct set of entry points. So each group in CHUNKS gets a stub
 * entry point that imports the group's files, and a file lands in a chunk with the other files
 * the same stubs reach. The stubs import only files a plain build already keeps, so they never
 * add code; they are dropped before anything is written, and nothing imports them.
 *
 *   node build.mjs           build into dist/
 *   node build.mjs --report  also print each file's size and what is in it
 */
import * as esbuild from "esbuild";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/** The directory's limit is "under 256 KiB" for every file that isn't an image or font. */
const FILE_LIMIT = 256 * 1024;

/**
 * Chunk groups, matched in order against each bundled file's path as esbuild reports it
 * (relative to this package). A file no group matches stays in index.js. When the build says a
 * file is over the limit, split its biggest group in two here.
 */
const CHUNKS = [
  ["zod-v3", /node_modules\/zod\/(?:v3\/|index\.js$)/],
  ["zod-v4", /node_modules\/zod\/v4\//],
  ["ajv-vocabularies", /node_modules\/ajv\/dist\/(?:vocabularies|refs)\//],
  ["ajv", /node_modules\/(?:ajv|ajv-formats|fast-uri|json-schema-traverse|fast-deep-equal)\//],
  ["mcp-sdk", /node_modules\/(?:@modelcontextprotocol\/sdk|zod-to-json-schema)\//],
  ["validator", /^\.\.\/(?:validator|schema)\/dist\//],
  ["roles", /^(?:agents\/|src\/roles\.ts$)/],
];

const outdir = "dist";
const options = {
  entryPoints: [{ in: "src/index.ts", out: "index" }],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  loader: { ".md": "text", ".toml": "text" },
  logLevel: "warning",
  metafile: true,
  write: false,
};

// Pass 1: the files a plain build keeps, after tree-shaking.
const plain = await esbuild.build({ ...options, outfile: "index.js", entryPoints: ["src/index.ts"] });
const kept = Object.keys(Object.values(plain.metafile.outputs)[0].inputs);
const groupOf = (file) => CHUNKS.find(([, pattern]) => pattern.test(file))?.[0];
const members = new Map(CHUNKS.map(([name]) => [name, kept.filter((f) => groupOf(f) === name)]));
for (const [name, files] of members) {
  if (files.length === 0) throw new Error(`build: chunk group "${name}" matches no bundled file; fix its pattern`);
}

// Pass 2: the same build with one stub entry point per group.
const STUB = "chunk-group:";
const result = await esbuild.build({
  ...options,
  entryPoints: [...options.entryPoints, ...CHUNKS.map(([name]) => ({ in: STUB + name, out: `stub-${name}` }))],
  splitting: true,
  outdir,
  chunkNames: "chunk-[hash]",
  // Importing a module of a "sideEffects": false package for nothing but its place in the
  // graph is the point of a stub, not a mistake.
  logOverride: { "ignored-bare-import": "silent" },
  plugins: [
    {
      name: "chunk-groups",
      setup(build) {
        build.onResolve({ filter: new RegExp(`^${STUB}`) }, (args) => ({
          path: args.path.slice(STUB.length),
          namespace: "chunk-group",
        }));
        build.onLoad({ filter: /.*/, namespace: "chunk-group" }, (args) => ({
          contents: members.get(args.path).map((f) => `import ${JSON.stringify(resolve(f))};`).join("\n"),
          resolveDir: process.cwd(),
          loader: "js",
        }));
      },
    },
  ],
});

// Name each chunk after the group with the most code in it, biggest chunk first, so a name
// stays put from one release to the next unless the split itself changes.
const outputs = Object.entries(result.metafile.outputs).map(([path, meta]) => ({ path, meta, file: basename(path) }));
const chunks = outputs.filter((o) => !o.meta.entryPoint).sort((a, b) => b.meta.bytes - a.meta.bytes);
const rename = new Map();
for (const chunk of chunks) {
  const bytes = new Map();
  for (const [input, { bytesInOutput }] of Object.entries(chunk.meta.inputs)) {
    const group = groupOf(input) ?? "shared";
    bytes.set(group, (bytes.get(group) ?? 0) + bytesInOutput);
  }
  const base = [...bytes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "runtime";
  let name = base;
  for (let n = 2; name === "index" || [...rename.values()].includes(`${name}.js`); n++) name = `${base}-${n}`;
  rename.set(chunk.file, `${name}.js`);
}

const files = [];
for (const out of result.outputFiles) {
  const meta = outputs.find((o) => resolve(o.path) === out.path);
  if (meta.meta.entryPoint?.startsWith(STUB)) continue;
  let text = out.text;
  for (const [from, to] of rename) text = text.replaceAll(`"./${from}"`, `"./${to}"`);
  files.push({ name: rename.get(meta.file) ?? meta.file, text, meta: meta.meta });
}

// Every chunk must be reachable from index.js; a renamed import that missed would leave one
// orphaned, and the server would fail to start on a missing file.
const index = files.find((f) => f.name === "index.js");
const imported = new Set([...files.flatMap((f) => [...f.text.matchAll(/from "\.\/([^"]+)"|import "\.\/([^"]+)"/g)].map((m) => m[1] ?? m[2]))]);
for (const f of files) {
  if (f !== index && !imported.has(f.name)) throw new Error(`build: ${f.name} is not imported by anything`);
}
for (const name of imported) {
  if (!files.some((f) => f.name === name)) throw new Error(`build: something imports ./${name}, which was not written`);
}

const over = files.filter((f) => Buffer.byteLength(f.text) >= FILE_LIMIT);
if (over.length > 0) {
  for (const f of over) {
    const top = Object.entries(f.meta.inputs).sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput).slice(0, 5);
    console.error(`build: dist/${f.name} is ${Buffer.byteLength(f.text)} bytes, over the plugin directory's ${FILE_LIMIT}. Biggest inputs:`);
    for (const [input, { bytesInOutput }] of top) console.error(`  ${String(bytesInOutput).padStart(8)}  ${input}`);
  }
  console.error("build: split the group these belong to in CHUNKS (packages/mcp-server/build.mjs).");
  process.exit(1);
}

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
for (const f of files) {
  const path = join(outdir, f.name);
  writeFileSync(path, f.text);
  if (f.text.startsWith("#!")) chmodSync(path, 0o755);
}

if (process.argv.includes("--report")) {
  for (const f of files.sort((a, b) => Buffer.byteLength(b.text) - Buffer.byteLength(a.text))) {
    const size = Buffer.byteLength(f.text);
    console.log(`${String(size).padStart(8)}  ${((100 * size) / FILE_LIMIT).toFixed(0).padStart(3)}%  dist/${f.name}`);
  }
}
