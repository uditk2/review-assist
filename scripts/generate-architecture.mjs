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

function canvas(width, height, title, description) {
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
      </marker>
    </defs>`,
    `<rect width="${width}" height="${height}" fill="#fbfaf9"/>`,
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
  const finish = () => `${out.concat("</svg>").join("\n")}\n`;

  return { rect, text, line, path, circle, raw, pill, finish };
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

function buildMcpDetail() {
  const c = canvas(
    1240,
    1190,
    "Review Assist MCP distillation detail",
    "A component-level detail of local intent distillation. The coding agent orchestrates separate Author and Intent Reviewer subagents. They use role-scoped tool surfaces exposed by the Review Assist MCP Server. The server makes no model calls. compute_diff only opens the run; read_diff pages the change itself. The interview is two-sided and server-attested: the Reviewer records questions and gets a q_id back for each, the Author answers by id, and the Reviewer reads the answers in the Author's own words. The server validates and writes the Intent Document after repository consent. get_role_definitions, manage_consent, and import_session belong to neither role — they set up the split itself and are called by the orchestrating agent."
  );
  const { rect, text, line, path, pill } = c;

  text(40, 52, "MCP distillation", "sans title");
  text(40, 80, "Component-level detail · developer machine only", "sans subtitle");

  // The model-driven roles live in the calling agent runtime, not in the MCP Server.
  rect(60, 110, 1120, 390, "boundary", 12);
  text(88, 142, "Calling agent runtime", "sans boundary-title");
  text(1152, 142, "orchestrates model-driven subagents", "sans small", 'text-anchor="end"');
  line(88, 157, 1152, 157);

  rect(420, 178, 400, 64, "node");
  text(446, 206, "Coding agent + implementation session", "sans node-title");
  text(446, 228, "code · decisions · local transcript", "sans small");

  path("M570 242 L315 276", "arrow");
  path("M670 242 L925 276", "arrow");
  text(620, 266, "spawns · coordinates", "sans small", 'text-anchor="middle"');

  rect(90, 284, 440, 180, "node");
  text(116, 314, "Author", "sans node-title");
  text(504, 314, "SUBAGENT", "sans tiny strong", 'text-anchor="end"');
  text(116, 338, "Transcript-grounded witness", "sans body");
  text(116, 361, "answers only from implementation evidence", "sans small");

  rect(710, 284, 440, 180, "node");
  text(736, 314, "Intent Reviewer", "sans node-title");
  text(1124, 314, "SUBAGENT", "sans tiny strong", 'text-anchor="end"');
  text(736, 338, "Cold reader and document author", "sans body");
  text(736, 361, "interrogates assumptions · distills intent", "sans small");

  path("M702 390 L538 390", "blue-arrow");
  text(620, 379, "questions", "sans small", 'text-anchor="middle"');
  path("M538 430 L702 430", "blue-arrow");
  text(620, 451, "transcript-grounded evidence", "sans small", 'text-anchor="middle"');

  // The MCP Server is a separate mechanism: role-scoped tools and deterministic gates.
  rect(60, 540, 1120, 530, "accent-node", 12);
  text(88, 572, "Review Assist MCP Server", "sans boundary-title");
  text(1152, 572, "stdio · role-scoped registration · no model calls", "sans small", 'text-anchor="end"');
  line(88, 587, 1152, 587);

  path("M315 464 L315 604", "blue-arrow");
  path("M925 464 L925 604", "blue-arrow");
  text(329, 526, "uses Author tools", "sans small");
  text(939, 526, "uses Reviewer tools", "sans small");

  // Exact tool lists remain pills, grouped by the role that can call them. Orchestrator-only
  // tools (get_role_definitions, manage_consent, import_session) belong to neither surface —
  // they set up the split itself, not the interview.
  rect(90, 604, 470, 254, "node");
  text(116, 634, "Author tool surface", "sans node-title");
  text(534, 634, "no submit / consent", "sans small", 'text-anchor="end"');
  pill(116, 654, 202, "get_generation_guide");
  pill(328, 654, 206, "list_transcripts");
  pill(116, 692, 202, "get_spine");
  pill(328, 692, 206, "read_transcript");
  pill(116, 730, 202, "compute_diff");
  pill(328, 730, 206, "read_diff");
  pill(116, 768, 202, "get_questions");
  pill(328, 768, 206, "answer_questions");

  rect(680, 604, 470, 254, "node");
  text(706, 634, "Reviewer tool surface", "sans node-title");
  text(1124, 634, "no transcript access", "sans small", 'text-anchor="end"');
  pill(706, 654, 202, "get_generation_guide");
  pill(918, 654, 206, "compute_diff");
  pill(706, 692, 202, "read_diff");
  pill(918, 692, 206, "record_interview_round");
  pill(706, 730, 202, "get_answers");
  pill(918, 730, 206, "submit_document");
  pill(706, 768, 202, "set_consent");

  // The interview itself: two independent writes, keyed by q_id, so the server can attest
  // which half of an answer actually came from the Author rather than the Reviewer's own
  // transcription of it.
  rect(90, 878, 1060, 62, "soft-node", 8);
  text(116, 908, "the interview", "mono body strong");
  pill(270, 890, 206, "record_interview_round", "pill-accent");
  path("M476 904 L508 904", "blue-arrow");
  pill(508, 890, 142, "get_questions", "pill-accent");
  path("M650 904 L682 904", "blue-arrow");
  pill(682, 890, 156, "answer_questions", "pill-accent");
  path("M838 904 L870 904", "blue-arrow");
  pill(870, 890, 120, "get_answers", "pill-accent");
  text(1114, 908, "→ q_id each way", "sans tiny", 'text-anchor="end"');

  // One local submission gate; consent precedes sibling checks.
  rect(90, 960, 1060, 84, "soft-node", 8);
  text(116, 994, "submit_document", "mono body strong");
  pill(270, 976, 118, "repo consent");
  path("M392 990 L428 990", "blue-arrow");
  pill(436, 960, 184, "interview attestation", "pill-accent");
  pill(436, 996, 184, "5 local checks", "pill-accent");
  text(644, 984, "allow → write", "sans body");
  text(644, 1010, "never → no write", "sans small");
  text(1114, 984, "schema · coverage · staleness", "sans tiny", 'text-anchor="end"');
  text(1114, 1007, "cross-references · redaction", "sans tiny", 'text-anchor="end"');

  path("M620 1044 L620 1090", "blue-arrow");
  rect(360, 1098, 520, 66, "node");
  text(388, 1126, ".intent/<branch>.json", "mono node-title");
  text(388, 1150, "Intent Document · transcript remains local", "sans small");

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
