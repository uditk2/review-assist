/**
 * GitHub App webhook: the "install once, zero-config" path.
 *
 * On a pull_request event we verify the signature, mint an installation token, read the
 * committed .intent document + diff, compute coverage, and post a Check Run + a sticky
 * summary comment with an "Open guided review" deep link — all as the app bot. No repo
 * needs a workflow file. Comment-only: we never fail a check (conclusion neutral/success).
 *
 * Statelessness holds: we validate per-event and discard; nothing is persisted.
 */

import { installationToken } from "./githubApp.js";

const GH_API = "https://api.github.com";
const UA = "review-assist-viewer";
const MARKER = "<!-- review-assist -->";

export interface WebhookEnv {
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
}

interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

export async function handleWebhook(request: Request, origin: string, env: WebhookEnv, ctx: Ctx): Promise<Response> {
  const body = await request.text();
  const sig = request.headers.get("x-hub-signature-256") ?? "";
  if (!(await verifySignature(body, sig, env.GITHUB_WEBHOOK_SECRET))) {
    return new Response("invalid signature", { status: 401 });
  }
  const event = request.headers.get("x-github-event");
  if (event === "ping") return json({ ok: true, pong: true });
  if (event !== "pull_request") return json({ ignored: event });

  let payload: PrEvent;
  try {
    payload = JSON.parse(body) as PrEvent;
  } catch {
    return json({ error: "bad json" }, 400);
  }
  if (!["opened", "synchronize", "reopened"].includes(payload.action)) {
    return json({ ignored: payload.action });
  }
  const installationId = payload.installation?.id;
  if (!installationId) return json({ error: "no installation on event" });

  // Respond fast; do the GitHub round-trips after the 202 so we never risk the 10s webhook budget.
  ctx.waitUntil(process(payload, installationId, origin, env).catch((e) => console.error("webhook process failed:", (e as Error).message)));
  return json({ accepted: true }, 202);
}

async function process(payload: PrEvent, installationId: number, origin: string, env: WebhookEnv): Promise<void> {
  const token = await installationToken(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, installationId);
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pr = payload.pull_request;
  const headSha = pr.head.sha;
  const branchFile = pr.head.ref.replace(/[/\\]/g, "-");
  const viewerLink = `${origin}/#${owner}/${repo}/pull/${pr.number}`;

  const gh = (path: string, accept = "application/vnd.github+json") =>
    fetch(`${GH_API}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        "User-Agent": UA,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

  // 1. Intent document (raw) at the PR head.
  const docRes = await gh(
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(`.intent/${branchFile}.json`)}?ref=${headSha}`,
    "application/vnd.github.raw+json"
  );
  const docMissing = !docRes.ok;
  let doc: IntentDoc | null = null;
  if (!docMissing) {
    try {
      doc = JSON.parse(await docRes.text());
    } catch {
      doc = null;
    }
  }

  // 2. Diff (base...head) for coverage.
  let cov = { total: 0, explained: 0 };
  if (doc) {
    const diffRes = await gh(`/repos/${owner}/${repo}/compare/${pr.base.sha}...${headSha}`, "application/vnd.github.diff");
    if (diffRes.ok) cov = computeCoverage(await diffRes.text(), doc);
  }

  // 3. Sticky comment (upsert) + Check Run, as the app bot.
  await upsertComment(gh, token, owner, repo, pr.number, commentBody(doc, cov, viewerLink, docMissing || !doc));
  await createCheck(token, owner, repo, headSha, cov, viewerLink, docMissing || !doc);
}

// ---- signature -------------------------------------------------------------

