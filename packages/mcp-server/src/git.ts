/**
 * Deterministic git + transcript helpers used by the MCP tools.
 * All git work is read-only; the server never mutates the repo except to write
 * the intent document under .intent/.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname, basename, sep } from "node:path";
import { parseEntry } from "./transcript/index.js";

const exec = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export async function resolveHeadSha(repoDir: string, ref = "HEAD"): Promise<string> {
  return (await git(repoDir, ["rev-parse", ref])).trim();
}

export async function computeDiff(
  repoDir: string,
  base: string,
  head: string
): Promise<{ diff: string; baseSha: string; headSha: string }> {
  const baseSha = (await git(repoDir, ["rev-parse", base])).trim();
  const headSha = (await git(repoDir, ["rev-parse", head])).trim();
  // Three-dot: changes on head since the merge-base, i.e. the PR's own changes.
  const diff = await git(repoDir, ["diff", "--no-color", `${baseSha}...${headSha}`]);
  return { diff, baseSha, headSha };
}

/**
 * Locate session transcript(s) for a repo across supported agents, newest-first.
 * Works with BOTH:
 *   - Claude Code: ~/.claude/projects/<encoded-cwd>/<session>.jsonl  (one dir per cwd)
 *   - Cowork (on this machine): ~/Library/Application Support/Claude/
 *                 local-agent-mode-sessions/<id>/…/.claude/projects/<enc>/<uuid>.jsonl
 *                 Claude Code's own format, but the recorded cwd is the SANDBOX path
 *                 (/sessions/<name>, or …/outputs) — never the repo — so it is matched on
 *                 the connected-folder mount instead. See findCoworkTranscripts.
 *   - Codex:       ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl       (global; cwd is
 *                  recorded in the session's meta head)
 *
 * In multi-repo/container setups the agent runs at a directory ABOVE the changed repo
 * (e.g. a container holding several repos), so a session is accepted when its recorded
 * cwd is the repo OR any ancestor of it. The transcript parser is format-agnostic, so a
 * distiller can hydrate from either agent's log.
 */
export function findTranscripts(repoDir: string, override?: string): string[] {
  if (override) {
    return existsSync(override) ? [override] : [];
  }
  const repo = resolve(repoDir);
  const candidates = new Set(ancestorsInclusive(repo, 4)); // repo + up to 4 parents
  const found: { path: string; mtime: number }[] = [];

  // Claude Code — one directory per cwd-encoded path.
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  if (existsSync(projects)) {
    for (const c of candidates) {
      const dir = join(projects, c.replace(/[/\\]/g, "-"));
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        // Parents only. A subagent transcript is never a session: the developer appears
        // in exactly one place, and a subagent receives its prompt from the parent with no
        // human in the loop, so it can hold no user ask, no agreed plan, no scope decision.
        // An earlier version returned <session>/subagents/agent-*.jsonl as PEERS of their
        // own parent, so the author could be handed one seventh of a delegated session with
        // no indication of what it belonged to. Delegated output is reachable through
        // read_transcript when a claim needs substantiating; it is not a source of intent.
        if (f.isFile() && f.name.endsWith(".jsonl")) {
          const p = join(dir, f.name);
          found.push({ path: p, mtime: safeMtime(p) });
        }
      }
    }
  }

  // Codex — sessions are global; match the cwd recorded in each session's head against
  // repo-or-ancestor. Bound the content scan to the most-recent files for speed.
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  // archived_sessions holds sessions Codex has rotated out — old, but old is exactly when a
  // change's authoring session tends to live by the time anyone reviews it.
  for (const codexRoot of [join(codexHome, "sessions"), join(codexHome, "archived_sessions")]) {
  if (existsSync(codexRoot)) {
    const recent = walkJsonl(codexRoot, 4)
      .map((p) => ({ p, m: safeMtime(p) }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 120);
    for (const { p } of recent) {
      const cwd = sessionCwd(p);
      if (cwd && candidates.has(resolve(cwd))) found.push({ path: p, mtime: safeMtime(p) });
    }
  }
  }

  // Cowork running on this machine. Neither strategy above can work: the transcript is in
  // Claude Code's format but lives under the desktop app's support directory, and every
  // session records a sandbox cwd (/sessions/<name>, or …/outputs) rather than the repo, so
  // both the directory-name encoding and cwd matching miss. Connected folders are mounted
  // at /sessions/<name>/mnt/<folder>, which IS traceable back to a repo on this disk.
  for (const root of coworkRoots()) {
    if (!existsSync(root)) continue;
    const names = mountNames(repo);
    // Not bounded by recency, unlike the Codex scan above: a repo's Cowork session is often
    // old while unrelated newer ones crowd it out — the one on this machine ranked 419th of
    // 442. Scanning every session with a bounded head read costs ~150ms for that corpus, so
    // the cap bought nothing and lost the only matching session. The high ceiling is a
    // runaway guard, not a filter.
    const sessions = walkJsonl(root, 8)
      .filter((p) => !p.endsWith("audit.jsonl"))
      .slice(0, 2000);
    for (const p of sessions) {
      if (mentionsMount(p, names)) found.push({ path: p, mtime: safeMtime(p) });
    }
  }

  return found.sort((a, b) => b.mtime - a.mtime).map((x) => x.path);
}

