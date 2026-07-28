/**
 * Deterministic git + transcript helpers used by the MCP tools.
 * All git work is read-only; the server never mutates the repo except to write
 * the intent document under .intent/.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname, sep } from "node:path";

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
  const projects = join(homedir(), ".claude", "projects");
  if (existsSync(projects)) {
    for (const c of candidates) {
      const dir = join(projects, c.replace(/[/\\]/g, "-"));
      if (existsSync(dir)) {
        for (const f of readdirSync(dir)) {
          if (f.endsWith(".jsonl")) {
            const p = join(dir, f);
            found.push({ path: p, mtime: safeMtime(p) });
          }
        }
      }
    }
  }

  // Codex — sessions are global; match the cwd recorded in each session's head against
  // repo-or-ancestor. Bound the content scan to the most-recent files for speed.
  const codexRoot = join(homedir(), ".codex", "sessions");
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
  const paths = findTranscripts(repoDir, opts.override).slice(0, 30); // recency-bounded scan
  const basenames = Array.from(new Set((opts.changedBasenames ?? []).filter((b) => b && b.length > 2)));
  const branch = opts.branch?.trim();
  const cands: TranscriptCandidate[] = paths.map((p) => {
    let content = "";
    try {
      content = readFileSync(p, "utf8");
    } catch {
      /* unreadable — skip content-based signals */
    }
    if (content.length > 1_000_000) content = content.slice(0, 500_000) + content.slice(-500_000);
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
      looks_like_distillation_run: looksLikeDistillationRun(firstUserText(lines)),
      last_activity: previewLast(lines),
      relevance,
    };
  });
  cands.sort((a, b) => b.relevance - a.relevance || b.mtime - a.mtime);
  return cands.slice(0, opts.limit ?? 8);
}

/**
 * The opening ask, with injected boilerplate stripped.
 *
 * The whole point of this preview is that the author can tell one session from another.
 * Clients prepend their own scaffolding to the first user turn — Codex leads with a
 * <recommended_plugins> block, so every session looks identical unless it is removed and
 * the previews become worthless for picking the right transcript.
 */
function previewFirstUser(lines: string[]): string {
  const t = firstUserText(lines);
  return t.slice(0, 240);
}

/** Full text of the first real user turn (boilerplate stripped, not truncated). */
function firstUserText(lines: string[]): string {
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const role = obj.payload?.role ?? obj.message?.role ?? obj.role ?? obj.type;
      if (role === "user") {
        const t = stripInjectedBlocks(flattenText(obj));
        if (t) return t;
      }
    } catch {
      /* ignore non-JSON line */
    }
  }
  return "";
}

/**
 * Remove client-injected wrappers so what remains is what the human actually typed.
 * Tag-agnostic: any <foo>...</foo> block that opens the turn is scaffolding, not an ask.
 */
function stripInjectedBlocks(text: string): string {
  let t = text;
  for (let i = 0; i < 8; i++) {
    const next = t
      .replace(/^\s*<([a-z0-9_-]+)>[\s\S]*?<\/\1>\s*/i, "")
      .replace(/^\s*<[a-z0-9_-]+\/>\s*/i, "");
    if (next === t) break;
    t = next;
  }
  return t.trim();
}

function previewLast(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const t = flattenText(JSON.parse(lines[i]));
      if (t) return t.slice(0, 240);
    } catch {
      /* ignore */
    }
  }
  return "";
}

export interface TranscriptHit {
  index: number;
  role: string;
  score: number;
  /** The matching entry, trimmed around the best-matching span. */
  excerpt: string;
}

/**
 * Search a transcript for the passages that answer a specific question.
 *
 * Hydration does not scale: a long session runs to tens of thousands of entries, and
 * paging the whole thing through a fresh agent's context costs more than the change
 * being reviewed. The interview gives us something better to work with — the reviewer
 * asks about ONE thing, so the author only needs the passages that bear on it.
 *
 * Deterministic and dependency-free: entries are scored by how many query terms they
 * carry (rare terms weigh more, as in tf-idf), with a bonus for user turns, since a
 * question about intent is usually answered by something the user said. Streams
 * line-by-line so file size does not become resident memory.
 */
export function searchTranscript(
  path: string,
  query: string,
  limit = 8,
  contextChars = 600
): { total: number; matched: number; hits: TranscriptHit[] } {
  const terms = Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_.-]+/)
        .filter((t) => t.length > 2 && !STOPWORDS.has(t))
    )
  );
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
  if (terms.length === 0) return { total: lines.length, matched: 0, hits: [] };

  // Document frequency, so a term appearing everywhere counts for little.
  const df = new Map<string, number>();
  const flat: { role: string; text: string; lower: string }[] = lines.map((line) => {
    let role = "unknown";
    let text = "";
    try {
      const obj = JSON.parse(line);
      role = obj.payload?.role ?? obj.message?.role ?? obj.role ?? obj.payload?.type ?? obj.type ?? "unknown";
      text = flattenText(obj);
    } catch {
      text = line;
    }
    const lower = text.toLowerCase();
    for (const t of terms) if (lower.includes(t)) df.set(t, (df.get(t) ?? 0) + 1);
    return { role, text, lower };
  });

  const n = flat.length || 1;
  const hits: TranscriptHit[] = [];
  flat.forEach((e, i) => {
    let score = 0;
    let best = -1;
    for (const t of terms) {
      const at = e.lower.indexOf(t);
      if (at === -1) continue;
      score += Math.log(1 + n / (1 + (df.get(t) ?? 0)));
      if (best === -1 || at < best) best = at;
    }
    if (score <= 0) return;
    if (/user|human/i.test(e.role)) score *= 1.4; // intent usually comes from the user
    const from = Math.max(0, best - Math.floor(contextChars / 3));
    hits.push({
      index: i,
      role: e.role,
      score: Number(score.toFixed(3)),
      excerpt: (from > 0 ? "…" : "") + e.text.slice(from, from + contextChars) +
        (from + contextChars < e.text.length ? "…" : ""),
    });
  });

  hits.sort((a, b) => b.score - a.score);
  return { total: flat.length, matched: hits.length, hits: hits.slice(0, limit) };
}

const STOPWORDS = new Set([
  "the","and","for","was","were","did","does","doing","this","that","with","from","have",
  "has","had","why","how","what","when","where","which","who","are","you","your","its",
  "it's","not","but","any","all","can","could","would","should","there","then","than",
  "into","about","because","been","being","they","them","their","our","use","used","using",
]);

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
