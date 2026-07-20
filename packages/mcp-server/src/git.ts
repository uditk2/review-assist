/**
 * Deterministic git + transcript helpers used by the MCP tools.
 * All git work is read-only; the server never mutates the repo except to write
 * the intent document under .intent/.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
 * Locate the Claude Code JSONL transcript(s) for a repo. Claude Code stores sessions
 * under ~/.claude/projects/<encoded-cwd>/<session>.jsonl. We encode the repo path the
 * same way (path separators → dashes) and return matching files newest-first.
 */
export function findTranscripts(repoDir: string, override?: string): string[] {
  if (override) {
    return existsSync(override) ? [override] : [];
  }
  const base = join(homedir(), ".claude", "projects");
  if (!existsSync(base)) return [];
  const encoded = resolve(repoDir).replace(/[/\\]/g, "-");
  const dir = join(base, encoded);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

export interface TranscriptEntry {
  index: number;
  role: string;
  /** Best-effort flattened text preview of the entry. */
  text: string;
}

/**
 * Read a window of a JSONL transcript as lightweight entries. Paging keeps very long
 * transcripts within a fresh distiller agent's budget.
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
      role = obj.type ?? obj.role ?? obj.message?.role ?? "unknown";
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
    }
  };
  walk(obj);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