/** [dir, parent, grandparent, …] up to `levels` above `dir` (inclusive of dir). */
function ancestorsInclusive(dir: string, levels: number): string[] {
  const out = [dir];
  let cur = dir;
  for (let i = 0; i < levels; i++) {
    const parent = dirname(cur);
    if (parent === cur) break;
    out.push(parent);
    cur = parent;
  }
  return out;
}

function safeMtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/** Recursively collect *.jsonl paths up to `depth` directory levels under `root`. */
function walkJsonl(root: string, depth: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, d: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (d > 0) walk(full, d - 1);
      } else if (name.endsWith(".jsonl")) {
        out.push(full);
      }
    }
  };
  walk(root, depth);
  return out;
}

/** Extract the working directory a Codex session recorded in its meta head, if present. */
function sessionCwd(path: string): string | null {
  try {
    const head = readFileSync(path, "utf8").slice(0, 8192);
    const m = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (!m) return null;
    return m[1].replace(/\\\\/g, "\\").replace(/\\"/g, '"');
  } catch {
    return null;
  }
}

export interface TranscriptEntry {
  index: number;
  role: string;
  /** Best-effort flattened text preview of the entry. */
  text: string;
}

/**
 * Read a window of a JSONL transcript as lightweight entries. Paging keeps very long
 * transcripts within a fresh distiller agent's budget. Format-agnostic: handles both
 * Claude Code entries and Codex's `{type, timestamp, payload}` wrapper.
 */
export function readTranscriptWindow(
  path: string,
  offset: number,
  limit: number
): { total: number; entries: TranscriptEntry[] } {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const slice = lines.slice(offset, offset + limit);
  const entries: TranscriptEntry[] = slice.map((line, i) => {
    let role = "unknown";
    let text = "";
    try {
      const obj = JSON.parse(line);
      role =
        obj.payload?.role ??
        obj.message?.role ??
        obj.role ??
        obj.payload?.type ??
        obj.type ??
        "unknown";
      text = flattenText(obj);
    } catch {
      text = line.slice(0, 500);
    }
    return { index: offset + i, role, text: text.slice(0, 2000) };
  });
  return { total: lines.length, entries };
}

function flattenText(obj: unknown): string {
  const parts: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.text === "string") parts.push(o.text);
      if (o.content) walk(o.content);
      if (o.message) walk(o.message);
      if (o.payload) walk(o.payload); // Codex wraps each entry under `payload`.
    }
  };
  walk(obj);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}


export interface TranscriptCandidate {
  path: string;
  agent: "claude-code" | "codex" | "unknown";
  mtime: number;
  cwd: string | null;
  lines: number;
  /** Preview of the first user message — use this to recognize THIS session. */
  first_user: string;
  /**
   * How many turns a human actually typed.
   *
   * Zero means nobody did, and such a session cannot hold intent: it is one agent driven by
   * another. Claude Code keeps those under <session>/subagents/ and they are filtered out by
   * path, but Codex writes a sub-agent run as an ordinary top-level rollout — same directory,
   * same naming, with the role definition in a `developer` message. Layout cannot tell them
   * apart. This count can.
   *
   * A floor, not a total: candidates are scored from a bounded head read, so a long session
   * is counted only as far as that reaches. Fine for the distinction it exists to draw —
   * nobody opens a session with a megabyte of preamble before speaking — but do not read it
   * as "this session had one turn".
   */
  user_turns: number;
  /** Preview of the last activity in the session. */
  last_activity: string;
  /** How much this session references the changed files/branch (higher = more likely). */
  relevance: number;
  /**
   * True when the session looks like a distillation run rather than the work being
   * reviewed — its opening turn asks for an Intent Document instead of a code change.
   *
   * A HINT, never a filter. In Claude Code the roles are usually spawned from the very
   * session that wrote the code, so the live transcript is the right one; excluding it
   * would break the common case. And a repo whose subject IS review-assist legitimately
   * discusses these tools throughout. So the signal is confined to the opening user turn
   * and handed to the author to judge.
   */
  looks_like_distillation_run: boolean;
}

/**
 * Rank candidate transcripts so the driving agent can pick its OWN session even when
 * several are close in time. Scores each by how much it references the changed files and
 * branch (from compute_diff), then recency, and returns the top `limit` with previews —
 * so the agent confirms the match from `first_user` without reading every candidate.
 */
