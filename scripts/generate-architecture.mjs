#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const docs = resolve(here, "../docs");

const esc = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/**
 * One SVG surface. `theme` is additive: a diagram may append its own classes, defs and
 * page fill without touching the shared stone palette the system diagram is drawn in.
 */
function canvas(width, height, title, description, theme = {}) {
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">`,
    `<title id="title">${esc(title)}</title>`,
    `<desc id="desc">${esc(description)}</desc>`,
    `<defs>
      <style>
        .sans { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
        .mono { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; }
        .title { font-size: 27px; font-weight: 650; fill: #1c1917; }
        .subtitle { font-size: 15px; fill: #57534e; }
        .boundary-title { font-size: 17px; font-weight: 650; fill: #1c1917; }
        .node-title { font-size: 16px; font-weight: 650; fill: #1c1917; }
        .body { font-size: 14px; fill: #57534e; }
        .small { font-size: 12.5px; fill: #78716c; }
        .tiny { font-size: 11.5px; fill: #57534e; }
        .strong { font-weight: 600; fill: #292524; }
        .pill-text { font-size: 12px; fill: #292524; }
        .badge { fill: #0a6ae0; stroke: none; }
        .badge-text { font-size: 12.5px; font-weight: 700; fill: #ffffff; }
        .boundary { fill: #f7f6f5; stroke: #d6d3d1; stroke-width: 1.2; }
        .node { fill: #ffffff; stroke: #d6d3d1; stroke-width: 1.1; }
        .application { fill: #f7f6f5; stroke: #60a5fa; stroke-width: 1.4; }
        .accent-node { fill: #eff6ff; stroke: #93c5fd; stroke-width: 1.1; }
        .soft-node { fill: #fafaf9; stroke: #d6d3d1; stroke-width: 1; }
        .pill { fill: #ffffff; stroke: #d6d3d1; stroke-width: 1; }
        .pill-accent { fill: #eff6ff; stroke: #93c5fd; stroke-width: 1; }
        .divider { stroke: #e7e5e4; stroke-width: 1; }
        .actor { fill: #ffffff; stroke: #0a6ae0; stroke-width: 1.5; }
        .arrow { fill: none; stroke: #a8a29e; stroke-width: 1.6; marker-end: url(#arrow); }
        .blue-arrow { fill: none; stroke: #0a6ae0; stroke-width: 1.8; marker-end: url(#blue-arrow); }
        .blue-bidi { fill: none; stroke: #0a6ae0; stroke-width: 1.7; marker-start: url(#blue-arrow); marker-end: url(#blue-arrow); }
      </style>
      <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0 1.2 L8.5 5 L0 8.8" fill="none" stroke="#a8a29e" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      </marker>
      <marker id="blue-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0 1.2 L8.5 5 L0 8.8" fill="none" stroke="#0a6ae0" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      </marker>${theme.defs ? `\n      ${theme.defs}` : ""}${theme.style ? `\n      <style>${theme.style}</style>` : ""}
    </defs>`,
    `<rect width="${width}" height="${height}" fill="${theme.background ?? "#fbfaf9"}"/>`,
  ];

  const rect = (x, y, w, h, cls, rx = 8) =>
    out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" class="${cls}"/>`);
  const text = (x, y, value, cls, attrs = "") =>
    out.push(`<text x="${x}" y="${y}" class="${cls}"${attrs ? ` ${attrs}` : ""}>${esc(value)}</text>`);
  const line = (x1, y1, x2, y2, cls = "divider") =>
    out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${cls}"/>`);
  const path = (d, cls = "arrow") => out.push(`<path d="${d}" class="${cls}"/>`);
  const circle = (cx, cy, r, cls) => out.push(`<circle cx="${cx}" cy="${cy}" r="${r}" class="${cls}"/>`);
  const raw = (markup) => out.push(markup);
  const pill = (x, y, w, label, cls = "pill") => {
    rect(x, y, w, 28, cls, 14);
    text(x + w / 2, y + 19, label, "mono pill-text", 'text-anchor="middle"');
  };
  // A numbered step marker. The distillation reads as a sequence, and a reader who cannot
  // tell which box happens first has to reconstruct the order from the arrows.
  const badge = (cx, cy, n) => {
    circle(cx, cy, 11, "badge");
    text(cx, cy + 4.5, String(n), "sans badge-text", 'text-anchor="middle"');
  };
  const finish = () => `${out.concat("</svg>").join("\n")}\n`;

  return { rect, text, line, path, circle, raw, pill, badge, finish };
}

