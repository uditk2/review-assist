// Prerenders the site pages into dist/, which is what the Worker serves.
//
// The viewer renders everything client-side, so the HTML a crawler, a link unfurler or a
// no-JS client fetched was one line: "Loading…". Google runs the script; Bing, LinkedIn,
// Slack and the LLM crawlers mostly do not. And the release notes lived under "#/blog",
// which no crawler indexes at all, because a fragment never leaves the browser.
//
// So the build runs the page's own script in jsdom, once per route, and writes what it
// rendered into #app of a static copy. Nothing is re-implemented here: the markup comes
// from the same renderLanding / renderPost the browser runs, which then replaces it on
// load. Each top-level node is marked data-prerendered, so a PR link (which lands on "/")
// can hide it from the first paint (see the data-route script in <head>).
//
// Routes: /, /blog/, /blog/<version>/, /installed/ (GitHub's post-install Setup URL).
// Also writes sitemap.xml, since the release list now decides it.

import { JSDOM, VirtualConsole } from "jsdom";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VIEWER = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(VIEWER, "dist");
const ORIGIN = "https://reviewassist.dev";
// Not reviewassist.dev, so the hostname-gated Clarity tag stays off during the build.
const RENDER_ORIGIN = "https://prerender.invalid";

// Everything the served site needs, and nothing else: DESIGN.md, src/ and the configs used
// to ship as public assets only because they sat in the served directory.
const ASSETS = ["favicon.svg", "fonts", "schema", "styles.css", "robots.txt", "llms.txt", "social-preview.png"];

const template = await readFile(join(VIEWER, "index.html"), "utf8");

/** Run the page at `path` and return what its script put in #app, plus the release list. */
async function render(path) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  // jsdom has no layout or scrolling; "Not implemented" is it saying so, not the page failing.
  virtualConsole.on("jsdomError", (e) => { if (!/Not implemented/.test(e.message)) errors.push(e); });
  virtualConsole.on("error", (...args) => errors.push(new Error(args.join(" "))));

  const dom = new JSDOM(template, {
    url: RENDER_ORIGIN + path,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
  });
  // The demo paints its first stop on a zero-delay timeout; let it land.
  await new Promise((r) => setTimeout(r, 25));

  const { document } = dom.window;
  const app = document.getElementById("app");
  // lockDemoHeight measured 0 without layout; the browser measures it again on load.
  for (const n of app.querySelectorAll(".demo")) n.style.removeProperty("min-height");
  for (const n of app.children) n.setAttribute("data-prerendered", "");

  const html = app.innerHTML;
  const releases = JSON.parse(dom.window.eval(
    "JSON.stringify(RELEASES.map(r => ({ v: r.v, title: r.title, summary: r.summary, date: r.date })))"));
  const h1 = app.querySelector("h1")?.textContent.trim();
  const textLength = app.textContent.replace(/\s+/g, " ").trim().length;
  dom.window.close(); // stops the demo's interval

  if (errors.length) throw new Error(`${path}: the page script failed:\n${errors.map((e) => e.stack || e.message).join("\n")}`);
  // A blank or placeholder #app is the failure this whole step exists to prevent, so it
  // fails the build rather than shipping.
  if (!h1 || textLength < 300 || html.includes("Loading…")) {
    throw new Error(`${path}: prerender produced no real content (h1: ${JSON.stringify(h1)}, ${textLength} chars)`);
  }
  return { html, releases };
}

