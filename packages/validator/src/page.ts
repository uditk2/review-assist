/**
 * Serving a diff in pages.
 *
 * `compute_diff` used to return the whole unified diff beside the `run_id` every later
 * call needs. On a 205,826-byte change that response was 234,337 characters, the client
 * spilled it to disk whole, and the twelve characters of `run_id` went with it — leaving
 * `record_interview_round` and `submit_document` uncallable by a reviewer that has no
 * file access by design. The flow died on exactly the changes big enough to deserve a
 * document.
 *
 * The fix is not a smaller diff, it is a separated one: the handle and the index travel
 * in a bounded envelope, and the bytes come from here, a page at a time.
 *
 * Two rules make the paging safe to reason about.
 *
 * 1. A page is cut on hunk boundaries, never at a byte offset. A hunk is the unit the
 *    anchors already speak in — `"anchors": ["H3"]` — so it is also the unit a reader
 *    should never receive half of. Cutting on bytes would hand back a fragment with no
 *    header and no way to tell which change it belonged to.
 *
 * 2. Except when one hunk is larger than a whole page, which happens the moment a file is
 *    added: in the change that prompted this, `.intent/fix-deterministic-distillation.json`
 *    is a single 26,655-byte hunk. A pager that only ever cuts between hunks can never
 *    serve that one at all — it would ask for a page, receive nothing, and ask again. So a
 *    hunk that cannot fit alone is sliced by LINE and labelled with the lines it carries,
 *    and the cursor grows an offset (`H20:180`). Rare, and the alternative is a deadlock.
 */

import { indexHunks, type IndexedHunk } from "./diff.js";

/**
 * Bytes of hunk text a page carries unless the caller says otherwise. Deliberately well
 * under any known client's tool-result cap: the server truncating on a boundary it chose
 * and reporting a cursor is recoverable, and a client truncating blindly is not.
 */
export const DEFAULT_PAGE_BYTES = 20_000;

/** Rough JSON cost of a slice's own keys, so the budget counts the wire, not the text. */
const PER_SLICE_OVERHEAD = 120;

/**
 * What a string costs once it is JSON, not what it costs as text.
 *
 * Diff text is mostly newlines and quotes, and every one of them doubles on the wire. A
 * budget measured in raw characters therefore under-counts by around 8%: paging the
 * 205,432-character change that prompted this module against a 20,000 budget produced a
 * largest page of 21,645 — over the very ceiling the budget existed to hold. Measuring the
 * encoded form is exact and costs one stringify per line considered.
 */
function wireLen(s: string): number {
  return JSON.stringify(s).length - 2; // less the quotes JSON.stringify adds
}

export interface HunkSlice {
  id: string;
  path: string;
  /** The hunk's `@@ -a,b +c,d @@` header, repeated on every slice so a continuation is placeable. */
  header: string;
  text: string;
  /**
   * Present only when this slice is part of a hunk rather than all of it: the 1-based
   * inclusive line range of the hunk's own lines carried here, out of `hunk_lines`.
   */
  lines?: [number, number];
  hunk_lines?: number;
}

export interface DiffPage {
  hunks: HunkSlice[];
  returned: number;
  /** Hunks in the selection not yet fully served, counting a partly-served one. */
  remaining: number;
  /** Hunks in the selection, whether or not this page reached them. */
  total: number;
  /** Pass back as `cursor` to continue. Absent means the selection is exhausted. */
  next_cursor?: string;
  /** Ids asked for that this diff does not have — a wrong id is said, not silently dropped. */
  unknown_ids?: string[];
  /** Paths asked for that this diff does not touch. */
  unknown_paths?: string[];
}

export interface PageOptions {
  /** Where to resume: `H12`, or `H12:180` inside an oversized hunk. */
  cursor?: string;
  maxBytes?: number;
  /** Serve only these hunks, in diff order. Takes precedence over `paths`. */
  ids?: string[];
  /** Serve only hunks in these files. */
  paths?: string[];
}

export interface CursorParts {
  id?: string;
  offset: number;
}

