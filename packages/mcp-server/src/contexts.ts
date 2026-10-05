/**
 * The session, divided into what it was ABOUT.
 *
 * The spine is complete and that is its virtue: a session is a median 4.8% conversation
 * and 95% tool output, and serving all of the 4.8% removes the one failure retrieval can
 * never rule out, an answer nobody found. But complete is not the same as relevant. A
 * session where fifteen options were weighed and two shipped carries thirteen that the
 * reviewer has no reason to hear about, and the author pays for them on every question it
 * answers.
 *
 * So the conversation is divided into BLOCKS and labelled.
 *
 * A block is a run of consecutive exchanges — both directions, counter-questions and
 * follow-ups included — that are about one thing. The boundary is a change of subject, not
 * a change of speaker: "yes, do that" belongs to the exchange it answers, and a block that
 * ended at every user turn would cut a negotiation into halves that mean nothing apart.
 *
 * A CONTEXT is a subject, and it owns one or more blocks. The two are separate because
 * topics interleave: a session goes A, B, then back to A, and filtering per block would
 * keep half of A and drop the rest, leaving the surviving half unreadable. Verdicts apply
 * to contexts.
 *
 * The LABEL is one plain sentence, and it does the work. It is matched twice — against the
 * diff to decide what survives, and against each of the reviewer's questions to decide
 * what to re-read — so "spine paging" matches nothing, while "weighed three ways to page
 * the spine and settled on item boundaries" matches both.
 *
 * WHAT THIS MODULE OWNS, and what it does not. Boundaries and labels need judgement, so
 * they come from outside: whoever reads the session reports them here. Everything else is
 * deterministic and lives here — where a pass resumes, which files a block touched, how a
 * pass merges into what is already stored, and when the store must be thrown away.
 *
 * THE INDEX HOLDS POINTERS, NEVER PROSE. A context is index ranges into the transcript.
 * Copying the text in would grow the index as fast as the session and buy nothing, since
 * `get_spine` can already serve any range. It is also what bounds the cost of indexing
 * whatever model does it: one sentence per block, and no quoting.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseEntry } from "./transcript/index.js";
import { toRepoRelative } from "./footprint.js";

function homeDir(): string {
  return process.env.REVIEW_ASSIST_HOME ?? join(homedir(), ".review-assist");
}

function indexDir(): string {
  return join(homeDir(), "contexts");
}

function indexFile(sessionPath: string): string {
  return join(indexDir(), `${basename(sessionPath).replace(/\.jsonl$/, "")}.json`);
}

/** Bumped when a stored index means something different, so an old one rebuilds. */
const INDEX_VERSION = 1;

/** One contiguous stretch of the transcript, inclusive at both ends. */
export interface Block {
  from: number;
  to: number;
  /**
   * The conversation was still on this subject at the end of what the pass read, so the
   * block may continue into entries nobody has seen yet.
   *
   * This is the one thing that makes incremental indexing correct rather than merely
   * cheap. Close a block at the end of a pass and the next pass sees more of the same
   * conversation and has no choice but to mint a SECOND context for a subject already
   * labelled — or to append to a block whose label was written from half the evidence.
   * Neither is recoverable afterwards, and neither is visible when it happens.
   */
  open?: boolean;
}

/** A subject, and everywhere in the session it was discussed. */
export interface SessionContext {
  /** Stable within a session: C1, C2, … */
  id: string;
  /** One plain sentence: the subject, and what happened to it. */
  label: string;
  blocks: Block[];
  /**
   * Repo-relative files the blocks touched. Derived here rather than reported, because it
   * is a deterministic read of the transcript and asking a model for it would be both
   * slower and less reliable than computing it.
   */
  files: string[];
}

export interface ContextIndex {
  v: number;
  session: string;
  /** Entries anyone has looked at. */
  scanned_through: number;
  /**
   * Last entry of the last CLOSED block: where the next pass resumes.
   *
   * Always at or behind `scanned_through`, and the gap is the provisional tail. A pass
   * re-reads exactly that tail, which is one block, and that is the whole price of getting
   * an interleaved or continuing subject right.
   */
  closed_through: number;
  /** Size and entry count when last scanned, to notice a transcript replaced under us. */
  size: number;
  entries: number;
  contexts: SessionContext[];
}