const plain = (s) => String(s)
  .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
  .replace(/`([^`]+)`/g, "$1")
  .replace(/\*\*([^*]+)\*\*/g, "$1")
  .replace(/\*([^*]+)\*/g, "$1");

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
/** "13 Aug 2026" → "2026-08-13". Strict, so a typo in a release date fails the build. */
function isoDate(d) {
  const m = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$/.exec(d);
  if (!m || !MONTHS[m[2]]) throw new Error(`unrecognised release date: ${JSON.stringify(d)}`);
  return `${m[3]}-${String(MONTHS[m[2]]).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

/** The template with this route's metadata and prerendered #app. */
function page({ path, title, description, html, type = "website", jsonLd = null, noindex = false }) {
  const dom = new JSDOM(template);
  const { document } = dom.window;
  const url = ORIGIN + path;
  const set = (selector, attr, value) => {
    const n = document.querySelector(selector);
    if (!n) throw new Error(`template is missing ${selector}`);
    n.setAttribute(attr, value);
  };

  document.title = title;
  set('meta[name="description"]', "content", description);
  set('link[rel="canonical"]', "href", url);
  set('meta[property="og:type"]', "content", type);
  set('meta[property="og:title"]', "content", title);
  set('meta[property="og:description"]', "content", description);
  set('meta[property="og:url"]', "content", url);
  set('meta[name="twitter:title"]', "content", title);
  set('meta[name="twitter:description"]', "content", description);

  // The FAQPage schema describes the landing page's FAQ; on any other page it would be
  // structured data for content that is not there.
  const ld = document.querySelector('script[type="application/ld+json"]');
  // "<" escaped, so a release title containing "</script>" cannot close the tag early.
  if (jsonLd) ld.textContent = "\n" + JSON.stringify(jsonLd, null, 2).replace(/</g, "\\u003c") + "\n";
  else if (path !== "/") ld.remove();

  if (noindex) {
    const m = document.createElement("meta");
    m.setAttribute("name", "robots");
    m.setAttribute("content", "noindex");
    document.querySelector('meta[name="description"]').after(m);
  }

  document.getElementById("app").innerHTML = html;
  return dom.serialize();
}

async function write(path, content) {
  const file = join(DIST, path, path.endsWith("/") ? "index.html" : "");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });
for (const a of ASSETS) {
  if (!existsSync(join(VIEWER, a))) throw new Error(`missing asset ${a}; run the css and schema builds first`);
  await cp(join(VIEWER, a), join(DIST, a), { recursive: true });
}

const home = await render("/");
// Landing metadata stays exactly as authored in the template.
const doc = new JSDOM(template).window.document;
await write("/", page({
  path: "/",
  title: doc.title,
  description: doc.querySelector('meta[name="description"]').getAttribute("content"),
  html: home.html,
}));

const releases = home.releases;
const index = await render("/blog/");
await write("/blog/", page({
  path: "/blog/",
  title: "Release notes · Review Assist",
  description: "What changed in each Review Assist release, what broke, and why it was done that way.",
  html: index.html,
}));

for (const r of releases) {
  const path = `/blog/${r.v}/`;
  const { html } = await render(path);
  const title = `${plain(r.title)} · Review Assist v${r.v}`;
  const description = plain(r.summary);
  await write(path, page({
    path, title, description, html, type: "article",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: plain(r.title),
      description,
      datePublished: isoDate(r.date),
      url: ORIGIN + path,
      author: { "@type": "Organization", name: "Review Assist", url: ORIGIN + "/" },
    },
  }));
}

const installed = await render("/installed/");
await write("/installed/", page({
  path: "/installed/",
  title: "Installed · Review Assist",
  description: "The Review Assist GitHub App is installed. Register the MCP server with your coding agent to finish setting up.",
  html: installed.html,
  noindex: true,
}));

// /installed/ is left out: it is a step in a flow, not a page to find. "/" has no lastmod:
// the build date would change on every deploy whether the page did or not, and a lastmod
// that is always new teaches crawlers to ignore it.
const urls = [
  { loc: "/", priority: "1.0" },
  { loc: "/blog/", lastmod: isoDate(releases[0].date), priority: "0.6" },
  ...releases.map((r) => ({ loc: `/blog/${r.v}/`, lastmod: isoDate(r.date), priority: "0.5" })),
];
await writeFile(join(DIST, "sitemap.xml"), [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...urls.map((u) => `  <url><loc>${ORIGIN}${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}<priority>${u.priority}</priority></url>`),
  "</urlset>",
  "",
].join("\n"));

console.log(`prerendered ${3 + releases.length} pages into ${DIST}`);
