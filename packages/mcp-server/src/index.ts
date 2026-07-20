#!/usr/bin/env node
/**
 * review-assist MCP server.
 *
 * Exposes the tools an agent uses to author and submit an Intent Document:
 *   - get_generation_guide : schema + the two-agent authoring protocol
 *   - compute_diff         : deterministic PR diff + base/head SHAs (read-only git)
 *   - list_transcripts     : locate the session JSONL transcript(s) for the repo
 *   - read_transcript      : page through a transcript (hydrate a fresh distiller)
 *   - submit_document      : validate a candidate; on pass, write .intent/<branch>.json
 *
 * The server never calls a model. Generation is delegated to the calling agent via
 * the guide; the server computes ground truth (diff), provides source (transcript),
 * and gatekeeps the result (validator).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { validate } from "@review-assist/validator";
import { intentDocSchema } from "@review-assist/schema";
import { GENERATION_GUIDE } from "./guide.js";
import {
  computeDiff,
  resolveHeadSha,
  findTranscripts,
  readTranscriptWindow,
  git,
} from "./git.js";

const REPO_DIR = resolve(process.env.REVIEW_ASSIST_REPO ?? process.cwd());

const server = new McpServer({
  name: "review-assist",
  version: "0.1.0",
});

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

server.tool(
  "get_generation_guide",
  "Return the Intent Document JSON Schema and the authoring protocol. Call this first.",
  {},
  async () => {
    const payload = {
      schema: intentDocSchema,
      guide: GENERATION_GUIDE,
      repo_dir: REPO_DIR,
    };
    return textResult(JSON.stringify(payload, null, 2));
  }
);

server.tool(
  "compute_diff",
  "Compute the PR's own unified diff (base...head) plus resolved SHAs. Anchors must use these hunk line numbers and pin to head_sha.",
  {
    base: z.string().describe("Base ref/branch/SHA, e.g. origin/main"),
    head: z.string().default("HEAD").describe("Head ref/SHA (default HEAD)"),
  },
  async ({ base, head }) => {
    try {
      const { diff, baseSha, headSha } = await computeDiff(REPO_DIR, base, head ?? "HEAD");
      return textResult(JSON.stringify({ base_sha: baseSha, head_sha: headSha, diff }, null, 2));
    } catch (e) {
      return textResult(`compute_diff failed: ${(e as Error).message}`, true);
    }
  }
);

server.tool(
  "list_transcripts",
  "Locate the session JSONL transcript(s) for this repo, newest first. Optionally pass an explicit path.",
  {
    path: z.string().optional().describe("Explicit transcript path override"),
  },
  async ({ path }) => {
    const found = findTranscripts(REPO_DIR, path);
    return textResult(JSON.stringify({ transcripts: found }, null, 2));
  }
);

server.tool(
  "read_transcript",
  "Read a window of a session transcript as lightweight entries. Page through long transcripts to hydrate a fresh distiller agent.",
  {
    path: z.string().describe("Transcript path (from list_transcripts)"),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(200).default(50),
  },
  async ({ path, offset, limit }) => {
    try {
      const win = readTranscriptWindow(path, offset ?? 0, limit ?? 50);
      return textResult(JSON.stringify(win, null, 2));
    } catch (e) {
      return textResult(`read_transcript failed: ${(e as Error).message}`, true);
    }
  }
);

server.tool(
  "submit_document",
  "Validate a candidate Intent Document against the diff and head SHA. On pass, write it to .intent/<branch>.json. On failure, returns findings to fix and resubmit.",
  {
    document: z.any().describe("The candidate Intent Document (JSON object)"),
    base: z.string().describe("Base ref/branch/SHA used for the coverage check"),
    head: z.string().default("HEAD"),
    strict: z.boolean().default(false).describe("Fail coverage on any unexplained hunk"),
    write: z.boolean().default(true).describe("Write the document on success"),
  },
  async ({ document, base, head, strict, write }) => {
    let diff = "";
    let headSha = "";
    try {
      const computed = await computeDiff(REPO_DIR, base, head ?? "HEAD");
      diff = computed.diff;
      headSha = computed.headSha;
    } catch (e) {
      return textResult(`could not compute diff for validation: ${(e as Error).message}`, true);
    }

    const report = validate(document, { diff, headSha, strictCoverage: strict ?? false });

    if (!report.ok) {
      return textResult(
        JSON.stringify(
          { ok: false, findings: report.findings, coverage: report.coverage },
          null,
          2
        ),
        true
      );
    }

    let written: string | null = null;
    if (write ?? true) {
      try {
        const branch = (await git(REPO_DIR, ["rev-parse", "--abbrev-ref", head ?? "HEAD"]))
          .trim()
          .replace(/[/\\]/g, "-") || headSha.slice(0, 12);
        const outPath = join(REPO_DIR, ".intent", `${branch}.json`);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, JSON.stringify(document, null, 2) + "\n", "utf8");
        written = outPath;
      } catch (e) {
        return textResult(`document valid but write failed: ${(e as Error).message}`, true);
      }
    }

    return textResult(
      JSON.stringify(
        { ok: true, written, coverage: report.coverage, warnings: report.findings },
        null,
        2
      )
    );
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`review-assist MCP server running (repo: ${REPO_DIR})\n`);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
