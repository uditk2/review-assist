/**
 * Which session wrote this hunk.
 *
 * The author is allowed to say "the transcript does not cover this", and it is a correct
 * answer: across the eleven documents in `.intent/`, 35 interview rounds ended that way.
 * Some of those are genuinely unknowable. Others are a hunk written in a DIFFERENT
 * session — work begun one day and finished the next — and that is recoverable.
 *
 * TWO STEPS, and they do different jobs.
 *
 *   STEP 1 — NARROW, by file.   `sessionsTouching`
 *     Which sessions on this machine touched these paths at all. Deterministic, cached,
 *     and cheap enough to run over every session for the repo. It is an index, nothing
 *     more: being in the result means a session NAMED the file, which a session that only
 *     read it also does. On commit 05c90a4 this takes 56 sessions down to 7.
 *
 *   STEP 2 — ATTRIBUTE, by content.   `whoWrote`
 *     Of those few, which actually wrote the hunk's lines. A session that wrote a line put
 *     it in a tool's INPUT; a session that read the file got it back in a tool's OUTPUT.
 *     That split is the discriminator, and it is decisive. On the same commit, matching 25
 *     distinctive added lines:
 *
 *         session      authored  observed   active
 *         a14baf83        16/25         0   Sep 22   <- the commit was Sep 21
 *         5e0f73f2         7/25         2   Oct 3
 *         331ae796         0/25        23   Oct 3
 *         9b4bb35b         0/25        19   Oct 1
 *
 *     Step 1 cannot tell those four apart. Step 2 leaves one answer.
 *
 * Step 1 exists only to keep step 2 affordable: content matching reads whole sessions, so
 * it runs over the handful step 1 named rather than over everything. Neither step is
 * useful alone — step 1 is too vague to answer with, step 2 too expensive to run blind.
 *
 * Scope, deliberately: sessions on THIS machine, which is every environment
 * `findSessions` knows — Claude Code, Codex, Cowork, and sessions filed by
 * `import_session`, those last being the developer's own cloud runs whose transcripts
 * never touched local disk. Nobody else's machine is in scope.
 *
 * A limit worth knowing: this reaches only sessions still on disk. The store here goes
 * back about four weeks, so a hunk written months ago has no session left to find, and
 * step 2 correctly reports that nobody wrote it.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { attributionOf, parseEntry } from "./transcript/index.js";
import { findSessions, sessionCwd } from "./transcript/sources.js";

/**
 * Read at call time, not at module load, so a test can point the cache somewhere
 * disposable without re-importing the module.
 */
function homeDir(): string {
  return process.env.REVIEW_ASSIST_HOME ?? join(homedir(), ".review-assist");
}

function cacheFile(): string {
  return join(homeDir(), "footprints.json");
}

/**
 * Bumped whenever a stored footprint means something different, so an old cache is
 * rebuilt rather than misread. Cheaper and less error-prone than probing for fields.
 */
const CACHE_VERSION = 2;

/* ================================================================== *
 * STEP 1 — narrow, by file
 * ================================================================== */

/**
 * The input keys the parsers read to produce an `edit` or `command` event: Claude Code's
 * `Edit`-family tools carry `file_path` or `notebook_path` and Bash carries `command`;
 * Codex reports a landed patch as `patch_apply_end` and a shell call as
 * `custom_tool_call` or `function_call`. A line without one of these cannot yield either
 * event, which is what makes skipping it safe rather than merely fast.
 */
const EVENT_KEYS = [
  '"file_path"',
  '"notebook_path"',
  '"patch_apply_end"',
  '"command"',
  '"custom_tool_call"',
  '"function_call"',
] as const;

/**
 * One session's contact with this repository's files.
 *
 * A single count, not a breakdown. An earlier version separated a recorded file write
 * from a shell command naming the file, on the theory that the first was better evidence.
 * It is, marginally — and it barely exists: `spine.ts` has ZERO Edit-tool writes across
 * every session on disk, because the work here is done through heredocs and `sed`. The
 * distinction bought a little ranking signal and invited the reader to treat step 1 as an
 * answer. Step 2 is the answer, so step 1 keeps only what it needs in order to narrow.
 */
export interface SessionFootprint {
  size: number;
  mtime: number;
  /** Repo-relative path -> how many events named it. Files outside the repo are dropped. */
  touched: Record<string, number>;
}

interface Cache {
  v?: number;
  /** Repo path -> session path -> footprint. */
  repos?: Record<string, Record<string, SessionFootprint>>;
}

function readCache(): Cache {
  try {
    const c = JSON.parse(readFileSync(cacheFile(), "utf8")) as Cache;
    return c.v === CACHE_VERSION ? c : {};
  } catch {
    return {};
  }
}