/** `H12` -> {id:"H12", offset:0}; `H12:180` -> {id:"H12", offset:180}. */
export function parseCursor(cursor?: string): CursorParts {
  if (!cursor) return { offset: 0 };
  const [id, rest] = cursor.split(":", 2);
  const offset = rest === undefined ? 0 : Number(rest);
  if (!/^H\d+$/.test(id) || !Number.isInteger(offset) || offset < 0) {
    throw new Error(`Malformed cursor "${cursor}". Expected "H<n>" or "H<n>:<line-offset>".`);
  }
  return { id, offset };
}

/**
 * One page of a diff's text.
 *
 * Stateless: the caller recomputes the diff from the run's own SHAs and passes it in, the
 * same way `submit_document` recomputes it to resolve anchors. Nothing is cached, so a
 * cursor cannot outlive or disagree with the change it points into.
 */
export function pageDiff(diff: string, opts: PageOptions = {}): DiffPage {
  const lines = diff.split("\n");
  const all = indexHunks(diff);
  const { selection, unknownIds, unknownPaths } = select(all, opts);
  // No floor on the budget. It is tempting to clamp one, but the slicing rule below
  // already guarantees forward progress at any size — a page always carries at least one
  // line — and a silent clamp would mean a caller asking for small pages quietly gets
  // larger ones, which is the class of surprise this whole module exists to remove.
  const budget = opts.maxBytes ?? DEFAULT_PAGE_BYTES;
  const { id: cursorId, offset: cursorOffset } = parseCursor(opts.cursor);

  let start = 0;
  if (cursorId) {
    start = selection.findIndex((h) => h.id === cursorId);
    if (start < 0) {
      throw new Error(
        `Cursor "${opts.cursor}" points at ${cursorId}, which is not in this selection.`
      );
    }
  }

  const out: HunkSlice[] = [];
  let spent = 0;
  let offset = cursorOffset;
  let next: string | undefined;

  for (let i = start; i < selection.length; i++) {
    const h = selection[i];
    const body = hunkBody(lines, h);
    const header = body[0] ?? "";
    const room = budget - spent - PER_SLICE_OVERHEAD - h.path.length - h.id.length;
    const rest = body.slice(offset);
    const restCost = wireLen(rest.join("\n"));

    if (restCost <= room) {
      out.push(makeSlice(h, header, body, offset, body.length));
      spent += restCost + PER_SLICE_OVERHEAD;
      offset = 0;
      continue;
    }

    // Something is already on the page, so stop cleanly on this boundary.
    if (out.length > 0) {
      next = offset > 0 ? `${h.id}:${offset}` : h.id;
      break;
    }

    // Nothing on the page yet and this hunk will not fit alone. Slice it, or the caller
    // asks for a page forever and never receives one. At least one line always goes out.
    const take = Math.max(1, fitLines(rest, room));
    const end = offset + Math.min(take, rest.length);
    out.push(makeSlice(h, header, body, offset, end));
    next = end >= body.length ? nextIdAfter(selection, i) : `${h.id}:${end}`;
    break;
  }

  const remaining = next ? selection.length - indexOfCursor(selection, next) : 0;
  const page: DiffPage = { hunks: out, returned: out.length, remaining, total: selection.length };
  if (next) page.next_cursor = next;
  if (unknownIds.length) page.unknown_ids = unknownIds;
  if (unknownPaths.length) page.unknown_paths = unknownPaths;
  return page;
}

/** A file-level view of the index, for when the per-hunk one will not fit the envelope. */
export interface DiffFileSummary {
  path: string;
  /** `H1-H4`, or `H7` for a single hunk. */
  hunks: string;
  count: number;
  /** How many of them some tour stop must explain. */
  required: number;
}

export function summarizeFiles(hunks: IndexedHunk[]): DiffFileSummary[] {
  const out: DiffFileSummary[] = [];
  for (const h of hunks) {
    const last = out[out.length - 1];
    if (last && last.path === h.path) {
      last.hunks = rangeLabel(firstId(last.hunks), h.id);
      last.count += 1;
      last.required += h.coverage_required ? 1 : 0;
      continue;
    }
    out.push({ path: h.path, hunks: h.id, count: 1, required: h.coverage_required ? 1 : 0 });
  }
  return out;
}

