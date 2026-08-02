/**
 * Importing a session that has no home on this machine.
 *
 * A cloud Cowork session's transcript lives in the container it ran in. The container can
 * write into a connected folder but not into our store, so it drops the file somewhere
 * reachable and calls this to file it properly.
 *
 * Overwrite is the default and the point: a live session keeps growing, so re-exporting
 * mid-distillation must replace the earlier copy rather than accumulate near-duplicates
 * that the ranking would then have to choose between.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { exportedSessionsDir } from "./sources.js";

export interface ImportResult {
  stored_path: string;
  session_id: string;
  bytes: number;
  overwrote: boolean;
}

/** File a transcript into this repo's export store, replacing any earlier copy of it. */
export function importSession(opts: {
  repo: string;
  from: string;
  sessionId?: string;
}): ImportResult {
  const from = resolve(opts.from);
  if (!existsSync(from)) throw new Error(`no such file: ${from}`);
  const sessionId = (opts.sessionId ?? basename(from).replace(/\.jsonl$/, "")).replace(/[^A-Za-z0-9._-]/g, "-");
  const dir = exportedSessionsDir(opts.repo);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${sessionId}.jsonl`);
  const overwrote = existsSync(dest);
  copyFileSync(from, dest);
  return { stored_path: dest, session_id: sessionId, bytes: statSync(dest).size, overwrote };
}

export function listImported(repo: string): { path: string; bytes: number }[] {
  const dir = exportedSessionsDir(repo);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ path: join(dir, f), bytes: statSync(join(dir, f)).size }));
}

export function forgetImported(repo: string, sessionId: string): boolean {
  const p = join(exportedSessionsDir(repo), `${sessionId}.jsonl`);
  if (!existsSync(p)) return false;
  rmSync(p, { force: true });
  return true;
}
