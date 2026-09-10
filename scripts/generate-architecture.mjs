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

function buildMcpDetail() {
  const c = canvas(
    1240,
    1450,
    "How Review Assist distills intent",
    "A component-level detail of local intent distillation, read as six numbered steps. The coding agent spawns two role-locked subagents. The Author holds this session's transcript and supplies what the diff cannot show: the ask in the user's own words, what was tried and abandoned, and what was and was not run. The Intent Reviewer never sees the session; it reads the diff cold, and its questions come from three places: the baseline set in its role prompt, the diff itself, and the repository's own .reviewer/ house rules, served by get_reviewer_instructions. Every question and answer passes through the Review Assist MCP Server, which registers a different tool surface per role: the Author has transcript and diff tools but cannot submit or set consent, the Reviewer has diff, house-rule, interview, submission and consent tools but no transcript tools, and get_role_definitions, import_session and manage_consent belong to neither role because the coding agent calls them itself. The interview is server-attested through q_ids. submit_document gates the write behind repository consent, interview attestation and five local checks, and writes .intent/<branch>.json. The Reviewer's closing report carries what the document could not settle back to the session that can still fix the code. The server makes no model calls and the transcript never leaves the machine."
  );
  const { rect, text, line, path, pill, badge } = c;

  text(40, 52, "How Review Assist distills intent", "sans title");
  text(
    40,
    80,
    "All of it runs on the developer's machine. The server makes no model calls, and the session transcript never leaves it.",
    "sans subtitle"
  );

  // The model-driven roles live in the calling agent runtime, not in the MCP Server.
  rect(60, 108, 1120, 448, "boundary", 12);
  text(88, 140, "Your coding agent", "sans boundary-title");
  text(1152, 140, "runs both roles as subagents, in separate contexts", "sans small", 'text-anchor="end"');
  line(88, 155, 1152, 155);

  rect(400, 176, 440, 66, "node");
  text(426, 204, "The session that wrote the code", "sans node-title");
  text(426, 226, "code · decisions · the local transcript", "sans small");

  path("M560 242 L332 300", "arrow");
  path("M680 242 L908 300", "arrow");
  badge(519, 276, 1);
  text(541, 281, "spawns two role-locked subagents", "sans small");

  // Step 6 travels the other way: the reviewer's last message is the only channel that
  // reaches the session while the code can still be changed.
  path("M1020 300 L1020 270 L800 270 L800 248", "arrow");
  badge(806, 258, 6);
  text(828, 263, "closing report to the session", "sans small");

  rect(88, 300, 470, 230, "node");
  badge(125, 330, 2);
  text(148, 336, "Author", "sans node-title");
  text(532, 336, "SUBAGENT", "sans tiny strong", 'text-anchor="end"');
  text(114, 364, "Holds this session's transcript. Cannot submit.", "sans body");
  rect(114, 382, 418, 104, "soft-node", 8);
  text(132, 406, "What only it can supply", "sans small");
  text(132, 431, "· the ask, in the user's own words", "sans tiny");
  text(132, 453, "· what was tried and abandoned", "sans tiny");
  text(132, 475, "· what was run, and what was not", "sans tiny");
  text(114, 508, "Answers by q_id, so the server can attest the words are its own", "sans small");

  rect(682, 300, 470, 230, "node");
  badge(719, 330, 3);
  text(742, 336, "Intent Reviewer", "sans node-title");
  text(1126, 336, "SUBAGENT", "sans tiny strong", 'text-anchor="end"');
  text(708, 364, "Never sees the session. Reads the diff cold.", "sans body");
  rect(708, 382, 418, 104, "soft-node", 8);
  text(726, 406, "Its questions come from three places", "sans small");
  text(726, 431, "· the baseline set carried in its role prompt", "sans tiny");
  text(726, 453, "· the diff it has just read", "sans tiny");
  text(726, 475, "· this repository's own .reviewer/ house rules", "sans tiny");
  text(708, 508, "Two outputs: the document, and a report back to the session", "sans small");

  path("M323 530 L323 612", "blue-arrow");
  path("M917 530 L917 612", "blue-arrow");
  text(620, 576, "every question and answer passes through the server,", "sans small", 'text-anchor="middle"');
  text(620, 598, "so it can attest who actually answered", "sans small", 'text-anchor="middle"');

  // The MCP Server is a separate mechanism: role-scoped tools and deterministic gates.
  rect(60, 616, 1120, 590, "accent-node", 12);
  text(88, 648, "Review Assist MCP Server", "sans boundary-title");
  text(1152, 648, "stdio · role-scoped registration · no model calls", "sans small", 'text-anchor="end"');
  line(88, 663, 1152, 663);

  // Exact tool lists remain pills, grouped by the role that can call them.
  rect(88, 680, 470, 238, "node");
  text(114, 710, "Author tools", "sans node-title");
  text(532, 710, "no submit, no consent", "sans small", 'text-anchor="end"');
  text(114, 734, "read the session, read the diff, answer questions", "sans small");
  pill(114, 755, 203, "get_generation_guide");
  pill(329, 755, 203, "list_transcripts");
  pill(114, 793, 203, "get_spine");
  pill(329, 793, 203, "read_transcript");
  pill(114, 831, 203, "compute_diff");
  pill(329, 831, 203, "read_diff");
  pill(114, 869, 203, "get_questions");
  pill(329, 869, 203, "answer_questions");

  rect(682, 680, 470, 238, "node");
  text(708, 710, "Reviewer tools", "sans node-title");
  text(1126, 710, "no transcript access", "sans small", 'text-anchor="end"');
  text(708, 734, "read the diff and the house rules, ask, submit", "sans small");
  pill(708, 755, 203, "get_generation_guide");
  pill(923, 755, 203, "compute_diff");
  pill(708, 793, 203, "read_diff");
  pill(923, 793, 203, "get_reviewer_instructions");
  pill(708, 831, 203, "record_interview_round");
  pill(923, 831, 203, "get_answers");
  pill(708, 869, 203, "submit_document");
  pill(923, 869, 203, "set_consent");

  // Three tools belong to neither surface: they set the split up rather than run the
  // interview, and the orchestrating agent is what calls them.
  rect(88, 936, 1064, 62, "soft-node", 8);
  text(114, 964, "Called by the coding agent", "sans small");
  text(114, 982, "itself, not by either role", "sans small");
  pill(280, 953, 205, "get_role_definitions");
  pill(497, 953, 165, "import_session");
  pill(674, 953, 180, "manage_consent");
  text(1126, 972, "they set up the split and the consent list", "sans tiny", 'text-anchor="end"');

  // The interview itself: two independent writes, keyed by q_id, so the server can attest
  // which half of an answer actually came from the Author rather than the Reviewer's own
  // transcription of it.
  rect(88, 1016, 1064, 62, "soft-node", 8);
  badge(120, 1047, 4);
  text(140, 1052, "the interview", "mono body strong");
  pill(270, 1033, 206, "record_interview_round", "pill-accent");
  path("M476 1047 L508 1047", "blue-arrow");
  pill(508, 1033, 142, "get_questions", "pill-accent");
  path("M650 1047 L682 1047", "blue-arrow");
  pill(682, 1033, 156, "answer_questions", "pill-accent");
  path("M838 1047 L870 1047", "blue-arrow");
  pill(870, 1033, 120, "get_answers", "pill-accent");
  text(1126, 1052, "q_id each way", "sans tiny", 'text-anchor="end"');

  // One local submission gate; consent precedes sibling checks.
  rect(88, 1096, 1064, 84, "soft-node", 8);
  badge(120, 1138, 5);
  text(140, 1143, "submit_document", "mono body strong");
  pill(290, 1124, 118, "repo consent");
  path("M412 1138 L440 1138", "blue-arrow");
  pill(448, 1108, 184, "interview attestation", "pill-accent");
  pill(448, 1144, 184, "5 local checks", "pill-accent");
  text(656, 1132, "allow → write", "sans body");
  text(656, 1158, "never → no write", "sans small");
  text(1126, 1132, "schema · coverage · staleness", "sans tiny", 'text-anchor="end"');
  text(1126, 1155, "cross-references · redaction", "sans tiny", 'text-anchor="end"');

  // The two repository paths the server touches: one it reads for the reviewer, one it
  // writes once the gate passes. Nothing else on disk is exposed to either role.
  path("M360 1252 L360 1212", "arrow");
  text(374, 1237, "read by get_reviewer_instructions", "sans small");
  path("M880 1212 L880 1248", "blue-arrow");
  text(894, 1237, "written by submit_document", "sans small");

  rect(150, 1252, 420, 94, "node");
  text(176, 1284, ".reviewer/", "mono node-title");
  text(176, 1310, "this repository's house rules: what it", "sans small");
  text(176, 1332, "always wants the reviewer to ask", "sans small");

  rect(670, 1252, 420, 94, "node");
  text(696, 1284, ".intent/<branch>.json", "mono node-title");
  text(696, 1310, "the Intent Document, committed with", "sans small");
  text(696, 1332, "the code and read by the human reviewer", "sans small");

  line(40, 1382, 1200, 1382);
  text(
    40,
    1407,
    "The split is structural: REVIEW_ASSIST_ROLE decides which tools the server registers, so the reviewer cannot reach the transcript at all.",
    "sans small"
  );
  text(1200, 1407, "github.com/uditk2/review-assist", "mono small", 'text-anchor="end"');
  text(
    40,
    1429,
    "The closing report carries what the document could not settle: unanswered questions, anything left unverified, defects the cold read exposed.",
    "sans small"
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
