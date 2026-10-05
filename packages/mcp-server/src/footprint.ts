/**
 * Which session edited which file.
 *
 * The author is allowed to say "the transcript does not cover this", and it is a correct
 * answer: measured across the eleven documents in `.intent/`, 35 interview rounds ended
 * that way. Some of those are genuinely unknowable. Others are a hunk written in a
 * DIFFERENT session — work begun one afternoon and finished the next, or a change made
 * while the developer was nominally doing something else.
 *
 * That second kind is recoverable, and this module is how. Given the files behind a hunk
 * nobody could explain, it names the sessions whose own edit events touched them. The
 * author then reads that session and answers the same question again.
 *
 * Why edit events rather than the existing relevance ranking: `listTranscriptCandidates`
 * scores a candidate by whether the changed files' BASENAMES appear anywhere in its text
 * (`git.ts`, basenames longer than two characters, substring match). That fires on a
 * session that merely mentioned `index.ts` — and this repository has five files by that
 * name. An edit event is a record of the agent actually writing the file, so a footprint
 * is attribution where the ranking is a guess.
 *
 * Scope, deliberately: sessions on THIS machine, which is every environment
 * `findSessions` knows — Claude Code, Codex, Cowork, and sessions filed by
 * `import_session`, those last being the developer's own cloud runs whose transcripts
 * never touched local disk. Nobody else's machine is in scope and nothing here reaches
 * for one.
 *
 * Two things keep the full scan affordable:
 *
 * - `findSessions` is already repo-scoped, by cwd match or connected-folder mount, so the
 *   corpus is this repository's sessions rather than the 442 in a workspace.
 * - A line is only JSON-parsed if it contains one of the keys a parser reads to emit an
 *   edit (`EDIT_KEYS`). Those strings must be present for an edit event to exist, so the
 *   filter cannot drop one — which matters more than the speed, because a footprint that
 *   silently misses a session sends the author away empty and looks exactly like a
 *   session that never existed.
 *
 * Results are cached per repository under `REVIEW_ASSIST_HOME`, keyed on each session's
 * size and mtime, so an unchanged session is free on every later lookup and only the ones
 * that grew are re-read.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseEntry } from "./transcript/index.js";
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
 * One session's contact with this repository's files, in two tiers.
 *
 * The tiers exist because the strong signal is mostly absent in practice. Measured on
 * this repository: `packages/mcp-server/src/spine.ts` has ZERO `edit` events across all
 * 24 sessions, because the work was done through Bash heredocs and `sed` rather than the
 * Edit tool. Only `mentioned` finds it. An `edit` is still better evidence when it is
 * there, so the two are kept apart rather than summed.
 */
export interface SessionFootprint {
  size: number;
  mtime: number;
  /** Repo-relative path -> count of `edit` events. The structured signal. */
  edited: Record<string, number>;
  /** Repo-relative path -> count of shell commands naming it. Touched, not necessarily written. */
  mentioned: Record<string, number>;
}

/** Repo path -> session path -> footprint. */
type Cache = Record<string, Record<string, SessionFootprint>>;

function readCache(): Cache {
  try {
    return JSON.parse(readFileSync(cacheFile(), "utf8")) as Cache;
  } catch {
    return {};
  }
}

function writeCache(cache: Cache): void {
  mkdirSync(homeDir(), { recursive: true });
  writeFileSync(cacheFile(), JSON.stringify(cache), "utf8");
}

/**
 * A recorded edit path as something comparable to a diff path, or null if it is not in
 * this repository.
 *
 * Claude Code records an absolute `file_path`; Codex prints either form depending on how
 * the patch was addressed. Both arrive here, so both are handled. An absolute path that
 * does not sit under the repo is a real edit to somewhere else — a config file, another
 * checkout — and is dropped rather than guessed at.
 */