function emptyIndex(sessionPath: string): ContextIndex {
  return {
    v: INDEX_VERSION,
    session: basename(sessionPath).replace(/\.jsonl$/, ""),
    scanned_through: -1,
    closed_through: -1,
    size: 0,
    entries: 0,
    contexts: [],
  };
}

/** Lines in a transcript, which is the entry count the watermarks are measured in. */
export function countEntries(sessionPath: string): number {
  try {
    return readFileSync(sessionPath, "utf8").split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/**
 * The stored index for a session, or an empty one.
 *
 * Thrown away rather than trusted when the transcript it describes has changed
 * incompatibly. Transcripts are append-only in normal operation, but `import_session`
 * OVERWRITES by design — a live cloud session keeps growing, so a second export must
 * replace the first — and a replaced file can differ anywhere, including before the
 * watermark. A file that shrank, or whose entry count went backwards, cannot be the one
 * this index was built from.
 */
export function readIndex(sessionPath: string): ContextIndex {
  const fresh = emptyIndex(sessionPath);
  let stored: ContextIndex;
  try {
    stored = JSON.parse(readFileSync(indexFile(sessionPath), "utf8")) as ContextIndex;
  } catch {
    return fresh;
  }
  if (stored.v !== INDEX_VERSION) return fresh;

  let size = 0;
  try {
    size = statSync(sessionPath).size;
  } catch {
    return fresh;
  }
  const entries = countEntries(sessionPath);
  if (size < stored.size || entries < stored.entries) return fresh;
  return stored;
}

function writeIndex(sessionPath: string, index: ContextIndex): void {
  mkdirSync(indexDir(), { recursive: true });
  writeFileSync(indexFile(sessionPath), JSON.stringify(index), "utf8");
}

/** Whether a session has ever been indexed. */
export function isIndexed(sessionPath: string): boolean {
  return existsSync(indexFile(sessionPath));
}

export interface ResumePoint {
  /** First entry the next pass must read. */
  from: number;
  /** Entries in the transcript now. `from > last` means there is nothing new. */
  last: number;
  /** The labels already known, so a new block can join a subject instead of duplicating it. */
  known: { id: string; label: string }[];
  /** True when nothing was stored, or what was stored could not be trusted. */
  cold: boolean;
}

/**
 * Where to start, and what is already known.
 *
 * `known` is the reason a pass is cheap AND correct: without the existing labels in front
 * of it, a pass that meets subject A again has no way to tell it is A, and mints a second
 * context for it. With them, the input to every pass is the label list plus the new
 * entries, and never the whole session however long it grows.
 */
export function resumePoint(sessionPath: string): ResumePoint {
  const index = readIndex(sessionPath);
  const cold = index.scanned_through < 0;
  return {
    from: index.closed_through + 1,
    last: countEntries(sessionPath) - 1,
    known: index.contexts.map((c) => ({ id: c.id, label: c.label })),
    cold,
  };
}

/** Every repo file the entries in `[from, to]` touched. */
function filesIn(entries: Record<string, unknown>[], from: number, to: number, repoDir: string): string[] {
  const out = new Set<string>();
  for (let i = Math.max(0, from); i <= Math.min(to, entries.length - 1); i++) {
    for (const e of parseEntry(entries[i]).events) {
      for (const p of [e.path, ...(e.paths ?? [])]) {
        if (!p) continue;
        const rel = toRepoRelative(p, repoDir);
        if (rel) out.add(rel);
      }
    }
  }
  return Array.from(out).sort();
}

export interface ReportedContext {
  /** An existing id to extend a known subject, or omitted to mint a new one. */
  id?: string;
  label: string;
  blocks: Block[];
}

/**
 * Merge a pass into the store.
 *
 * The merge rule is a replacement, not an append: everything from `from` onwards is
 * re-reported by this pass, including the provisional tail it re-read, so blocks at or
 * after `from` are dropped before the new ones go in. Appending instead would double every
 * re-read block, and the duplicate would be invisible — two blocks over the same entries,
 * both plausible.
 *
 * A context left with no blocks is removed. That happens when a pass decides the tail it
 * re-read belonged to a different subject after all, which is exactly what re-reading it
 * was for.
 */
export function recordContexts(
  sessionPath: string,
  repoDir: string,
  pass: { from: number; scanned_through: number; contexts: ReportedContext[] }
): ContextIndex {
  const index = readIndex(sessionPath);
  const entries = readFileSync(sessionPath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return {};
      }
    });

  const byId = new Map<string, SessionContext>();
  for (const c of index.contexts) {
    const kept = c.blocks.filter((b) => b.from < pass.from);
    if (kept.length) byId.set(c.id, { ...c, blocks: kept });
  }

  let next = index.contexts.reduce((m, c) => Math.max(m, Number(c.id.slice(1)) || 0), 0);
  for (const r of pass.contexts) {
    if (!r.blocks.length) continue;
    const existing = r.id ? byId.get(r.id) : undefined;
    if (existing) {
      existing.blocks = [...existing.blocks, ...r.blocks];
      // A later pass has seen more of the subject than the one that first named it.
      existing.label = r.label;
    } else {
      const id = r.id && !byId.has(r.id) ? r.id : `C${++next}`;
      byId.set(id, { id, label: r.label, blocks: [...r.blocks], files: [] });
    }
  }

  const contexts = Array.from(byId.values())
    .map((c) => {
      const blocks = [...c.blocks].sort((a, b) => a.from - b.from);
      const files = new Set<string>();
      for (const b of blocks) for (const f of filesIn(entries, b.from, b.to, repoDir)) files.add(f);
      return { ...c, blocks, files: Array.from(files).sort() };
    })
    .sort((a, b) => (a.blocks[0]?.from ?? 0) - (b.blocks[0]?.from ?? 0));

  // The provisional tail: the earliest still-open block is where the next pass must start.
  const openFrom = contexts
    .flatMap((c) => c.blocks)
    .filter((b) => b.open)
    .reduce<number | undefined>((m, b) => (m === undefined ? b.from : Math.min(m, b.from)), undefined);

  const merged: ContextIndex = {
    ...index,
    scanned_through: Math.max(index.scanned_through, pass.scanned_through),
    closed_through: (openFrom !== undefined ? openFrom - 1 : pass.scanned_through),
    size: (() => {
      try {
        return statSync(sessionPath).size;
      } catch {
        return index.size;
      }
    })(),
    entries: entries.length,
    contexts,
  };
  writeIndex(sessionPath, merged);
  return merged;
}

/** How a context relates to the change under review. */
export interface ContextScore {
  id: string;
  label: string;
  /** Files this context touched that the diff also changed. */
  overlap: string[];
  /** Files it touched that the diff did NOT change: work that did not survive. */
  only_here: string[];
  /** Index ranges, so a caller can read it with get_spine. */
  blocks: Block[];
}

/**
 * Each context against the diff's changed paths.
 *
 * A SIGNAL, not a verdict, and the distinction is deliberate. File overlap is cheap and
 * mechanical; whether a context earns its place is not. A context whose files are all
 * absent from the diff may be the single most valuable thing in the session — an approach
 * tried on this very code and abandoned, which is what `approach.trials` exists to carry —
 * or it may be an afternoon spent on something else entirely. Only the label says which,
 * so the caller decides and this reports what it can count.
 */
export function scoreContexts(contexts: SessionContext[], changedPaths: string[]): ContextScore[] {
  const changed = new Set(changedPaths);
  return contexts.map((c) => ({
    id: c.id,
    label: c.label,
    overlap: c.files.filter((f) => changed.has(f)),
    only_here: c.files.filter((f) => !changed.has(f)),
    blocks: c.blocks,
  }));
}