function writeCache(cache: Cache): void {
  mkdirSync(homeDir(), { recursive: true });
  writeFileSync(cacheFile(), JSON.stringify({ ...cache, v: CACHE_VERSION }), "utf8");
}

/**
 * A recorded path as something comparable to a diff path, or null if it is not this
 * repository's file.
 *
 * Claude Code records an absolute `file_path`; Codex prints either form; a path pulled out
 * of a shell command is whatever was typed. An absolute path outside the repo is a real
 * edit to somewhere else — another checkout, a scratchpad — and is dropped rather than
 * guessed at.
 */
export function toRepoRelative(
  p: string,
  repoDir: string,
  opts: { allowRelative?: boolean } = {}
): string | null {
  const posix = (s: string) => s.split(sep).join("/");
  if (isAbsolute(p)) {
    const rel = relative(resolve(repoDir), resolve(p));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    return posix(rel);
  }
  // A relative path carries no repository with it, so it is only this repo's file if the
  // session was RUNNING here. `findSessions` reaches sessions whose cwd is an ancestor of
  // the repo — a workspace directory holding several checkouts — and those sessions edit
  // sibling repositories with paths like `src/index.ts` that collide with this one's.
  if (opts.allowRelative === false) return null;
  return posix(p).replace(/^\.\//, "") || null;
}

/** Read one session and collect the repo files it named. */
export function scanSession(sessionPath: string, repoDir: string): SessionFootprint {
  const stat = statSync(sessionPath);
  const touched: Record<string, number> = {};
  const base = { size: stat.size, mtime: stat.mtimeMs, touched };
  let text = "";
  try {
    text = readFileSync(sessionPath, "utf8");
  } catch {
    return base;
  }

  // Unknown cwd stays permissive: a miss makes a session invisible to the author hunting
  // for who wrote a hunk, which is the worse failure of the two.
  const cwd = sessionCwd(sessionPath);
  const ranHere =
    cwd === null || toRepoRelative(cwd, repoDir) !== null || resolve(cwd) === resolve(repoDir);
  const add = (p: string) => {
    const rel = toRepoRelative(p, repoDir, { allowRelative: ranHere });
    if (rel) touched[rel] = (touched[rel] ?? 0) + 1;
  };

  for (const line of text.split("\n")) {
    if (!line.includes('"') || !EVENT_KEYS.some((k) => line.includes(k))) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const e of parseEntry(entry).events) {
      if (e.kind === "edit" && e.path) add(e.path);
      for (const p of e.paths ?? []) add(p);
    }
  }
  return base;
}

/**
 * Every repo session's footprint, re-reading only the ones whose size or mtime moved.
 *
 * Transcripts are append-only in normal operation, but `import_session` overwrites by
 * design — a live cloud session keeps growing, so a second export must replace the first.
 * Size and mtime together catch that: a replaced file differs in at least one.
 */
export function refreshFootprints(repoDir: string): Record<string, SessionFootprint> {
  const repo = resolve(repoDir);
  const cache = readCache();
  const prior = cache.repos?.[repo] ?? {};
  const next: Record<string, SessionFootprint> = {};
  let changed = false;

  for (const { path } of findSessions(repo)) {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue; // vanished between discovery and read
    }
    const have = prior[path];
    if (have && have.size === stat.size && have.mtime === stat.mtimeMs) {
      next[path] = have;
      continue;
    }
    next[path] = scanSession(path, repo);
    changed = true;
  }

  // Sessions that disappeared should leave the cache with them.
  if (!changed) changed = Object.keys(prior).length !== Object.keys(next).length;
  if (changed) writeCache({ ...cache, repos: { ...(cache.repos ?? {}), [repo]: next } });
  return next;
}

/** A session that named at least one of the files asked about. */
export interface Candidate {
  /** Transcript path, ready for `get_spine`. */
  path: string;
  mtime: number;
  /**
   * How many of the files asked about this session named.
   *
   * The ranking signal for step 1, because a session that produced a change touched the
   * WHOLE set where one that worked nearby touched part of it. Measured on commit 05c90a4
   * (ten files), the session committed the next day covers 10/10 while a later, busier
   * session covers 8/10.
   */
  covered: number;
}

/**
 * STEP 1. Sessions that named any of `paths`, best first.
 *
 * `exclude` is for the session the author has already read: the question is always "who
 * ELSE wrote this", so returning the current session would answer it with the transcript
 * that just came up empty.
 */
export function sessionsTouching(
  repoDir: string,
  paths: string[],
  opts: { exclude?: string[] } = {}
): Candidate[] {
  return narrow(refreshFootprints(repoDir), paths, opts);
}