export function toRepoRelative(p: string, repoDir: string, opts: { allowRelative?: boolean } = {}): string | null {
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

/** Read one session and collect the repo files it wrote. */
export function scanSession(sessionPath: string, repoDir: string): SessionFootprint {
  const stat = statSync(sessionPath);
  const edited: Record<string, number> = {};
  const mentioned: Record<string, number> = {};
  const base = { size: stat.size, mtime: stat.mtimeMs, edited, mentioned };
  let text = "";
  try {
    text = readFileSync(sessionPath, "utf8");
  } catch {
    return base;
  }

  // Unknown cwd stays permissive: a miss makes a session invisible to the author hunting
  // for who wrote a hunk, which is the worse failure of the two.
  const cwd = sessionCwd(sessionPath);
  const ranHere = cwd === null || toRepoRelative(cwd, repoDir) !== null || resolve(cwd) === resolve(repoDir);
  const add = (into: Record<string, number>, p: string) => {
    const rel = toRepoRelative(p, repoDir, { allowRelative: ranHere });
    if (rel) into[rel] = (into[rel] ?? 0) + 1;
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
      if (e.kind === "edit" && e.path) add(edited, e.path);
      for (const p of e.paths ?? []) add(mentioned, p);
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
  const prior = cache[repo] ?? {};
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
    if (have && have.size === stat.size && have.mtime === stat.mtimeMs && have.edited) {
      next[path] = have;
      continue;
    }
    next[path] = scanSession(path, repo);
    changed = true;
  }

  // Sessions that disappeared should leave the cache with them.
  if (!changed) changed = Object.keys(prior).length !== Object.keys(next).length;
  if (changed) {
    cache[repo] = next;
    writeCache(cache);
  }
  return next;
}

/** A session that wrote at least one of the files asked about. */
export interface FootprintMatch {
  /** Transcript path, ready for `get_spine`. */
  path: string;
  mtime: number;
  /** Of the files asked about, the ones this session produced an `edit` event for. */
  edited: Record<string, number>;
  /** Of the files asked about, the ones its shell commands named. */
  mentioned: Record<string, number>;
  /** Total `edit` events across the files asked about. */
  edits: number;
  /** Total command mentions across the files asked about. */
  mentions: number;
  /**
   * How many of the files asked about this session touched at all. The ranking signal:
   * the session that produced a change touched the WHOLE set, where a session that merely
   * worked nearby touched some of it. Measured on commit 05c90a4 (ten files), the session
   * committed the following day covers 10/10 while a later, busier session covers 8/10 —
   * sorting on edit volume put the wrong one first.
   */
  covered: number;
}

/**
 * Sessions that wrote any of `targets`, heaviest first.
 *
 * `targets` are repo-relative diff paths. `exclude` is for the session the author has
 * already read: the question is always "who ELSE wrote this", so returning the current
 * session would answer it with the transcript that just came up empty.
 */
export function findSessionsTouching(
  repoDir: string,
  targets: string[],
  opts: { exclude?: string[] } = {}
): FootprintMatch[] {
  return rankMatches(refreshFootprints(repoDir), targets, opts);
}

/**
 * The ranking, with the filesystem left out so it can be reasoned about on its own.
 */
export function rankMatches(
  footprints: Record<string, SessionFootprint>,
  targets: string[],
  opts: { exclude?: string[] } = {}
): FootprintMatch[] {
  const wanted = new Set(targets.map((t) => t.split(sep).join("/").replace(/^\.\//, "")));
  const excluded = new Set((opts.exclude ?? []).map((p) => resolve(p)));
  const out: FootprintMatch[] = [];

  const pick = (from: Record<string, number>) => {
    const got: Record<string, number> = {};
    let total = 0;
    for (const [file, count] of Object.entries(from)) {
      if (!wanted.has(file)) continue;
      got[file] = count;
      total += count;
    }
    return { got, total };
  };

  for (const [path, fp] of Object.entries(footprints)) {
    if (excluded.has(resolve(path))) continue;
    const e = pick(fp.edited);
    const m = pick(fp.mentioned);
    if (e.total + m.total === 0) continue;
    const covered = new Set([...Object.keys(e.got), ...Object.keys(m.got)]).size;
    out.push({
      path,
      mtime: fp.mtime,
      edited: e.got,
      mentioned: m.got,
      edits: e.total,
      mentions: m.total,
      covered,
    });
  }

  // Coverage first, for the reason on `covered`. Then an `edit`, which records the file
  // being written where a mention may be a read. Then volume, then recency — the later
  // session had the last word on the file.
  return out.sort(
    (a, b) =>
      b.covered - a.covered || b.edits - a.edits || b.mentions - a.mentions || b.mtime - a.mtime
  );
}