async function verifySignature(body: string, header: string, secret: string): Promise<boolean> {
  if (!header.startsWith("sha256=") || !secret) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(expected, header);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---- coverage (compact; mirrors the viewer/validator: excludes .intent/) ----

function isIntentPath(p: string): boolean {
  return p === ".intent" || p.startsWith(".intent/");
}

interface Hunk { newStart: number; newLines: number; substantive: boolean; }
interface FileDiff { path: string; hunks: Hunk[]; }

function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let sawContent = false;
  let preImagePath = "";
  const closeHunk = (): void => {
    if (cur && hunk) {
      hunk.substantive = sawContent;
      cur.hunks.push(hunk);
    }
    hunk = null;
    sawContent = false;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) {
      preImagePath = line.slice(4).replace(/^a\//, "").trim();
    } else if (line.startsWith("+++ ")) {
      closeHunk();
      const raw = line.slice(4).replace(/^b\//, "").trim();
      cur = { path: raw === "/dev/null" ? preImagePath : raw, hunks: [] };
      files.push(cur);
    } else if (line.startsWith("@@")) {
      closeHunk();
      const m = line.match(/\+(\d+)(?:,(\d+))?/);
      hunk = {
        newStart: m ? parseInt(m[1], 10) : 0,
        newLines: m && m[2] ? parseInt(m[2], 10) : 1,
        substantive: false,
      };
    } else if (hunk && (line.startsWith("+") || line.startsWith("-"))) {
      if (line.slice(1).trim().length > 0) sawContent = true;
    }
  }
  closeHunk();
  return files;
}

function rangesOverlap(a1: number, a2: number, b1: number, b2: number): boolean {
  return a1 <= b2 && b1 <= a2;
}

function computeCoverage(diff: string, doc: IntentDoc): { total: number; explained: number } {
  const files = parseDiff(diff).filter((f) => !isIntentPath(f.path));
  const anchors: { path: string; start: number; end: number }[] = [];
  for (const stop of doc.tour ?? []) {
    for (const a of stop.anchors ?? []) {
      if (a?.path && a?.hunk) {
        const start = a.hunk.new_start;
        anchors.push({ path: a.path, start, end: start + Math.max(1, a.hunk.new_lines) - 1 });
      }
    }
  }
  let total = 0;
  let explained = 0;
  for (const f of files) {
    for (const h of f.hunks) {
      if (!h.substantive) continue;
      total++;
      const end = h.newStart + Math.max(1, h.newLines) - 1;
      if (anchors.some((a) => a.path === f.path && rangesOverlap(a.start, a.end, h.newStart, end))) explained++;
    }
  }
  return { total, explained };
}

// ---- comment + check -------------------------------------------------------

function commentBody(doc: IntentDoc | null, cov: { total: number; explained: number }, link: string, missing: boolean): string {
  if (missing || !doc) {
    return `${MARKER}\n### 📋 Review Assist\nNo Intent Document was found for this PR (\`.intent/<branch>.json\`). Generate one from your coding session and commit it, and this comment will turn into a guided review.\n`;
  }
  const problem = (doc.problem?.statement ?? "").trim();
  const assumptions = (doc.assumptions ?? []).length;
  const covLine =
    cov.total > 0
      ? cov.explained >= cov.total
        ? `✅ **${cov.explained} of ${cov.total} changes explained**`
        : `⚠️ **${cov.explained} of ${cov.total} changes explained** — ${cov.total - cov.explained} unexplained`
      : "";
  return [
    MARKER,
    `### 📋 Review Assist — guided review ready`,
    problem ? `> ${problem}` : "",
    "",
    [covLine, assumptions ? `${assumptions} assumption${assumptions === 1 ? "" : "s"} to check first` : ""].filter(Boolean).join(" · "),
    "",
    `**[Open guided review →](${link})**`,
    "",
  ].filter((l) => l !== undefined).join("\n");
}

async function upsertComment(
  gh: (p: string, a?: string) => Promise<Response>,
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  body: string
): Promise<void> {
  const listRes = await gh(`/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`);
  let existingId: number | null = null;
  if (listRes.ok) {
    const comments = (await listRes.json()) as { id: number; body: string }[];
    const mine = comments.find((c) => typeof c.body === "string" && c.body.includes(MARKER));
    if (mine) existingId = mine.id;
  }
  const method = existingId ? "PATCH" : "POST";
  const path = existingId
    ? `/repos/${owner}/${repo}/issues/comments/${existingId}`
    : `/repos/${owner}/${repo}/issues/${prNumber}/comments`;
  await fetch(`${GH_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": UA,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });
}

async function createCheck(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
  cov: { total: number; explained: number },
  link: string,
  missing: boolean
): Promise<void> {
  // Comment-only rollout: never "failure". Missing/uncovered → neutral; full coverage → success.
  const conclusion = missing ? "neutral" : cov.total > 0 && cov.explained < cov.total ? "neutral" : "success";
  const title = missing
    ? "No Intent Document"
    : cov.total > 0
    ? `${cov.explained}/${cov.total} changes explained`
    : "Intent Document found";
  const summary = missing
    ? `No \`.intent/<branch>.json\` on this PR. Generate one to get a guided review.`
    : `[Open the guided review →](${link})`;
  await fetch(`${GH_API}/repos/${owner}/${repo}/check-runs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": UA,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "Review Assist",
      head_sha: headSha,
      status: "completed",
      conclusion,
      details_url: link,
      output: { title, summary },
    }),
  });
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

// ---- payload types (minimal) ----------------------------------------------

interface PrEvent {
  action: string;
  installation?: { id: number };
  repository: { name: string; owner: { login: string } };
  pull_request: { number: number; head: { ref: string; sha: string }; base: { sha: string } };
}

interface IntentDoc {
  problem?: { statement?: string };
  assumptions?: unknown[];
  tour?: { anchors?: { path: string; hunk: { new_start: number; new_lines: number } }[] }[];
}