function buildSystemArchitecture() {
  const c = canvas(
    1320,
    790,
    "Review Assist system architecture",
    "A container-level topology. The external Developer works through the developer machine, which creates an Intent Document. GitHub stores the pull request and all review state. The Review Assist Application provides webhook automation and guided review. The Human Reviewer also remains outside every system boundary."
  );
  const { rect, text, line, path, circle, raw } = c;

  text(40, 52, "Review Assist", "sans title");
  text(40, 80, "Container-level system topology", "sans subtitle");

  // Three system/deployment boundaries. Both humans are external actors.
  rect(40, 110, 330, 520, "boundary", 12);
  rect(430, 110, 330, 520, "boundary", 12);
  rect(820, 110, 450, 520, "application", 12);

  text(66, 145, "Developer machine", "sans boundary-title");
  text(344, 145, "local", "sans small", 'text-anchor="end"');
  line(66, 159, 344, 159);

  text(456, 145, "GitHub", "sans boundary-title");
  text(734, 145, "source of truth", "sans small", 'text-anchor="end"');
  line(456, 159, 734, 159);

  text(846, 145, "Review Assist Application", "sans boundary-title");
  text(1244, 145, "service boundary", "sans small", 'text-anchor="end"');
  line(846, 159, 1244, 159);

  // Local container flow.
  rect(70, 190, 270, 66, "node");
  text(94, 217, "Coding agent + session", "sans node-title");
  text(94, 239, "implementation context", "sans small");
  path("M205 256 L205 286", "arrow");
  rect(70, 294, 270, 112, "accent-node");
  text(94, 322, "MCP Server", "sans node-title");
  text(94, 346, "role-scoped tool surfaces", "sans body");
  text(94, 369, "consent · validation · local write", "sans body");
  text(94, 391, "no model calls · transcript stays local", "sans small");
  path("M205 406 L205 436", "blue-arrow");
  rect(70, 444, 270, 72, "node");
  text(94, 473, "Intent Document", "sans node-title");
  text(94, 497, ".intent/<branch>.json", "mono small");

  // One pull request owns all durable state.
  rect(460, 190, 270, 326, "node");
  text(484, 219, "Pull request", "sans node-title");
  text(484, 243, "code + Intent Document", "sans body");
  line(484, 261, 706, 261);
  text(484, 290, "Automation output", "sans node-title");
  text(484, 314, "Check Run", "sans body");
  text(484, 337, "summary + guided link", "sans body");
  text(484, 360, "managed PR-description block", "sans body");
  line(484, 380, 706, 380);
  text(484, 409, "Reviewer-authored activity", "sans node-title");
  text(484, 433, "comments + replies", "sans body");
  text(484, 456, "approve / request changes", "sans body");
  text(484, 493, "merging stays on GitHub", "sans small");

  // Application containers at one consistent level.
  rect(850, 190, 390, 140, "node");
  text(874, 219, "Webhook automation", "sans node-title");
  text(1216, 219, "POST /api/webhook", "mono small", 'text-anchor="end"');
  text(874, 247, "pull_request events", "sans body");
  text(874, 270, "read document + diff · compute coverage", "sans body");
  text(874, 293, "post check + summary + PR description", "sans body");
  text(874, 314, "GitHub App installation identity", "sans small");

  rect(850, 370, 390, 146, "node");
  text(874, 399, "Guided review", "sans node-title");
  text(1216, 399, "application service", "sans small", 'text-anchor="end"');
  text(874, 427, "Browser SPA", "sans body strong");
  text(874, 450, "overview · assumptions · anchored tour", "sans body");
  text(874, 482, "Application API", "sans body strong");
  text(874, 505, "live GitHub reads · comments · verdict", "sans body");

  // System-level flows, following the hand-drawn topology.
  path("M340 480 C397 480 398 243 452 243", "blue-arrow");
  text(400, 452, "commit with code", "sans small", 'text-anchor="middle"');

  path("M730 220 C785 220 794 247 842 247", "blue-arrow");
  text(786, 205, "pull_request event", "sans small", 'text-anchor="middle"');

  path("M850 292 C793 292 788 325 738 325", "blue-arrow");
  text(790, 309, "bot posts", "sans small", 'text-anchor="middle"');

  path("M738 442 C788 442 799 466 842 466", "blue-bidi");
  text(790, 408, "GitHub API", "sans small", 'text-anchor="middle"');
  text(790, 427, "reviewer identity", "sans tiny", 'text-anchor="middle"');

  // Human actors remain outside the system boundaries.
  circle(205, 691, 28, "actor");
  circle(205, 682, 7, "actor");
  raw('<path d="M189 706 C193 690 217 690 221 706" fill="none" stroke="#0a6ae0" stroke-width="1.7"/>');
  text(248, 684, "Developer", "sans node-title");
  text(248, 707, "external actor", "sans small");
  path("M205 660 L205 638", "blue-arrow");
  text(221, 644, "implements change · grants consent", "sans small");

  circle(1045, 691, 28, "actor");
  circle(1045, 682, 7, "actor");
  raw('<path d="M1029 706 C1033 690 1057 690 1061 706" fill="none" stroke="#0a6ae0" stroke-width="1.7"/>');
  text(1088, 684, "Human reviewer", "sans node-title");
  text(1088, 707, "external actor", "sans small");

  path("M595 516 L595 691 L1008 691", "blue-arrow");
  text(802, 679, "guided-review link", "sans small", 'text-anchor="middle"');
  path("M1045 660 L1045 524", "blue-arrow");
  text(1061, 601, "opens · reviews · comments", "sans small");

  line(40, 750, 1270, 750);
  text(40, 775, "Three systems · two external actors · GitHub owns durable review state", "sans small");
  text(1270, 775, "github.com/uditk2/review-assist", "mono small", 'text-anchor="end"');

  return c.finish();
}

