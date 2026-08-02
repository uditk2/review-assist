/**
 * Where each environment keeps its sessions.
 *
 * Locating a transcript and reading one are different problems, and they vary along
 * different axes: a Cowork session is stored by Cowork but written in Claude Code's
 * format. So sources locate and parsers read, and they compose rather than nest.
 *
 * This used to be one function with every strategy inlined — the same shape the parsers
 * were in before they were split, and it would have rotted the same way. Adding an
 * environment is now a class and a registry line.
 */

import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type TranscriptEnv = "claude-code" | "codex" | "cowork-local" | "exported";

export interface TranscriptSource {
  readonly env: TranscriptEnv;
  /** Absolute paths of sessions this source believes belong to `repo`. */
  find(repo: string): string[];
}

// ---------------------------------------------------------------- helpers --

export function safeMtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/** [dir, parent, grandparent, …] up to `levels` above `dir`, inclusive of dir. */
export function ancestorsInclusive(dir: string, levels: number): string[] {
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

/** Recursively collect *.jsonl paths up to `depth` directory levels under `root`. */
export function walkJsonl(root: string, depth: number): string[] {
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

/** Read at most `max` bytes as UTF-8; empty string if unreadable. */
export function readBounded(path: string, max: number): string {
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

/** The working directory a Codex session recorded in its meta head, if present. */
export function sessionCwd(path: string): string | null {
  try {
    const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(readBounded(path, 8192));
    return m ? m[1].replace(/\\\\/g, "\\").replace(/\\"/g, '"') : null;
  } catch {
    return null;
  }
}

/** One directory per cwd-encoded path — Claude Code's scheme, and ours. */
export function encodeRepoDir(repo: string): string {
  return resolve(repo).replace(/[/\\]/g, "-");
}

// ---------------------------------------------------------------- sources --

/**
 * Claude Code: ~/.claude/projects/<encoded-cwd>/<session>.jsonl
 *
 * In a workspace holding several repos the agent runs above the changed repo, so a
 * session counts when its recorded cwd is the repo OR any ancestor of it.
 *
 * Parents only. A subagent transcript is never a session: it receives its prompt from the
 * parent with no human in the loop, so it can hold no user ask, no agreed plan and no
 * scope decision. An earlier version returned <session>/subagents/agent-*.jsonl as PEERS
 * of their own parent, so the author could be handed one seventh of a delegated session
 * with no indication of what it belonged to.
 */
export class ClaudeCodeSource implements TranscriptSource {
  readonly env = "claude-code" as const;
  find(repo: string): string[] {
    const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
    if (!existsSync(root)) return [];
    const out: string[] = [];
    for (const candidate of ancestorsInclusive(resolve(repo), 4)) {
      const dir = join(root, encodeRepoDir(candidate));
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (f.isFile() && f.name.endsWith(".jsonl")) out.push(join(dir, f.name));
      }
    }
    return out;
  }
}

/**
 * Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, global rather than per-repo, so
 * each session's recorded cwd is matched against the repo or an ancestor.
 *
 * archived_sessions is included: those are sessions Codex rotated out, and old is exactly
 * when a change's authoring session tends to live by the time anyone reviews it. The
 * content scan is bounded to the most recent files for speed.
 */
export class CodexSource implements TranscriptSource {
  readonly env = "codex" as const;
  find(repo: string): string[] {
    const home = process.env.CODEX_HOME || join(homedir(), ".codex");
    const candidates = new Set(ancestorsInclusive(resolve(repo), 4));
    const out: string[] = [];
    for (const root of [join(home, "sessions"), join(home, "archived_sessions")]) {
      if (!existsSync(root)) continue;
      const recent = walkJsonl(root, 4)
        .map((p) => ({ p, m: safeMtime(p) }))
        .sort((a, b) => b.m - a.m)
        .slice(0, 120);
      for (const { p } of recent) {
        const cwd = sessionCwd(p);
        if (cwd && candidates.has(resolve(cwd))) out.push(p);
      }
    }
    return out;
  }
}

/**
 * Cowork running ON this machine. Neither scheme above reaches it: the transcript is in
 * Claude Code's format but lives under the desktop app's support directory, and every
 * session records a sandbox cwd (/sessions/<name>) rather than the repo. Connected folders
 * are mounted at /sessions/<name>/mnt/<folder>, which IS traceable back to a repo on disk.
 *
 * Not bounded by recency, unlike the Codex scan: a repo's Cowork session is often old while
 * unrelated newer ones crowd it out — one measured here ranked 419th of 442. Scanning every
 * session with a bounded head read costs ~150ms for that corpus, so the cap bought nothing
 * and lost the only matching session.
 */
export class CoworkLocalSource implements TranscriptSource {
  readonly env = "cowork-local" as const;
  private roots(): string[] {
    const home = homedir();
    return [
      join(home, "Library", "Application Support", "Claude", "local-agent-mode-sessions"),
      join(home, ".config", "Claude", "local-agent-mode-sessions"),
      join(home, "AppData", "Roaming", "Claude", "local-agent-mode-sessions"),
    ];
  }
  /** The repo and its nearest ancestors — the user connects one or the other. */
  private mountNames(repo: string): string[] {
    return ancestorsInclusive(resolve(repo), 2).map((p) => basename(p)).filter((n) => n.length > 1);
  }
  private mentionsMount(path: string, names: string[]): boolean {
    if (names.length === 0) return false;
    const head = readBounded(path, 128 * 1024);
    return names.some((n) => head.includes(`/mnt/${n}`));
  }
  find(repo: string): string[] {
    const names = this.mountNames(repo);
    const out: string[] = [];
    for (const root of this.roots()) {
      if (!existsSync(root)) continue;
      for (const p of walkJsonl(root, 8).filter((p) => !p.endsWith("audit.jsonl")).slice(0, 2000)) {
        if (this.mentionsMount(p, names)) out.push(p);
      }
    }
    return out;
  }
}

/**
 * Sessions exported into our own store.
 *
 * A Cowork session running in the CLOUD keeps nothing on the developer's machine: the
 * desktop app holds only the composer draft and an evictable HTTP cache of a partial event
 * stream. The transcript exists — in Claude Code's exact format — inside the container the
 * session runs in, where the Mac-side server cannot reach it. So the container exports it
 * here and this source finds it.
 *
 * Kept rather than treated as a temp file, because an exported session should be referable
 * afterwards the same way an ordinary one is. Stored under our own directory rather than
 * the desktop app's or Claude Code's: a directory another tool owns is a directory that
 * tool can prune, restructure, or list back to the user as a session it never ran.
 */
export class ExportedSource implements TranscriptSource {
  readonly env = "exported" as const;
  find(repo: string): string[] {
    const dir = exportedSessionsDir(repo);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(dir, f));
  }
}

/** Where exports for a repo live. Overridable with REVIEW_ASSIST_HOME, like consent. */
export function exportedSessionsDir(repo: string): string {
  const home = process.env.REVIEW_ASSIST_HOME ?? join(homedir(), ".review-assist");
  return join(home, "sessions", encodeRepoDir(repo));
}

// --------------------------------------------------------------- registry --

export const SOURCES: readonly TranscriptSource[] = [
  new ClaudeCodeSource(),
  new CodexSource(),
  new CoworkLocalSource(),
  new ExportedSource(),
];

/** A located session, tagged with the source that found it. */
export interface LocatedSession {
  path: string;
  env: TranscriptEnv;
  mtime: number;
}

/**
 * Every session any source believes belongs to this repo, newest first.
 *
 * The env comes from the source that produced the path, not from inspecting the path
 * afterwards. Sniffing worked until REVIEW_ASSIST_HOME was pointed somewhere without
 * ".review-assist" in its name and every exported session started reporting "unknown" —
 * the same guess-from-shape mistake the parsers were split to remove.
 */
export function findSessions(repo: string): LocatedSession[] {
  const seen = new Set<string>();
  const found: LocatedSession[] = [];
  for (const source of SOURCES) {
    for (const path of source.find(repo)) {
      if (seen.has(path)) continue;
      seen.add(path);
      found.push({ path, env: source.env, mtime: safeMtime(path) });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}
