/**
 * Intent Document validator.
 *
 * Runs five deterministic checks and returns a structured report. No network,
 * no model calls: the agents write the document, this validator gatekeeps it.
 */

import type { ErrorObject } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { intentDocSchema, type IntentDocument } from "@review-assist/schema";
import {
  parseUnifiedDiff,
  newRange,
  rangesOverlap,
  type DiffFile,
  type DiffHunk,
} from "./diff.js";

export type Severity = "error" | "warning";

export interface Finding {
  check: "schema" | "staleness" | "coverage" | "cross_refs" | "redaction";
  severity: Severity;
  message: string;
  path?: string;
}

export interface ValidateOptions {
  /** Unified diff of the PR (git diff base..head). Required for coverage. */
  diff?: string;
  /** Actual PR head SHA, for the staleness check. */
  headSha?: string;
  /** Fail coverage on any unexplained hunk, not just substantive ones. */
  strictCoverage?: boolean;
  /** Extra secret regexes (as strings) to add to the redaction lint. */
  extraSecretPatterns?: string[];
}

export interface ValidateReport {
  ok: boolean;
  findings: Finding[];
  coverage?: {
    totalHunks: number;
    unexplained: { path: string; hunk: DiffHunk }[];
    dangling: { path: string; anchorIndexPath: string }[];
  };
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateSchema = ajv.compile(intentDocSchema);

const DEFAULT_SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "AWS access key id", re: /AKIA[0-9A-Z]{16}/ },
  { name: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "Slack token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: "Generic API key assignment", re: /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/i },
  { name: "Connection string with credentials", re: /[a-z]+:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/i },
];

export function validate(doc: unknown, opts: ValidateOptions = {}): ValidateReport {
  const findings: Finding[] = [];

  // 1. Schema
  const schemaOk = validateSchema(doc);
  if (!schemaOk) {
    for (const err of validateSchema.errors ?? []) {
      findings.push({ check: "schema", severity: "error", message: formatAjvError(err) });
    }
    // If the document doesn't even parse structurally, the other checks are unreliable.
    return { ok: false, findings };
  }

  const document = doc as IntentDocument;

  // 2. Staleness
  if (opts.headSha) {
    const declared = document.meta.commit_range.head_sha;
    if (!shaMatches(declared, opts.headSha)) {
      findings.push({
        check: "staleness",
        severity: "error",
        message: `Document describes an older version: commit_range.head_sha=${declared} but PR head is ${opts.headSha}. Regenerate the intent document.`,
      });
    }
  }

  // 3. Coverage
  let coverage: ValidateReport["coverage"];
  if (opts.diff !== undefined) {
    coverage = runCoverage(document, opts.diff, findings, opts.strictCoverage ?? false);
  }

  // 4. Cross-references
  runCrossRefs(document, findings);

  // 5. Redaction lint
  runRedaction(document, findings, opts.extraSecretPatterns ?? []);

  const ok = !findings.some((f) => f.severity === "error");
  return { ok, findings, coverage };
}

function runCoverage(
  document: IntentDocument,
  rawDiff: string,
  findings: Finding[],
  strict: boolean
): NonNullable<ValidateReport["coverage"]> {
  const diffFiles = parseUnifiedDiff(rawDiff);

  // Gather every anchor from the tour (verification anchors are supplementary and
  // do not, by themselves, "explain" a change — only tour stops do).
  interface FlatAnchor {
    path: string;
    range: [number, number];
    ref: string;
  }
  const anchors: FlatAnchor[] = [];
  document.tour.forEach((stop) => {
    stop.anchors.forEach((a, i) => {
      anchors.push({
        path: a.path,
        range: newRange({ ...a.hunk, substantive: true }),
        ref: `${stop.id}.anchors[${i}]`,
      });
    });
  });

  const anchorMatched = new Array(anchors.length).fill(false);
  const unexplained: { path: string; hunk: DiffHunk }[] = [];
  let totalHunks = 0;

  for (const file of diffFiles) {
    // The intent document itself travels in the PR diff — a document must not have to
    // "explain" its own file, so .intent/ changes are excluded from coverage.
    if (isIntentPath(file.path)) continue;
    for (const hunk of file.hunks) {
      totalHunks++;
      const hunkRange = newRange(hunk);
      let covered = false;
      anchors.forEach((anchor, idx) => {
        if (anchor.path === file.path && rangesOverlap(anchor.range, hunkRange)) {
          covered = true;
          anchorMatched[idx] = true;
        }
      });
      if (!covered) {
        const matters = strict || hunk.substantive;
        if (matters) {
          unexplained.push({ path: file.path, hunk });
          findings.push({
            check: "coverage",
            severity: "error",
            path: file.path,
            message: `Unexplained change: ${file.path} lines ${hunkRange[0]}-${hunkRange[1]} (new side) are not covered by any tour stop.`,
          });
        }
      }
    }
  }

  const dangling: { path: string; anchorIndexPath: string }[] = [];
  anchors.forEach((anchor, idx) => {
    if (!anchorMatched[idx]) {
      dangling.push({ path: anchor.path, anchorIndexPath: anchor.ref });
      findings.push({
        check: "coverage",
        severity: "warning",
        path: anchor.path,
        message: `Dangling anchor: ${anchor.ref} points at ${anchor.path} lines ${anchor.range[0]}-${anchor.range[1]} but no diff hunk overlaps it (stale anchor?).`,
      });
    }
  });

  return { totalHunks, unexplained, dangling };
}