export function listTranscriptCandidates(
  repoDir: string,
  opts: { override?: string; changedBasenames?: string[]; branch?: string; limit?: number } = {}
): TranscriptCandidate[] {
  // Scored set is bounded for cost, not for relevance — everything findTranscripts returns
  // already passed a strong filter (cwd match, or connected-folder mount). Thirty was too
  // tight once Cowork sessions joined: a repo with 40 recent Claude Code transcripts pushed
  // all 29 of its mount-matched Cowork sessions out of the window before scoring, so the
  // only sessions that held the work were never ranked.
  const paths = findTranscripts(repoDir, opts.override).slice(0, 80);
  const basenames = Array.from(new Set((opts.changedBasenames ?? []).filter((b) => b && b.length > 2)));
  const branch = opts.branch?.trim();
  const cands: TranscriptCandidate[] = paths.map((p) => {
    // Bounded read: scoring only needs to know whether the session mentions the changed
    // files, and slurping multi-megabyte sessions whole to then discard most of it made the
    // scan cost scale with session length rather than with the number of candidates.
    let content = readBounded(p, 1_000_000);
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const agent: TranscriptCandidate["agent"] = p.includes(`${sep}.claude${sep}`)
      ? "claude-code"
      : p.includes(`${sep}.codex${sep}`)
      ? "codex"
      : "unknown";
    let relevance = 0;
    for (const b of basenames) if (content.includes(b)) relevance += 1;
    if (branch && branch.length > 1 && content.includes(branch)) relevance += 2;
    return {
      path: p,
      agent,
      mtime: safeMtime(p),
      cwd: sessionCwd(p),
      lines: lines.length,
      first_user: previewFirstUser(lines),
      user_turns: countUserTurns(lines),
      looks_like_distillation_run: looksLikeDistillationRun(firstUserText(lines)),
      last_activity: previewLast(lines),
      relevance,
    };
  });
  cands.sort((a, b) => b.relevance - a.relevance || b.mtime - a.mtime);
  return cands.slice(0, opts.limit ?? 8);
}

/**
 * The opening ask. This preview exists so the author can tell one session from another, so
 * it has to be the words the developer typed — client scaffolding removed, and correct for
 * whichever agent wrote the file.
 *
 * It used to guess the shape inline: `obj.payload?.role ?? obj.message?.role ?? obj.type`.
 * That never matched a Codex session, whose user turns are `event_msg/user_message` with no
 * role field at all, so every Codex candidate came back with an empty preview and the
 * ranking's tie-break was all the author had. The parsers know both shapes; this asks them.
 */
function previewFirstUser(lines: string[]): string {
  return firstUserText(lines).slice(0, 240);
}

/** Full text of the first real user turn (scaffolding stripped, not truncated). */
function firstUserText(lines: string[]): string {
  for (const line of lines) {
    const turn = parseLine(line)?.turn;
    if (turn?.role === "user" && turn.text) return turn.text;
  }
  return "";
}

/** Turns a human typed, within the scanned head. Zero means another agent drove this one. */
function countUserTurns(lines: string[]): number {
  let n = 0;
  for (const line of lines) {
    const turn = parseLine(line)?.turn;
    if (turn?.role === "user" && turn.text) n += 1;
  }
  return n;
}

function parseLine(line: string) {
  try {
    return parseEntry(JSON.parse(line) as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

/** The last thing said, by either side — how the session left off. */
function previewLast(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseLine(lines[i]);
    if (parsed?.turn?.text) return parsed.turn.text.slice(0, 240);
  }
  return "";
}

/**
 * Does this session's opening ask read as "produce an Intent Document" rather than
 * "change the code"? Deliberately narrow: only the first user turn, and only when the
 * ask pairs the artifact with the machinery that produces it. A session that merely
 * mentions submit_document while working on this repo does not trip it.
 */
function looksLikeDistillationRun(firstUser: string): boolean {
  const t = firstUser.toLowerCase();
  if (!t) return false;
  const asksForDocument =
    /(distill|generate|author|produce|create|write)[^.]{0,40}intent document/.test(t) ||
    /intent document[^.]{0,40}(for this|for the) (repo|branch|change|pr)/.test(t);
  const namesTheMachinery =
    /intent-author|intent-reviewer|record_interview_round|submit_document|require_interview/.test(t);
  return asksForDocument && namesTheMachinery;
}

/** Where the desktop app keeps on-this-machine Cowork sessions, per platform. */
function coworkRoots(): string[] {
  const home = homedir();
  return [
    join(home, "Library", "Application Support", "Claude", "local-agent-mode-sessions"),
    join(home, ".config", "Claude", "local-agent-mode-sessions"),
    join(home, "AppData", "Roaming", "Claude", "local-agent-mode-sessions"),
  ];
}

/**
 * Folder names worth matching a mount against: the repo and its nearest ancestors, since
 * the user connects either the repo itself or a directory containing it. Kept shallow —
 * matching on "Documents" would pull in every unrelated session.
 */
function mountNames(repo: string): string[] {
  return ancestorsInclusive(repo, 2).map((p) => basename(p)).filter((n) => n.length > 1);
}

/**
 * Does this session touch one of those mounts? Reads a bounded head rather than the whole
 * file — mount paths appear early, in the first tool calls, and these sessions run long.
 */
function mentionsMount(path: string, names: string[]): boolean {
  if (names.length === 0) return false;
  let head: string;
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(128 * 1024);
      const n = readSync(fd, buf, 0, buf.length, 0);
      head = buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
  return names.some((n) => head.includes(`/mnt/${n}`));
}

/** Read at most `max` bytes of a file as UTF-8; empty string if unreadable. */
function readBounded(path: string, max: number): string {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(max);
      const n = readSync(fd, buf, 0, max, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}
