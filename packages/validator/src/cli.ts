#!/usr/bin/env node
/**
 * review-assist CLI.
 *
 *   review-assist validate <doc.json> [--diff <file>] [--head <sha>] [--strict] [--json]
 *   review-assist render   <doc.json> [--viewer <url>]
 *
 * Exit code 0 = ok, 1 = validation errors, 2 = usage/IO error.
 */

import { readFileSync } from "node:fs";
import { validate, type ValidateReport } from "./index.js";
import { renderMarkdown } from "./render.js";
import type { IntentDocument } from "@review-assist/schema";

function fail(msg: string, code = 2): never {
  process.stderr.write(`review-assist: ${msg}\n`);
  process.exit(code);
}

function parseFlags(args: string[]): { positional: string[]; flags: Map<string, string | boolean> } {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    fail(`could not read/parse ${path}: ${(e as Error).message}`);
  }
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseFlags(rest);

  if (!command || command === "help" || flags.has("help")) {
    process.stdout.write(USAGE);
    process.exit(command ? 0 : 2);
  }

  if (command === "validate") {
    const docPath = positional[0];
    if (!docPath) fail("validate requires a document path");
    const doc = readJson(docPath);
    const diff = flags.has("diff") ? readFileSync(String(flags.get("diff")), "utf8") : undefined;
    const headSha = flags.has("head") ? String(flags.get("head")) : undefined;
    const strictCoverage = Boolean(flags.get("strict"));

    const report = validate(doc, { diff, headSha, strictCoverage });

    if (flags.has("json")) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      printReport(report);
    }
    process.exit(report.ok ? 0 : 1);
  }

  if (command === "render") {
    const docPath = positional[0];
    if (!docPath) fail("render requires a document path");
    const doc = readJson(docPath) as IntentDocument;
    const viewerUrl = flags.has("viewer") ? String(flags.get("viewer")) : undefined;
    process.stdout.write(renderMarkdown(doc, { viewerUrl }) + "\n");
    process.exit(0);
  }

  fail(`unknown command "${command}"\n\n${USAGE}`);
}

function printReport(report: ValidateReport) {
  const errors = report.findings.filter((f) => f.severity === "error");
  const warnings = report.findings.filter((f) => f.severity === "warning");

  for (const f of report.findings) {
    const icon = f.severity === "error" ? "✗" : "⚠";
    process.stderr.write(`${icon} [${f.check}] ${f.message}\n`);
  }

  if (report.coverage) {
    const { totalHunks, unexplained, dangling } = report.coverage;
    process.stderr.write(
      `\ncoverage: ${totalHunks - unexplained.length}/${totalHunks} hunks explained` +
        (dangling.length ? `, ${dangling.length} dangling anchor(s)` : "") +
        `\n`
    );
  }

  process.stderr.write(
    `\n${report.ok ? "PASS" : "FAIL"} — ${errors.length} error(s), ${warnings.length} warning(s)\n`
  );
}

const USAGE = `review-assist — validate and render Intent Documents

Usage:
  review-assist validate <doc.json> [options]
  review-assist render   <doc.json> [--viewer <url>]

validate options:
  --diff <file>   Unified diff (git diff base..head) for the coverage check
  --head <sha>    PR head SHA for the staleness check
  --strict        Fail coverage on any unexplained hunk, incl. whitespace-only
  --json          Emit the machine-readable report
`;

main();