function runCrossRefs(document: IntentDocument, findings: Finding[]): void {
  const tourIds = new Set(document.tour.map((t) => t.id));

  // Assumption.depends should point at real tour stops.
  for (const a of document.assumptions) {
    for (const dep of a.depends ?? []) {
      if (dep.startsWith("T") && !tourIds.has(dep)) {
        findings.push({
          check: "cross_refs",
          severity: "error",
          message: `Assumption ${a.id} depends on unknown tour stop "${dep}".`,
        });
      }
    }
  }

  // tour.parent must reference an existing stop.
  for (const t of document.tour) {
    if (t.parent != null && !tourIds.has(t.parent)) {
      findings.push({
        check: "cross_refs",
        severity: "error",
        message: `Tour stop ${t.id} has parent "${t.parent}" which does not exist.`,
      });
    }
    if (t.parent === t.id) {
      findings.push({
        check: "cross_refs",
        severity: "error",
        message: `Tour stop ${t.id} is its own parent.`,
      });
    }
  }

  // Duplicate ids.
  reportDuplicates(document.tour.map((t) => t.id), "tour stop", findings);
  reportDuplicates(document.assumptions.map((a) => a.id), "assumption", findings);
  reportDuplicates((document.open_questions ?? []).map((q) => q.id), "open question", findings);
}

function reportDuplicates(ids: string[], label: string, findings: Finding[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      findings.push({
        check: "cross_refs",
        severity: "error",
        message: `Duplicate ${label} id "${id}".`,
      });
    }
    seen.add(id);
  }
}

function runRedaction(document: IntentDocument, findings: Finding[], extra: string[]): void {
  const patterns = [
    ...DEFAULT_SECRET_PATTERNS,
    ...extra.map((src, i) => ({ name: `custom pattern #${i + 1}`, re: new RegExp(src) })),
  ];
  for (const { field, value } of walkStrings(document)) {
    for (const { name, re } of patterns) {
      if (re.test(value)) {
        findings.push({
          check: "redaction",
          severity: "error",
          path: field,
          message: `Possible secret (${name}) in field "${field}". Redact before publishing.`,
        });
      }
    }
  }
}

function* walkStrings(obj: unknown, prefix = ""): Generator<{ field: string; value: string }> {
  if (typeof obj === "string") {
    yield { field: prefix || "(root)", value: obj };
  } else if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      yield* walkStrings(obj[i], `${prefix}[${i}]`);
    }
  } else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      yield* walkStrings(v, prefix ? `${prefix}.${k}` : k);
    }
  }
}

/** Paths that are part of Review Assist's own bookkeeping, excluded from coverage. */
function isIntentPath(path: string): boolean {
  return path === ".intent" || path.startsWith(".intent/");
}

function shaMatches(a: string, b: string): boolean {
  const min = Math.min(a.length, b.length);
  if (min < 7) return a === b;
  return a.slice(0, min) === b.slice(0, min);
}

function formatAjvError(err: ErrorObject): string {
  const loc = err.instancePath || "(root)";
  return `Schema violation at ${loc}: ${err.message}${
    err.params && Object.keys(err.params).length ? ` (${JSON.stringify(err.params)})` : ""
  }`;
}

export { parseUnifiedDiff, indexHunks } from "./diff.js";
export type { DiffFile, DiffHunk, IndexedHunk } from "./diff.js";
export { renderMarkdown, renderPrDescription, orderTour, type RenderOptions } from "./render.js";
