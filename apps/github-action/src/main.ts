/**
 * Intent Document Check — GitHub Action entry point.
 *
 * Runs entirely on the user's runner. Reads the committed intent document, fetches
 * the PR diff via the API, validates (schema/staleness/coverage/cross-refs/redaction),
 * posts a sticky guided-review comment, and fails the check on any error.
 */

import * as core from "@actions/core";
import * as github from "@actions/github";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { validate, renderMarkdown } from "@review-assist/validator";
import type { IntentDocument } from "@review-assist/schema";

const COMMENT_MARKER = "<!-- review-assist:sticky -->";

async function run(): Promise<void> {
  const context = github.context;
  const pr = context.payload.pull_request;
  if (!pr) {
    core.info("Not a pull_request event; skipping.");
    return;
  }

  const token = core.getInput("github-token");
  const viewerUrl = core.getInput("viewer-url");
  const strict = core.getBooleanInput("strict");
  const shouldComment = core.getBooleanInput("comment");
  const octokit = github.getOctokit(token);
  const { owner, repo } = context.repo;

  const branch = pr.head.ref as string;
  const headSha = pr.head.sha as string;
  const baseSha = pr.base.sha as string;

  // 1. Locate the document.
  const docPath = resolveDocPath(core.getInput("doc-path"), branch);
  if (!docPath) {
    await fail(
      octokit, owner, repo, pr.number, shouldComment,
      `No intent document found. Expected \`.intent/${branch}.json\` (or set \`doc-path\`). ` +
      `Generate one from your coding session before requesting review.`
    );
    core.setFailed("Intent document not found.");
    return;
  }
  core.info(`Using intent document: ${docPath}`);

  let doc: IntentDocument;
  try {
    doc = JSON.parse(readFileSync(docPath, "utf8"));
  } catch (e) {
    core.setFailed(`Could not parse ${docPath}: ${(e as Error).message}`);
    return;
  }

  // 2. Fetch the PR diff (base...head) via the compare API — no local fetch depth needed.
  let diff = "";
  try {
    const cmp = await octokit.rest.repos.compareCommitsWithBasehead({
      owner, repo,
      basehead: `${baseSha}...${headSha}`,
      mediaType: { format: "diff" },
    });
    diff = cmp.data as unknown as string;
  } catch (e) {
    core.warning(`Could not fetch diff (${(e as Error).message}); running without coverage check.`);
  }

  // 3. Validate.
  const report = validate(doc, {
    diff: diff || undefined,
    headSha,
    strictCoverage: strict,
  });

  for (const f of report.findings) {
    const line = `[${f.check}] ${f.message}`;
    if (f.severity === "error") core.error(line);
    else core.warning(line);
  }
  if (report.coverage) {
    const c = report.coverage;
    core.info(`Coverage: ${c.totalHunks - c.unexplained.length}/${c.totalHunks} hunks explained.`);
  }

  // 4. Comment.
  if (shouldComment) {
    const viewer = viewerUrl
      ? `${viewerUrl.replace(/\/$/, "")}/#${owner}/${repo}/pull/${pr.number}`
      : undefined;
    const body = buildComment(doc, report, viewer);
    await upsertComment(octokit, owner, repo, pr.number, body);
  }

  // 5. Verdict.
  if (!report.ok) {
    core.setFailed(
      `Intent Document check failed: ${report.findings.filter((f) => f.severity === "error").length} error(s).`
    );
  } else {
    core.info("Intent Document check passed.");
  }
}

function resolveDocPath(input: string, branch: string): string | null {
  if (input) return existsSync(input) ? input : null;
  const byBranch = join(".intent", `${branch.replace(/[/\\]/g, "-")}.json`);
  if (existsSync(byBranch)) return byBranch;
  // Fallback: a single .intent/*.json.
  if (existsSync(".intent")) {
    const jsons = readdirSync(".intent").filter((f) => f.endsWith(".json"));
    if (jsons.length === 1) return join(".intent", jsons[0]);
  }
  return null;
}

function buildComment(
  doc: IntentDocument,
  report: ReturnType<typeof validate>,
  viewer?: string
): string {
  const header = report.ok
    ? `${COMMENT_MARKER}\n> ✅ **Intent Document check passed.**\n`
    : `${COMMENT_MARKER}\n> ❌ **Intent Document check failed** — ${report.findings
        .filter((f) => f.severity === "error")
        .map((f) => f.message)
        .join("; ")}\n`;
  return header + "\n" + renderMarkdown(doc, { viewerUrl: viewer });
}

async function upsertComment(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string
): Promise<void> {
  const existing = await octokit.rest.issues.listComments({ owner, repo, issue_number: issueNumber, per_page: 100 });
  const mine = existing.data.find((c) => c.body?.includes(COMMENT_MARKER));
  if (mine) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body });
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
  }
}

async function fail(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  issueNumber: number,
  shouldComment: boolean,
  message: string
): Promise<void> {
  if (shouldComment) {
    await upsertComment(octokit, owner, repo, issueNumber, `${COMMENT_MARKER}\n> ❌ ${message}`);
  }
}

run().catch((e) => core.setFailed((e as Error).message));
