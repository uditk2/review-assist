/**
 * Minimal unified-diff parser.
 *
 * Extracts, per changed file, the set of hunks with their old/new line ranges,
 * and whether each hunk contains any non-whitespace change. This is the ground
 * truth the coverage check compares intent-document anchors against.
 */

export interface DiffHunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  /** True if any added/removed line has non-whitespace content. */
  substantive: boolean;
}

export interface DiffFile {
  /** Post-image path (the "b/" side). For deletions, the pre-image path. */
  path: string;
  hunks: DiffHunk[];
}

const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified diff (as produced by `git diff`) into a list of files and hunks.
 */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const lines = diff.split("\n");
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;
  let renameFrom: string | null = null;

  const flushHunk = () => {
    if (current && currentHunk) current.hunks.push(currentHunk);
    currentHunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fileMatch = FILE_HEADER.exec(line);
    if (fileMatch) {
      flushHunk();
      // Default to the b/ path; may be refined by ---/+++ headers below.
      current = { path: fileMatch[2], hunks: [] };
      files.push(current);
      renameFrom = null;
      continue;
    }

    if (!current) continue;

    if (line.startsWith("--- ")) {
      renameFrom = stripPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      const to = stripPrefix(line.slice(4));
      // /dev/null on the +++ side means a deletion; keep the pre-image path.
      if (to === "/dev/null" && renameFrom && renameFrom !== "/dev/null") {
        current.path = renameFrom;
      } else if (to !== "/dev/null") {
        current.path = to;
      }
      continue;
    }

    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      flushHunk();
      currentHunk = {
        old_start: Number(hunkMatch[1]),
        old_lines: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        new_start: Number(hunkMatch[3]),
        new_lines: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        substantive: false,
      };
      continue;
    }

    if (currentHunk && (line.startsWith("+") || line.startsWith("-"))) {
      // Ignore the +++/--- headers already handled above.
      const content = line.slice(1);
      if (content.trim().length > 0) currentHunk.substantive = true;
    }
  }

  flushHunk();
  return files;
}

function stripPrefix(p: string): string {
  const trimmed = p.trim();
  if (trimmed === "/dev/null") return trimmed;
  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) return trimmed.slice(2);
  return trimmed;
}

/** Inclusive [start, end] of the new-side line range of a hunk. */
export function newRange(h: DiffHunk): [number, number] {
  if (h.new_lines === 0) return [h.new_start, h.new_start];
  return [h.new_start, h.new_start + h.new_lines - 1];
}

/** Do two inclusive integer ranges overlap? */
export function rangesOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}