/**
 * Component-level detail of the local two-agent distillation.
 *
 * Every tool list here is the one in ROLE_TOOLS, and every gate is one submit_document
 * actually applies — a diagram that flatters the design is worse than no diagram, because
 * it is the thing people read instead of the code.
 */
function buildMcpDetail() {
  const c = canvas(
    1700,
    1290,
    "MCP distillation detail",
    "A component-level view of the local two-agent distillation, all of it on the developer's machine. The orchestrating coding agent spawns two role-locked subagents and holds the three setup tools that belong to neither role: get_role_definitions, import_session and manage_consent. REVIEW_ASSIST_ROLE decides which tools the server registers, so the other role's tools are absent rather than merely disallowed. The Author holds this session's transcript and is registered eight tools: get_generation_guide, list_transcripts, get_spine, read_transcript, compute_diff, read_diff, get_questions and answer_questions. The Intent Reviewer reads the diff cold with no transcript tools and no file-reading tools, and is registered eight of its own: get_generation_guide, compute_diff, read_diff, get_reviewer_instructions, record_interview_round, get_answers, submit_document and set_consent. compute_diff opens the run and returns the run_id, the numbered hunk index, the SHAs, the consent state and whether a .reviewer folder exists; it returns no diff text, which read_diff pages. The two role sessions are separate processes, and the run file at ~/.review-assist/runs/<run_id>.json is the only thing they share: the reviewer records questions and gets a q_id for each, the author answers by q_id, and the reviewer reads those answers back in the author's own words. The repository's .reviewer folder carries its own house rules, served to the reviewer by get_reviewer_instructions after the diff and before round one; it adds questions but cannot relax a check. submit_document is the reviewer's call alone and gates the write behind repository consent, head drift, anchor resolution, interview attestation and the validator's five checks, then writes .intent/<branch>.json. The run leaves two outputs: the Intent Document for the human who will review the pull request, and the reviewer's closing message for the session that can still fix the code.",
    {
      background: "url(#pageGrad)",
      defs: `<linearGradient id="pageGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#e9f1fa"/><stop offset="1" stop-color="#fbfdff"/>
      </linearGradient>
      <linearGradient id="boundGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#f4f9ff"/><stop offset="1" stop-color="#e7f0fa"/>
      </linearGradient>
      <linearGradient id="cardGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#d9e8f9"/><stop offset="1" stop-color="#eef5fd"/>
      </linearGradient>
      <linearGradient id="bandGrad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#1a548f"/><stop offset="1" stop-color="#2b7cc4"/>
      </linearGradient>
      <linearGradient id="greenGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#d8f3e0"/><stop offset="1" stop-color="#f2fcf5"/>
      </linearGradient>
      <marker id="b-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0 1.2 L8.5 5 L0 8.8" fill="none" stroke="#4f8bc4" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
      </marker>`,
      style: `
        .b-title { font-size: 34px; font-weight: 700; fill: #123a66; }
        .b-sub { font-size: 16px; fill: #5a7795; }
        .b-boundary { fill: url(#boundGrad); stroke: #a6c9e8; stroke-width: 1.3; }
        .b-card { fill: url(#cardGrad); stroke: #7bacdd; stroke-width: 1.3; }
        .b-node { fill: #ffffff; stroke: #b6d2ec; stroke-width: 1.1; }
        .b-inner { fill: #f6fafe; stroke: #c7dcf1; stroke-width: 1; }
        .b-feature { fill: #ffffff; stroke: #1a548f; stroke-width: 1.8; }
        .b-green { fill: url(#greenGrad); stroke: #4c9f6a; stroke-width: 1.4; }
        .b-head { font-size: 19px; font-weight: 650; fill: #123a66; }
        .b-node-title { font-size: 16px; font-weight: 650; fill: #123a66; }
        .b-strong { font-size: 13.5px; font-weight: 650; fill: #123a66; }
        .b-body { font-size: 13px; fill: #3d5a78; }
        .b-small { font-size: 12px; fill: #5a7795; }
        .b-mono { font-size: 12px; fill: #1a4b7d; }
        .b-mono-title { font-size: 16px; font-weight: 600; fill: #123a66; }
        .b-band-text { font-size: 16.5px; font-weight: 650; fill: #ffffff; }
        .b-band-sub { font-size: 12px; fill: #cfe4f7; }
        .b-green-title { font-size: 19px; font-weight: 650; fill: #14532d; }
        .b-green-body { font-size: 12px; fill: #2f6b48; }
        .b-green-mono { font-size: 13px; fill: #216b3f; }
        .b-divider { stroke: #dbe9f6; stroke-width: 1; }
        .b-pill { fill: #ffffff; stroke: #b6d2ec; stroke-width: 1; }
        .b-pill-text { font-size: 12px; fill: #1a4b7d; }
        .b-arrow { fill: none; stroke: #4f8bc4; stroke-width: 1.8; marker-end: url(#b-arrow); }
        .b-bidi { fill: none; stroke: #4f8bc4; stroke-width: 1.8; marker-start: url(#b-arrow); marker-end: url(#b-arrow); }
        .b-label { font-size: 11.5px; fill: #2d6aa8; }
      `,
    }
  );
  const { rect, text, line, path, raw } = c;

  /** A tool chip. Role surfaces are lists of names, and a name is the whole content. */
  const chip = (x, y, w, label) => {
    rect(x, y, w, 28, "b-pill", 14);
    text(x + w / 2, y + 18.5, label, "mono b-pill-text", 'text-anchor="middle"');
  };
  const person = (cx, cy) => {
    raw(`<circle cx="${cx}" cy="${cy - 6}" r="6.5" fill="none" stroke="#1a548f" stroke-width="1.8"/>`);
    raw(`<path d="M${cx - 11} ${cy + 10} C${cx - 8} ${cy - 3} ${cx + 8} ${cy - 3} ${cx + 11} ${cy + 10}" fill="none" stroke="#1a548f" stroke-width="1.8"/>`);
  };

  text(850, 58, "MCP distillation detail", "sans b-title", 'text-anchor="middle"');
  text(
    850,
    90,
    "Review Assist: component-level view of the local two-agent distillation",
    "sans b-sub",
    'text-anchor="middle"'
  );

  // Everything in this diagram is one machine. Nothing here is a network hop.
  rect(36, 112, 1628, 1064, "b-boundary", 16);
  text(68, 152, "Developer machine", "sans b-head");
  text(1632, 152, "one server process per role · stdio · no model calls", "sans b-small", 'text-anchor="end"');
  line(68, 168, 1632, 168, "b-divider");

  // ---- Row A: the orchestrator, its own tools, and the lock that makes the split real.
  rect(64, 190, 456, 118, "b-node");
  text(88, 222, "Setup tools", "sans b-node-title");
  text(496, 222, "orchestrator only", "sans b-small", 'text-anchor="end"');
  text(88, 252, "get_role_definitions", "mono b-mono");
  text(310, 252, "manage_consent", "mono b-mono");
  text(88, 274, "import_session", "mono b-mono");
  text(88, 296, "Neither role may call these.", "sans b-small");

  rect(560, 190, 580, 118, "b-card", 12);
  raw('<rect x="586" y="206" width="26" height="22" rx="6" fill="none" stroke="#1a548f" stroke-width="1.8"/>');
  raw('<circle cx="593.5" cy="217" r="2.4" fill="#1a548f"/><circle cx="604.5" cy="217" r="2.4" fill="#1a548f"/>');
  raw('<path d="M599 206 V199" fill="none" stroke="#1a548f" stroke-width="1.8"/><circle cx="599" cy="196" r="2.2" fill="#1a548f"/>');
  text(626, 224, "Orchestrating coding agent", "sans b-head");
  text(586, 254, "Spawns both role-locked subagents, relays the q_ids, and drives the run.", "sans b-body");
  text(586, 278, "It never reads the run, so the reviewer's closing message is its only report.", "sans b-body");
  text(586, 300, "Both roles are subagents of this agent. Neither is a process it talks to over a network.", "sans b-small");

  rect(1180, 190, 456, 118, "b-node");
  text(1204, 222, "The role lock", "sans b-node-title");
  text(1612, 222, "structural", "sans b-small", 'text-anchor="end"');
  text(1204, 250, "REVIEW_ASSIST_ROLE decides which tools are registered.", "sans b-body");
  text(1204, 272, "The other role's tools are absent, not merely refused.", "sans b-body");
  text(1204, 294, "Claude Code's tools: allowlist is belt and braces.", "sans b-body");

  // ---- Row B: the two role surfaces, and the state they actually share.
  rect(64, 336, 492, 416, "b-card", 12);
  person(98, 368);
  text(126, 375, "Author", "sans b-head");
  text(532, 375, "role-locked subagent", "sans b-small", 'text-anchor="end"');
  rect(86, 394, 448, 40, "b-node");
  text(104, 419, "REVIEW_ASSIST_ROLE = author", "mono b-mono");
  text(516, 419, "role-scoped session", "sans b-small", 'text-anchor="end"');
  rect(86, 444, 448, 96, "b-inner");
  text(104, 470, "Holds this session's transcript", "sans b-strong");
  text(104, 494, "JSONL on disk, read end to end through get_spine.", "sans b-small");
  text(104, 516, "It never leaves the machine, and no reviewer tool reaches it.", "sans b-small");
  text(104, 566, "Tools registered for this role", "sans b-strong");
  text(534, 566, "8 of 16", "sans b-small", 'text-anchor="end"');
  chip(86, 580, 214, "get_generation_guide");
  chip(322, 580, 214, "compute_diff");
  chip(86, 616, 214, "list_transcripts");
  chip(322, 616, 214, "read_diff");
  chip(86, 652, 214, "get_spine");
  chip(322, 652, 214, "get_questions");
  chip(86, 688, 214, "read_transcript");
  chip(322, 688, 214, "answer_questions");
  text(104, 736, "No submit_document. No set_consent. It answers; it does not judge.", "sans b-small");

  rect(1144, 336, 492, 416, "b-card", 12);
  person(1178, 368);
  text(1206, 375, "Intent Reviewer", "sans b-head");
  text(1612, 375, "role-locked subagent", "sans b-small", 'text-anchor="end"');
  rect(1166, 394, 448, 40, "b-node");
  text(1184, 419, "REVIEW_ASSIST_ROLE = reviewer", "mono b-mono");
  text(1596, 419, "role-scoped session", "sans b-small", 'text-anchor="end"');
  rect(1166, 444, 448, 96, "b-inner");
  text(1184, 470, "Reads the diff cold", "sans b-strong");
  text(1184, 494, "No transcript tools, and no file-reading tools at all.", "sans b-small");
  text(1184, 516, "Everything it knows about intent, it had to ask for.", "sans b-small");
  text(1184, 566, "Tools registered for this role", "sans b-strong");
  text(1614, 566, "8 of 16", "sans b-small", 'text-anchor="end"');
  chip(1166, 580, 214, "get_generation_guide");
  chip(1402, 580, 214, "record_interview_round");
  chip(1166, 616, 214, "compute_diff");
  chip(1402, 616, 214, "get_answers");
  chip(1166, 652, 214, "read_diff");
  chip(1402, 652, 214, "submit_document");
  chip(1166, 688, 214, "get_reviewer_instructions");
  chip(1402, 688, 214, "set_consent");
  text(1184, 736, "No list_transcripts. No get_spine. No read_transcript.", "sans b-small");

  rect(596, 336, 508, 128, "b-node");
  text(620, 366, "compute_diff", "mono b-mono-title");
  text(1080, 366, "opens the run", "sans b-small", 'text-anchor="end"');
  text(620, 392, "Returns the run_id, the numbered hunk index (H1...Hn), the base and", "sans b-body");
  text(620, 414, "head SHAs, this repo's consent state, and whether .reviewer/ exists.", "sans b-body");
  text(620, 436, "It returns no diff text: read_diff pages the change, hunk by hunk.", "sans b-body");

  rect(596, 492, 508, 260, "b-node");
  text(620, 522, "The run", "sans b-node-title");
  text(700, 522, "~/.review-assist/runs/<run_id>.json", "mono b-mono");
  text(620, 546, "Outside the repository. The two role sessions are separate", "sans b-small");
  text(620, 566, "processes, and this file is the only thing they share.", "sans b-small");
  line(620, 582, 1080, 582, "b-divider");
  text(620, 606, "The interview: two-sided, and attested by the server", "sans b-strong");
  text(620, 634, "1  record_interview_round → a q_id per question", "mono b-mono");
  text(1080, 634, "reviewer", "sans b-small", 'text-anchor="end"');
  text(620, 660, "2  get_questions → answer_questions, by q_id", "mono b-mono");
  text(1080, 660, "author", "sans b-small", 'text-anchor="end"');
  text(620, 686, "3  get_answers → the author's own words", "mono b-mono");
  text(1080, 686, "reviewer", "sans b-small", 'text-anchor="end"');
  rect(618, 700, 464, 46, "b-inner");
  text(634, 720, "answered_by: author is attested; a transcribed answer is not.", "sans b-small");
  text(634, 738, "submit stamps meta.interview from the run, never from a self-report.", "sans b-small");

  // ---- Row C: what each side brings, and the gate between them and the write.
  rect(64, 780, 492, 268, "b-node");
  text(88, 812, "What only the Author can supply", "sans b-node-title");
  text(88, 844, "· the ask, in the user's own words", "sans b-body");
  text(88, 870, "· what was tried and abandoned, and why it lost", "sans b-body");
  text(88, 896, "· what was run, and what was not", "sans b-body");
  text(88, 922, "· which hunks are incidental", "sans b-body");
  line(88, 944, 532, 944, "b-divider");
  text(88, 972, "A recorded non-answer is worth more than an invented one: the", "sans b-small");
  text(88, 992, "author answers with resolved: false and says what is missing.", "sans b-small");
  text(88, 1024, "None of this is recoverable from the diff, which is why the", "sans b-small");
  text(88, 1042, "reviewer has to ask rather than read.", "sans b-small");

  rect(596, 780, 508, 268, "b-node");
  text(620, 812, "submit_document", "mono b-mono-title");
  text(1080, 812, "the reviewer's call alone", "sans b-small", 'text-anchor="end"');
  text(620, 842, "1  Repository consent: always, once or never", "sans b-body");
  text(620, 868, "2  Head drift: a branch that moved is a different change", "sans b-body");
  text(620, 894, "3  Anchors must resolve to hunk ids from this run", "sans b-body");
  text(620, 920, "4  Interview attestation (require_interview rejects rounds: 0)", "sans b-body");
  text(620, 946, "5  The validator's five local checks:", "sans b-body");
  text(642, 968, "schema · staleness · coverage · cross-refs · redaction", "sans b-small");
  line(620, 988, 1080, 988, "b-divider");
  text(620, 1012, "On pass it writes .intent/<branch>.json and returns the PR block.", "sans b-small");
  text(620, 1032, "The run stays open: a fix is an edit and a resubmit, never a re-ask.", "sans b-small");

  // The house rules are the one thing a repository contributes to the interview, so they
  // get the only filled header on the surface.
  rect(1144, 780, 492, 268, "b-feature", 12);
  raw('<path d="M1144 792 a12 12 0 0 1 12 -12 h468 a12 12 0 0 1 12 12 v34 h-492 z" fill="url(#bandGrad)"/>');
  text(1168, 804, "Reviewer notes", "sans b-band-text");
  text(1612, 804, "your repository's own house rules", "sans b-band-sub", 'text-anchor="end"');
  text(1168, 852, "Markdown at the repo root, committed with the code and reviewed", "sans b-body");
  text(1168, 872, "like anything else. Most repositories need none.", "sans b-body");
  text(1168, 902, ".reviewer/README.md", "mono b-mono");
  text(1612, 902, "the house rules", "sans b-small", 'text-anchor="end"');
  text(1168, 924, ".reviewer/verification.md", "mono b-mono");
  text(1612, 924, 'what "verified" means here', "sans b-small", 'text-anchor="end"');
  line(1168, 942, 1612, 942, "b-divider");
  text(1168, 966, "· Served by get_reviewer_instructions: the reviewer reads no files.", "sans b-body");
  text(1168, 992, "· Read after the diff, before round one, so it lands in round one.", "sans b-body");
  text(1168, 1018, "· It adds questions. It cannot relax a check or excuse a round.", "sans b-body");
  text(1168, 1040, "· Untrusted repo data: reference material, never a second protocol.", "sans b-body");

  // ---- Row D: the two outputs, and who each one is for.
  rect(64, 1068, 492, 84, "b-node");
  text(88, 1098, "Two outputs, two audiences", "sans b-node-title");
  text(88, 1122, "The document reaches the human who will review the pull request.", "sans b-small");
  text(88, 1142, "The closing message reaches the session that can still fix the code.", "sans b-small");

  rect(596, 1068, 508, 84, "b-green", 12);
  raw('<path d="M622 1086 h20 l8 8 v22 h-28 z" fill="#ffffff" stroke="#2f7d52" stroke-width="1.6" stroke-linejoin="round"/>');
  raw('<path d="M642 1086 v8 h8" fill="none" stroke="#2f7d52" stroke-width="1.6" stroke-linejoin="round"/>');
  text(664, 1102, "Intent Document", "sans b-green-title");
  text(664, 1126, ".intent/<branch>.json", "mono b-green-mono");
  text(664, 1144, "committed with the code; the GitHub App validates and renders it", "sans b-green-body");

  rect(1144, 1068, 492, 84, "b-card", 12);
  text(1168, 1098, "The reviewer's closing message", "sans b-node-title");
  text(1168, 1122, "Open questions, everything in verification.not_verified, and any", "sans b-small");
  text(1168, 1142, "defect the cold read exposed. It goes back to the coding agent.", "sans b-small");

  // ---- Flows.
  path("M700 308 L700 322 L310 322 L310 336", "b-arrow");
  path("M1000 308 L1000 322 L1390 322 L1390 336", "b-arrow");
  path("M556 400 L592 400", "b-bidi");
  path("M1144 400 L1108 400", "b-bidi");
  path("M556 620 L592 620", "b-bidi");
  path("M1144 620 L1108 620", "b-bidi");
  path("M850 752 L850 776", "b-arrow");
  path("M1144 706 L1124 706 L1124 764 L1064 764 L1064 776", "b-arrow");
  path("M1390 776 L1390 756", "b-arrow");
  text(1404, 770, "get_reviewer_instructions", "mono b-label");
  path("M850 1048 L850 1064", "b-arrow");
  path("M1636 722 L1652 722 L1652 1110 L1640 1110", "b-arrow");

  line(40, 1212, 1660, 1212, "b-divider");
  text(
    40,
    1238,
    "The server never calls a model. It computes the ground truth (the diff), serves the source (the transcript, the house rules), and gates the result (the validator).",
    "sans b-small"
  );
  text(1660, 1238, "github.com/uditk2/review-assist", "mono b-small", 'text-anchor="end"');
  text(
    40,
    1262,
    "The findings leave the run twice, because the human reviewing the pull request arrives after the fact and the session that can still fix the code never sees the run.",
    "sans b-small"
  );

  return c.finish();
}

const files = [
  ["architecture.svg", buildSystemArchitecture()],
  ["mcp-distillation.svg", buildMcpDetail()],
];

for (const [name, contents] of files) {
  const target = resolve(docs, name);
  writeFileSync(target, contents, "utf8");
  process.stdout.write(`wrote ${target}\n`);
}