function firstId(label: string): string {
  return label.split("-")[0];
}

function rangeLabel(from: string, to: string): string {
  return from === to ? from : `${from}-${to}`;
}

/**
 * A hunk's own lines.
 *
 * A diff that ends with a newline splits to a trailing empty string, which would otherwise
 * attach itself to the final hunk and make that one hunk's text — alone among all of them —
 * end in a blank line. Only that artifact is trimmed, and only one line of it: an empty
 * line INSIDE a hunk is real content in diffs that do not pad context lines with a space.
 */
function hunkBody(lines: string[], h: IndexedHunk): string[] {
  const body = lines.slice(h.span[0], h.span[1]);
  if (h.span[1] === lines.length && body.length > 1 && body[body.length - 1] === "") body.pop();
  return body;
}

function makeSlice(
  h: IndexedHunk,
  header: string,
  body: string[],
  from: number,
  to: number
): HunkSlice {
  const slice: HunkSlice = {
    id: h.id,
    path: h.path,
    header,
    text: body.slice(from, to).join("\n"),
  };
  if (from > 0 || to < body.length) {
    slice.lines = [from + 1, to];
    slice.hunk_lines = body.length;
  }
  return slice;
}

/** How many leading lines fit in `budget` once joined with newlines and JSON-encoded. */
function fitLines(ls: string[], budget: number): number {
  let used = 0;
  let n = 0;
  for (const l of ls) {
    // The joining newline is itself two characters once encoded.
    const add = wireLen(l) + (n === 0 ? 0 : 2);
    if (used + add > budget) break;
    used += add;
    n += 1;
  }
  return n;
}

function nextIdAfter(selection: IndexedHunk[], i: number): string | undefined {
  return selection[i + 1]?.id;
}

function indexOfCursor(selection: IndexedHunk[], cursor: string): number {
  const id = cursor.split(":", 1)[0];
  const at = selection.findIndex((h) => h.id === id);
  return at < 0 ? selection.length : at;
}

/**
 * Which hunks a walk covers.
 *
 * A walk skips the hunks no tour stop has to explain, and there are only two kinds:
 * whitespace-only churn, and the intent document's own file.
 *
 * The second is the one that matters. `.intent/<branch>.json` is committed on the branch,
 * so from the second commit onward it appears in `base...head` as a whole-file addition —
 * 26,443 characters of the reviewer's OWN previous output, 13% of the change that prompted
 * this module. Serving it is not merely wasteful. The reviewer's first instruction is to
 * read the diff COLD, and handing it last commit's document invites it to echo that prose
 * instead of re-deriving from the change. Nothing reads it: it is excluded from coverage,
 * never anchored, and no prompt mentions it.
 *
 * Naming ids explicitly overrides this. A caller that asks for `H1` has been specific, and
 * the pager has no business second-guessing that — which is also why this needs no flag.
 */
function select(
  all: IndexedHunk[],
  opts: PageOptions
): { selection: IndexedHunk[]; unknownIds: string[]; unknownPaths: string[] } {
  if (opts.ids?.length) {
    const known = new Set(all.map((h) => h.id));
    const want = new Set(opts.ids);
    return {
      selection: all.filter((h) => want.has(h.id)),
      unknownIds: opts.ids.filter((id) => !known.has(id)),
      unknownPaths: [],
    };
  }
  const walkable = all.filter((h) => h.coverage_required);
  if (opts.paths?.length) {
    const known = new Set(all.map((h) => h.path));
    const want = new Set(opts.paths);
    return {
      selection: walkable.filter((h) => want.has(h.path)),
      unknownIds: [],
      unknownPaths: opts.paths.filter((p) => !known.has(p)),
    };
  }
  return { selection: walkable, unknownIds: [], unknownPaths: [] };
}
