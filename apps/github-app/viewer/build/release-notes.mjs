/**
 * Release notes: one JSON file, written by the release itself.
 *
 * releases.json holds every entry, newest first, in the shape renderReleasePost reads:
 * { v, date, title, summary, body }. The page carries no copy of it; the build and the
 * mock server inline it into #release-notes. The publish workflow adds each release's
 * entry in the same commit as the version bump, built from the commit messages the
 * release ships, so a version cannot reach npm without its note. Notes had been written
 * by hand, and 1.0.6 to 1.0.9 shipped with none.
 *
 * An entry that already exists is never regenerated, so a note can be rewritten by hand
 * in releases.json after the fact and stays as written.
 *
 *   node apps/github-app/viewer/build/release-notes.mjs add [--version x.y.z] [--from <ref>] [--to <ref>] [--date "12 Oct 2026"]
 *   node apps/github-app/viewer/build/release-notes.mjs markdown <x.y.z>
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VIEWER = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(VIEWER, "../../..");
const NOTES_PATH = join(VIEWER, "releases.json");
const SITE = "https://reviewassist.dev";

export const readNotes = () => JSON.parse(readFileSync(NOTES_PATH, "utf8"));

const PLACEHOLDER = '<script type="application/json" id="release-notes"></script>';
/** The page with releases.json inside its #release-notes script. */
export function inlineReleaseNotes(html, notes = readNotes()) {
  if (html.split(PLACEHOLDER).length !== 2) throw new Error("index.html must carry exactly one empty #release-notes script");
  // "<" escaped, so a note quoting "</script>" cannot close the tag early.
  const json = JSON.stringify(notes).replace(/</g, "\\u003c");
  return html.replace(PLACEHOLDER, () => `<script type="application/json" id="release-notes">${json}</script>`);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "12 Oct 2026", the format prerender's isoDate accepts. */
export const noteDate = (d = new Date()) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

// Commits that change nothing a release ships: design mockups and documents, Intent
// Documents, and hand edits to these notes. The version bumps are left out by subject.
const NOT_SHIPPED = /^(design\/|\.intent\/|apps\/github-app\/viewer\/releases\.json$)/;
// A blog article adds its artwork under blog/ and its text to index.html (ARTICLES), so
// a commit that touches blog/ and nothing an article does not need is an article.
const ARTICLE = /^apps\/github-app\/viewer\/(blog\/|index\.html$|build\/prerender\.mjs$|llms\.txt$)/;

/** Whether a commit ({ subject, files }) changed something the release ships. */
export function ships(c) {
  if (/^release\(/.test(c.subject)) return false;
  const files = c.files.filter((f) => !NOT_SHIPPED.test(f));
  if (!files.length) return false;
  const article = files.some((f) => f.startsWith("apps/github-app/viewer/blog/")) && files.every((f) => ARTICLE.test(f));
  return !article;
}

const TRAILER = /^(Co-authored-by|Signed-off-by|Reviewed-by|Acked-by|Helped-by|Reported-by|Tested-by|Change-Id):/i;
const ITEM = /^\s*[-*] /;
// Commit bodies here mark sections with a line in capitals ("THE FRONT PAGE IS NOW THE
// LIVE SET."). On the page that reads as shouting prose, so it becomes a heading in the
// sentence case the hand-written notes use.
const isCapsHeading = (p) =>
  !p.includes("\n") && p.includes(" ") && p.length <= 120 && /[A-Z]{2}/.test(p) && p === p.toUpperCase() && !ITEM.test(p);
const sentenceCase = (s) => s.replace(/[.:]\s*$/, "").toLowerCase().replace(/^\p{L}/u, (c) => c.toUpperCase());
/** A commit body as note blocks: prose unwrapped into paragraphs, "- " runs as lists. */
export function bodyBlocks(text) {
  const blocks = [];
  for (const para of text.replace(/\r/g, "").split(/\n\s*\n/)) {
    if (isCapsHeading(para.trim())) { blocks.push({ h: sentenceCase(para.trim()) }); continue; }
    let prose = [], list = null;
    const flush = () => { if (prose.length) blocks.push(prose.join(" ")); prose = []; };
    for (const line of para.split("\n")) {
      const l = line.trim();
      if (!l || TRAILER.test(l)) continue;
      if (ITEM.test(line)) {
        flush();
        if (!list) blocks.push(list = { ul: [] });
        list.ul.push(line.replace(ITEM, "").trim());
      } else if (list) list.ul[list.ul.length - 1] += " " + l;
      else prose.push(l);
    }
    flush();
  }
  return blocks;
}

// Summaries on the index run to two sentences or so; a longer opening paragraph is cut at
// a sentence boundary and the rest kept as the body's first paragraph.
const LEDE_MAX = 320;
function lede(p) {
  if (p.length <= LEDE_MAX) return [p, null];
  const s = p.split(/(?<=[.!?])\s+(?=[A-Z`*"“(\[])/);
  let out = s[0], i = 1;
  while (i < s.length && out.length + 1 + s[i].length <= LEDE_MAX) out += " " + s[i++];
  return [out, i < s.length ? s.slice(i).join(" ") : null];
}

const size = (c) => bodyBlocks(c.body).reduce((n, b) => n + (typeof b === "string" ? b.length : b.ul ? b.ul.join(" ").length : 0), 0);

/**
 * The note for one release. The commit that explains itself at greatest length leads: its
 * subject is the title, its opening paragraph the summary, the rest of it the body. Every
 * other shipped commit follows under "Also", as its subject and opening paragraph.
 */
export function noteFromCommits({ version, date, previous, commits }) {
  const shipped = commits.filter(ships);
  if (!shipped.length) {
    return previous
      ? { v: version, date, title: `No changes since ${previous}`, summary: `This version republished ${previous} as it was.`, body: [] }
      : { v: version, date, title: "First release", summary: "First release.", body: [] };
  }
  const lead = shipped.reduce((a, c) => (size(c) >= size(a) ? c : a));
  const blocks = bodyBlocks(lead.body);
  const first = blocks.findIndex((b) => typeof b === "string");
  let summary = lead.subject.replace(/[.!?]*$/, ".");
  let body = blocks;
  if (first >= 0) {
    const [head, rest] = lede(blocks[first]);
    summary = head;
    body = [...blocks.slice(0, first), ...(rest ? [rest] : []), ...blocks.slice(first + 1)];
  }
  const others = shipped.filter((c) => c !== lead);
  if (others.length) {
    body.push({ h: "Also" }, {
      ul: others.map((c) => {
        const p = bodyBlocks(c.body).find((b) => typeof b === "string");
        const name = `**${c.subject.replace(/[.!?]*$/, "")}.**`;
        return p ? `${name} ${lede(p)[0]}` : name;
      }),
    });
  }
  return { v: version, date, title: lead.subject, summary, body };
}

/** The GitHub release body for an entry. Site-relative links are made absolute. */
export function toMarkdown(r) {
  const out = [`## ${r.title}`, r.summary];
  for (const b of r.body) {
    if (typeof b === "string") out.push(b);
    else if (b.h) out.push(`### ${b.h}`);
    else if (b.ul) out.push(b.ul.map((t) => `- ${t}`).join("\n"));
    else if (b.note) out.push(`> ${b.note}`);
    else if (b.code) out.push("```\n" + b.code + "\n```");
  }
  out.push(`Release notes: ${SITE}/releases/${r.v}/`);
  return out.join("\n\n").replace(/\]\(\//g, `](${SITE}/`) + "\n";
}

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 }).trim();

/** Commits in from..to, oldest first, with the files each one touched. */
export function commitsBetween(from, to) {
  const raw = git("log", "--no-merges", "--reverse", "--format=%H%x1f%s%x1f%b%x1e", from ? `${from}..${to}` : to);
  return raw.split("\x1e").map((s) => s.trim()).filter(Boolean).map((rec) => {
    const [hash, subject, body = ""] = rec.split("\x1f");
    return { hash, subject, body, files: git("show", "--name-only", "--format=", hash).split("\n").filter(Boolean) };
  });
}

/** The release tag nearest to `to`, other than this version's own. */
function previousTag(version, to) {
  try { return git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "--exclude", `v${version}`, to); }
  catch { return undefined; }
}

const semver = (v) => v.split(".").map(Number);
const newestFirst = (a, b) => { const x = semver(a.v), y = semver(b.v); return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]; };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  if (cmd === "add") {
    const version = opt("version") ?? JSON.parse(readFileSync(join(ROOT, "packages/mcp-server/package.json"), "utf8")).version;
    const notes = readNotes();
    if (notes.some((r) => r.v === version)) {
      console.log(`release notes: ${version} already has an entry, kept as written`);
    } else {
      const to = opt("to") ?? "HEAD";
      const from = opt("from") ?? previousTag(version, to);
      const commits = commitsBetween(from, to);
      const entry = noteFromCommits({ version, date: opt("date") ?? noteDate(), previous: from?.replace(/^v/, ""), commits });
      writeFileSync(NOTES_PATH, JSON.stringify([...notes, entry].sort(newestFirst), null, 2) + "\n");
      console.log(`release notes: added ${version}, "${entry.title}", from ${commits.filter(ships).length} of ${commits.length} commits since ${from ?? "the start"}`);
    }
  } else if (cmd === "markdown") {
    const r = readNotes().find((n) => n.v === args[0]);
    if (!r) { console.error(`release notes: no entry for ${args[0]}`); process.exit(1); }
    process.stdout.write(toMarkdown(r));
  } else {
    console.error("usage: release-notes.mjs add [--version x.y.z] [--from ref] [--to ref] [--date \"12 Oct 2026\"] | markdown <x.y.z>");
    process.exit(2);
  }
}
