/**
 * Deterministic git + transcript helpers used by the MCP tools.
 * All git work is read-only; the server never mutates the repo except to write
 * the intent document under .intent/.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { parseEntry } from "./transcript/index.js";
import { findSessions, readBounded, safeMtime, sessionCwd, type TranscriptEnv } from "./transcript/sources.js";

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
  //
  // `.intent/` is excluded at the source rather than filtered downstream. The document is
  // this tool's own output, and from a branch's second commit onward it arrives as a
  // whole-file addition — 630 lines on the run that prompted this. Leaving it in the diff
  // cost twice over: it sorts first in git's path order, so it landed as H1 and shifted
  // every other hunk id by one whenever the document was committed, silently misanchoring
  // any regeneration; and an anchor pointing into it was reported by the coverage checker
  // as "dangling ... (stale anchor?)" even though the id came straight from compute_diff's
  // own index.
  //
  // Excluding it HERE fixes both, because this is the single place a diff is produced:
  // compute_diff, read_diff and submit_document all come through this function, so the
  // ids handed out, the text paged, and the diff validated against cannot disagree. It also
  // keeps the property that counting hunks in the raw diff reproduces the index — which
  // excluding it from the NUMBERING instead would have broken.
  const diff = await git(repoDir, [
    "diff",
    "--no-color",
    `${baseSha}...${headSha}`,
    "--",
    ":(exclude).intent/",
  ]);
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
  if (override) return existsSync(override) ? [override] : [];
  return findSessions(repoDir).map((s) => s.path);
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
  agent: TranscriptEnv | "unknown";
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
  const located = opts.override
    ? (existsSync(opts.override) ? [{ path: opts.override, env: "unknown" as const, mtime: safeMtime(opts.override) }] : [])
    : findSessions(repoDir);
  const paths = located.slice(0, 80);
  const basenames = Array.from(new Set((opts.changedBasenames ?? []).filter((b) => b && b.length > 2)));
  const branch = opts.branch?.trim();
  const cands: TranscriptCandidate[] = paths.map(({ path: p, env }) => {
    // Bounded read: scoring only needs to know whether the session mentions the changed
    // files, and slurping multi-megabyte sessions whole to then discard most of it made the
    // scan cost scale with session length rather than with the number of candidates.
    let content = readBounded(p, 1_000_000);
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const agent = env;
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