/** The narrowing, with the filesystem left out so it can be reasoned about on its own. */
export function narrow(
  footprints: Record<string, SessionFootprint>,
  paths: string[],
  opts: { exclude?: string[] } = {}
): Candidate[] {
  const wanted = new Set(paths.map((t) => t.split(sep).join("/").replace(/^\.\//, "")));
  const excluded = new Set((opts.exclude ?? []).map((p) => resolve(p)));
  const out: Candidate[] = [];

  for (const [path, fp] of Object.entries(footprints)) {
    if (excluded.has(resolve(path))) continue;
    const covered = Object.keys(fp.touched).filter((f) => wanted.has(f)).length;
    if (covered > 0) out.push({ path, mtime: fp.mtime, covered });
  }

  // Recency breaks a coverage tie: the later session had the last word on the file.
  return out.sort((a, b) => b.covered - a.covered || b.mtime - a.mtime);
}

/* ================================================================== *
 * STEP 2 — attribute, by content
 * ================================================================== */

/**
 * The shortest added line worth matching on.
 *
 * Below this a line is `});` or a blank or an import half the repo shares, and it matches
 * sessions that had nothing to do with the hunk.
 */
const DISTINCTIVE_CHARS = 40;

/** How many lines one query matches on, so step 2's cost stays bounded. */
export const DEFAULT_MAX_LINES = 30;

/**
 * The lines a hunk ADDED, trimmed and filtered to the ones distinctive enough to identify
 * it. Removed lines are useless here: they existed before the change, so every session
 * that ever read the file contains them.
 */
export function addedLines(hunkText: string, limit = DEFAULT_MAX_LINES): string[] {
  const out: string[] = [];
  for (const line of hunkText.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const text = line.slice(1).trim();
    if (text.length >= DISTINCTIVE_CHARS) out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/** What a session did with a hunk's lines. */
export interface Attribution extends Candidate {
  /** How many of the lines this session WROTE: they appear in a tool input. */
  authored: number;
  /** How many it only READ BACK: they appear in a tool's output. */
  observed: number;
}

/**
 * STEP 2. How many of `lines` this session wrote, and how many it only read.
 *
 * Matching happens on the DECODED entry, never on the raw JSONL text. A line containing a
 * quote is escaped in the file, so a raw substring search silently misses exactly the
 * lines most likely to be distinctive — which is how a first attempt at this found three
 * of four probe lines and missed the one with an import statement in it.
 *
 * A line counts as authored OR observed, never both. Writing it is the stronger claim, so
 * when a session both wrote and later read a line, the write wins.
 */
export function whoWrote(
  sessionPath: string,
  lines: string[]
): { authored: number; observed: number } {
  if (lines.length === 0) return { authored: 0, observed: 0 };
  let text = "";
  try {
    text = readFileSync(sessionPath, "utf8");
  } catch {
    return { authored: 0, observed: 0 };
  }

  // Escaped form of each needle, so it matches the escaped text it sits inside.
  const needles = lines.map((line) => ({ line, escaped: JSON.stringify(line).slice(1, -1) }));
  const authored = new Set<string>();
  const observed = new Set<string>();

  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    const att = attributionOf(entry);
    if (!att.authored && !att.observed) continue;
    for (const { line, escaped } of needles) {
      if (att.authored.includes(escaped) || att.authored.includes(line)) authored.add(line);
      else if (att.observed.includes(escaped) || att.observed.includes(line)) observed.add(line);
    }
  }
  for (const line of authored) observed.delete(line);
  return { authored: authored.size, observed: observed.size };
}

/**
 * Both steps: narrow by the hunks' files, then attribute by their added lines.
 *
 * Ordered so the answer reads top down: most lines authored first, so a session that only
 * ever read the file sinks below one that wrote a single line.
 */
export function findAuthoringSessions(
  repoDir: string,
  hunks: { path: string; text: string }[],
  opts: { exclude?: string[]; maxLines?: number } = {}
): { lines: string[]; attributed: Attribution[] } {
  const limit = opts.maxLines ?? DEFAULT_MAX_LINES;
  const paths = Array.from(new Set(hunks.map((h) => h.path)));
  const lines = Array.from(new Set(hunks.flatMap((h) => addedLines(h.text, limit)))).slice(0, limit);

  const attributed = sessionsTouching(repoDir, paths, opts)
    .map((c) => ({ ...c, ...whoWrote(c.path, lines) }))
    .sort((a, b) => b.authored - a.authored || b.covered - a.covered || b.mtime - a.mtime);

  return { lines, attributed };
}
