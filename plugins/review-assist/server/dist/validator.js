import {
  require__
} from "./ajv-4.js";
import {
  __toESM
} from "./runtime.js";

// ../schema/dist/intent-doc.schema.json with { type: 'json' }
var intent_doc_schema_default = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://reviewassist.dev/schema/0.1/intent-doc.schema.json",
  title: "Intent Document",
  description: "An open format for AI change-intent, distilled from an agent coding session.",
  type: "object",
  required: [
    "schema_version",
    "meta",
    "problem",
    "assumptions",
    "approach",
    "tour",
    "verification"
  ],
  additionalProperties: false,
  properties: {
    schema_version: {
      const: "0.1"
    },
    meta: {
      type: "object",
      required: [
        "id",
        "repo",
        "commit_range",
        "session",
        "generated_by",
        "generated_at"
      ],
      additionalProperties: false,
      properties: {
        id: {
          type: "string",
          minLength: 1
        },
        repo: {
          type: "string",
          pattern: "^[^/]+/[^/]+$"
        },
        commit_range: {
          type: "object",
          required: [
            "base_sha",
            "head_sha"
          ],
          additionalProperties: false,
          properties: {
            base_sha: {
              type: "string",
              minLength: 7
            },
            head_sha: {
              type: "string",
              minLength: 7
            }
          }
        },
        session: {
          type: "object",
          required: [
            "agent",
            "model"
          ],
          additionalProperties: false,
          properties: {
            agent: {
              type: "string"
            },
            model: {
              type: "string"
            },
            session_ids: {
              type: "array",
              items: {
                type: "string"
              }
            },
            started_at: {
              type: "string"
            },
            ended_at: {
              type: "string"
            }
          }
        },
        generated_by: {
          type: "object",
          required: [
            "pipeline",
            "version"
          ],
          additionalProperties: false,
          properties: {
            pipeline: {
              type: "string"
            },
            version: {
              type: "string"
            }
          }
        },
        generated_at: {
          type: "string"
        },
        interview: {
          type: "object",
          additionalProperties: false,
          properties: {
            rounds: {
              type: "integer",
              minimum: 0
            },
            questions_asked: {
              type: "integer",
              minimum: 0
            },
            unresolved: {
              type: "integer",
              minimum: 0
            },
            author_attested: {
              type: "integer",
              minimum: 0
            },
            unanswered: {
              type: "integer",
              minimum: 0
            },
            developer_attested: {
              type: "integer",
              minimum: 0
            }
          }
        }
      }
    },
    problem: {
      type: "object",
      required: [
        "statement",
        "origin",
        "user_asks"
      ],
      additionalProperties: false,
      properties: {
        statement: {
          type: "string",
          minLength: 1
        },
        origin: {
          enum: [
            "stated_upfront",
            "emerged_during_session"
          ]
        },
        user_asks: {
          type: "array",
          items: {
            type: "string"
          }
        },
        out_of_scope: {
          type: "array",
          items: {
            type: "string"
          }
        }
      }
    },
    assumptions: {
      type: "array",
      items: {
        type: "object",
        required: [
          "id",
          "assumption",
          "impact_if_wrong",
          "confidence"
        ],
        additionalProperties: false,
        properties: {
          id: {
            type: "string",
            pattern: "^A[0-9]+$"
          },
          assumption: {
            type: "string",
            minLength: 1
          },
          impact_if_wrong: {
            type: "string",
            minLength: 1
          },
          depends: {
            type: "array",
            items: {
              type: "string"
            }
          },
          how_to_verify: {
            type: "string"
          },
          confidence: {
            enum: [
              "confirmed_by_user",
              "grounded_in_code",
              "unverified"
            ]
          },
          anchors: {
            description: 'Hunk ids this concerns, e.g. ["H4"]. Ids rather than expanded anchors: these point AT the tour stop covering the hunk, and only the tour needs line ranges, because only the tour drives the diff view.',
            type: "array",
            items: {
              type: "string",
              pattern: "^H[0-9]+$"
            }
          }
        }
      }
    },
    open_questions: {
      type: "array",
      items: {
        type: "object",
        required: [
          "id",
          "question"
        ],
        additionalProperties: false,
        properties: {
          id: {
            type: "string",
            pattern: "^Q[0-9]+$"
          },
          question: {
            type: "string",
            minLength: 1
          },
          context: {
            type: "string"
          },
          raised_by: {
            enum: [
              "reviewer_agent",
              "author_agent",
              "user"
            ]
          },
          anchors: {
            description: 'Hunk ids this concerns, e.g. ["H4"]. Ids rather than expanded anchors: these point AT the tour stop covering the hunk, and only the tour needs line ranges, because only the tour drives the diff view.',
            type: "array",
            items: {
              type: "string",
              pattern: "^H[0-9]+$"
            }
          }
        }
      }
    },
    approach: {
      type: "object",
      required: [
        "requirements",
        "adopted"
      ],
      additionalProperties: false,
      properties: {
        requirements: {
          type: "array",
          items: {
            type: "object",
            required: [
              "text"
            ],
            additionalProperties: false,
            properties: {
              text: {
                type: "string"
              },
              source: {
                type: "string"
              }
            }
          }
        },
        trials: {
          type: "array",
          items: {
            type: "object",
            required: [
              "what",
              "outcome",
              "why_abandoned"
            ],
            additionalProperties: false,
            properties: {
              what: {
                type: "string"
              },
              outcome: {
                type: "string"
              },
              why_abandoned: {
                type: "string"
              }
            }
          }
        },
        adopted: {
          type: "object",
          required: [
            "summary",
            "rationale"
          ],
          additionalProperties: false,
          properties: {
            summary: {
              type: "string"
            },
            rationale: {
              type: "string"
            }
          }
        }
      }
    },
    tour: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: [
          "id",
          "title",
          "role",
          "what",
          "why",
          "anchors",
          "provenance"
        ],
        additionalProperties: false,
        properties: {
          id: {
            type: "string",
            pattern: "^T[0-9]+$"
          },
          title: {
            type: "string",
            minLength: 1
          },
          role: {
            enum: [
              "core",
              "supporting",
              "incidental"
            ]
          },
          what: {
            type: "string"
          },
          why: {
            type: "string"
          },
          anchors: {
            type: "array",
            items: {
              $ref: "#/$defs/anchor"
            }
          },
          parent: {
            type: [
              "string",
              "null"
            ]
          },
          provenance: {
            enum: [
              "from_transcript",
              "confirmed_in_interview",
              "inferred_from_code"
            ]
          },
          attention: {
            type: "string"
          }
        }
      }
    },
    verification: {
      type: "object",
      required: [
        "performed"
      ],
      additionalProperties: false,
      properties: {
        performed: {
          type: "array",
          items: {
            type: "object",
            required: [
              "kind",
              "description",
              "result"
            ],
            additionalProperties: false,
            properties: {
              kind: {
                enum: [
                  "test",
                  "manual",
                  "build",
                  "lint",
                  "typecheck"
                ]
              },
              description: {
                type: "string"
              },
              result: {
                type: "string"
              },
              evidence: {
                type: "string"
              }
            }
          }
        },
        added_tests: {
          type: "array",
          items: {
            type: "object",
            required: [
              "covers",
              "anchors"
            ],
            additionalProperties: false,
            properties: {
              covers: {
                type: "string"
              },
              anchors: {
                type: "array",
                items: {
                  $ref: "#/$defs/anchor"
                }
              }
            }
          }
        },
        not_verified: {
          type: "array",
          items: {
            oneOf: [
              {
                type: "string",
                minLength: 1
              },
              {
                type: "object",
                required: [
                  "text"
                ],
                additionalProperties: false,
                properties: {
                  text: {
                    type: "string",
                    minLength: 1
                  },
                  anchors: {
                    description: 'Hunk ids this concerns, e.g. ["H4"]. Ids rather than expanded anchors: these point AT the tour stop covering the hunk, and only the tour needs line ranges, because only the tour drives the diff view.',
                    type: "array",
                    items: {
                      type: "string",
                      pattern: "^H[0-9]+$"
                    }
                  }
                }
              }
            ]
          },
          description: "Behaviour nobody exercised. A plain string, or an object carrying the hunk ids it concerns so it can be shown at the stop it applies to."
        }
      }
    },
    diagrams: {
      type: "array",
      description: "Optional Mermaid diagrams (architecture, sequence, data-flow) that help a reviewer understand the change. Rendered by GitHub in the PR description and by the guided viewer.",
      items: {
        type: "object",
        required: [
          "title",
          "mermaid"
        ],
        additionalProperties: false,
        properties: {
          title: {
            type: "string"
          },
          mermaid: {
            type: "string",
            description: "Mermaid diagram source."
          },
          caption: {
            type: "string"
          }
        }
      }
    },
    evaluated: {
      description: "Questions already asked and answered during distillation, kept as a lookup rather than as reading: a reviewer who arrives holding one of these finds it settled, with the hunk that settles it. Stamped by the server from the run's recorded rounds; never written by an agent.",
      type: "array",
      items: {
        type: "object",
        required: [
          "question",
          "answer"
        ],
        additionalProperties: false,
        properties: {
          question: {
            type: "string",
            minLength: 1
          },
          answer: {
            type: "string",
            minLength: 1
          },
          anchors: {
            description: 'Hunk ids this question concerns, e.g. ["H4"]. Absent when the reviewer recorded none.',
            type: "array",
            items: {
              type: "string",
              minLength: 1
            }
          }
        }
      }
    },
    unresolved: {
      description: "Questions the interview could not settle, each with HOW it ended: accepted_partial (the developer knows and is shipping anyway), escalated (the developer wants a reviewer's eyes here), or unanswered (nobody engaged). An unanswered question about a code risk means the risk was never considered, which makes it a stronger finding rather than a weaker one. Stamped by the server from the run's recorded rounds; never written by an agent.",
      type: "array",
      items: {
        type: "object",
        required: [
          "question",
          "disposition"
        ],
        additionalProperties: false,
        properties: {
          question: {
            type: "string",
            minLength: 1
          },
          disposition: {
            enum: [
              "accepted_partial",
              "escalated",
              "unanswered"
            ]
          },
          note: {
            description: "Whatever was said about it: the developer's reason, or the author's recorded non-answer.",
            type: "string"
          },
          anchors: {
            type: "array",
            items: {
              type: "string",
              minLength: 1
            }
          }
        }
      }
    }
  },
  $defs: {
    anchor: {
      type: "object",
      required: [
        "path",
        "hunk"
      ],
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          minLength: 1
        },
        hunk: {
          type: "object",
          required: [
            "old_start",
            "old_lines",
            "new_start",
            "new_lines"
          ],
          additionalProperties: false,
          properties: {
            old_start: {
              type: "integer",
              minimum: 0
            },
            old_lines: {
              type: "integer",
              minimum: 0
            },
            new_start: {
              type: "integer",
              minimum: 0
            },
            new_lines: {
              type: "integer",
              minimum: 0
            }
          }
        },
        id: {
          description: `The hunk id this anchor was written as, e.g. "H3". Kept through expansion so anything else that names a hunk id can be joined to the stop covering it; expansion used to discard it, which left every other field's anchors unjoinable.`,
          type: "string",
          pattern: "^H[0-9]+$"
        }
      }
    }
  }
};

// ../schema/dist/index.js
var intentDocSchema = intent_doc_schema_default;

// ../validator/dist/diff.js
var FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
var HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
function parseUnifiedDiff(diff) {
  const lines = diff.split("\n");
  const files = [];
  let current = null;
  let currentHunk = null;
  let renameFrom = null;
  const flushHunk = (end) => {
    if (current && currentHunk) {
      currentHunk.span[1] = end;
      current.hunks.push(currentHunk);
    }
    currentHunk = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fileMatch = FILE_HEADER.exec(line);
    if (fileMatch) {
      flushHunk(i);
      current = { path: fileMatch[2], hunks: [] };
      files.push(current);
      renameFrom = null;
      continue;
    }
    if (!current)
      continue;
    if (line.startsWith("--- ")) {
      renameFrom = stripPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      const to = stripPrefix(line.slice(4));
      if (to === "/dev/null" && renameFrom && renameFrom !== "/dev/null") {
        current.path = renameFrom;
      } else if (to !== "/dev/null") {
        current.path = to;
      }
      continue;
    }
    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      flushHunk(i);
      currentHunk = {
        old_start: Number(hunkMatch[1]),
        old_lines: hunkMatch[2] === void 0 ? 1 : Number(hunkMatch[2]),
        new_start: Number(hunkMatch[3]),
        new_lines: hunkMatch[4] === void 0 ? 1 : Number(hunkMatch[4]),
        substantive: false,
        span: [i, lines.length]
      };
      continue;
    }
    if (currentHunk && (line.startsWith("+") || line.startsWith("-"))) {
      const content = line.slice(1);
      if (content.trim().length > 0) {
        currentHunk.substantive = true;
        if (currentHunk.preview === void 0 && line.startsWith("+")) {
          currentHunk.preview = content.trim().slice(0, 120);
        }
      }
    }
  }
  flushHunk(lines.length);
  return files;
}
function stripPrefix(p) {
  const trimmed = p.trim();
  if (trimmed === "/dev/null")
    return trimmed;
  if (trimmed.startsWith("a/") || trimmed.startsWith("b/"))
    return trimmed.slice(2);
  return trimmed;
}
function newRange(h) {
  if (h.new_lines === 0)
    return [h.new_start, h.new_start];
  return [h.new_start, h.new_start + h.new_lines - 1];
}
function rangesOverlap(a, b) {
  return a[0] <= b[1] && b[0] <= a[1];
}
function indexHunks(diff) {
  const out = [];
  let n = 0;
  for (const file of parseUnifiedDiff(diff)) {
    const excluded = file.path === ".intent" || file.path.startsWith(".intent/");
    for (const hunk of file.hunks) {
      out.push({
        ...hunk,
        id: `H${++n}`,
        path: file.path,
        coverage_required: hunk.substantive && !excluded
      });
    }
  }
  return out;
}

// ../validator/dist/page.js
var DEFAULT_PAGE_BYTES = 2e4;
var PER_SLICE_OVERHEAD = 120;
function wireLen(s) {
  return JSON.stringify(s).length - 2;
}
function parseCursor(cursor) {
  if (!cursor)
    return { offset: 0 };
  const [id, rest] = cursor.split(":", 2);
  const offset = rest === void 0 ? 0 : Number(rest);
  if (!/^H\d+$/.test(id) || !Number.isInteger(offset) || offset < 0) {
    throw new Error(`Malformed cursor "${cursor}". Expected "H<n>" or "H<n>:<line-offset>".`);
  }
  return { id, offset };
}
function pageDiff(diff, opts = {}) {
  const lines = diff.split("\n");
  const all = indexHunks(diff);
  const { selection, unknownIds, unknownPaths } = select(all, opts);
  const budget = opts.maxBytes ?? DEFAULT_PAGE_BYTES;
  const { id: cursorId, offset: cursorOffset } = parseCursor(opts.cursor);
  let start = 0;
  if (cursorId) {
    start = selection.findIndex((h) => h.id === cursorId);
    if (start < 0) {
      throw new Error(`Cursor "${opts.cursor}" points at ${cursorId}, which is not in this selection.`);
    }
  }
  const out = [];
  let spent = 0;
  let offset = cursorOffset;
  let next;
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
    if (out.length > 0) {
      next = offset > 0 ? `${h.id}:${offset}` : h.id;
      break;
    }
    const take = Math.max(1, fitLines(rest, room));
    const end = offset + Math.min(take, rest.length);
    out.push(makeSlice(h, header, body, offset, end));
    next = end >= body.length ? nextIdAfter(selection, i) : `${h.id}:${end}`;
    break;
  }
  const remaining = next ? selection.length - indexOfCursor(selection, next) : 0;
  const page = { hunks: out, returned: out.length, remaining, total: selection.length };
  if (next)
    page.next_cursor = next;
  if (unknownIds.length)
    page.unknown_ids = unknownIds;
  if (unknownPaths.length)
    page.unknown_paths = unknownPaths;
  return page;
}
function summarizeFiles(hunks) {
  const out = [];
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
function firstId(label) {
  return label.split("-")[0];
}
function rangeLabel(from, to) {
  return from === to ? from : `${from}-${to}`;
}
function hunkBody(lines, h) {
  const body = lines.slice(h.span[0], h.span[1]);
  if (h.span[1] === lines.length && body.length > 1 && body[body.length - 1] === "")
    body.pop();
  return body;
}
function makeSlice(h, header, body, from, to) {
  const slice = {
    id: h.id,
    path: h.path,
    header,
    text: body.slice(from, to).join("\n")
  };
  if (from > 0 || to < body.length) {
    slice.lines = [from + 1, to];
    slice.hunk_lines = body.length;
  }
  return slice;
}
function fitLines(ls, budget) {
  let used = 0;
  let n = 0;
  for (const l of ls) {
    const add = wireLen(l) + (n === 0 ? 0 : 2);
    if (used + add > budget)
      break;
    used += add;
    n += 1;
  }
  return n;
}
function nextIdAfter(selection, i) {
  return selection[i + 1]?.id;
}
function indexOfCursor(selection, cursor) {
  const id = cursor.split(":", 1)[0];
  const at = selection.findIndex((h) => h.id === id);
  return at < 0 ? selection.length : at;
}
function select(all, opts) {
  if (opts.ids?.length) {
    const known = new Set(all.map((h) => h.id));
    const want = new Set(opts.ids);
    return {
      selection: all.filter((h) => want.has(h.id)),
      unknownIds: opts.ids.filter((id) => !known.has(id)),
      unknownPaths: []
    };
  }
  const walkable = all.filter((h) => h.coverage_required);
  if (opts.paths?.length) {
    const known = new Set(all.map((h) => h.path));
    const want = new Set(opts.paths);
    return {
      selection: walkable.filter((h) => want.has(h.path)),
      unknownIds: [],
      unknownPaths: opts.paths.filter((p) => !known.has(p))
    };
  }
  return { selection: walkable, unknownIds: [], unknownPaths: [] };
}

// ../validator/dist/render.js
function diagramsMarkdown(doc) {
  const out = [];
  if (!doc.diagrams?.length)
    return out;
  out.push(`### \u{1F4CA} Diagrams`, ``);
  for (const d of doc.diagrams) {
    out.push(`**${escape(d.title)}**`, ``);
    out.push("```mermaid", d.mermaid.trim(), "```", ``);
    if (d.caption)
      out.push(`_${escape(d.caption)}_`, ``);
  }
  return out;
}
function renderPrDescription(doc, opts = {}) {
  const out = [];
  const p = (s = "") => out.push(s);
  p(`## ${escape(doc.problem.statement)}`);
  p();
  for (const line of blockMarkdown("**What changed.** ", doc.approach.adopted.summary))
    p(line);
  for (const line of blockMarkdown("_Why:_ ", doc.approach.adopted.rationale))
    p(line);
  for (const line of diagramsMarkdown(doc))
    p(line);
  if (doc.assumptions.length) {
    p(`### Assumptions to check first`);
    p();
    for (const a of doc.assumptions) {
      const v = a.how_to_verify ? ` _Verify:_ ${escape(a.how_to_verify)}` : "";
      p(`- **[${a.id}] ${escape(a.assumption)}** \u2014 if wrong: ${escape(a.impact_if_wrong)}.${v}`);
    }
    p();
  }
  if (doc.approach.trials?.length) {
    p(`### Considered and rejected`);
    p();
    for (const t of doc.approach.trials) {
      p(`- **${escape(t.what)}** \u2014 ${escape(t.why_abandoned)}`);
    }
    p();
  }
  if (doc.problem.out_of_scope?.length) {
    p(`**Out of scope:** ${doc.problem.out_of_scope.map(escape).join("; ")}`);
    p();
  }
  const link = opts.viewerUrl ? `[Open the guided review \u2192](${opts.viewerUrl}) \xB7 ` : "";
  p(`---`);
  p(`<sub>\u{1F9ED} ${link}Intent captured by Review Assist. A guided walkthrough is linked on this PR automatically; full detail lives in the committed Intent Document.</sub>`);
  return out.join("\n");
}
function escape(s) {
  return s.replace(/\r?\n/g, " ");
}
var isBullet = (l) => /^[-*+]\s+/.test(l.trim());
function pointLines(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1 || !lines.some(isBullet))
    return null;
  return lines;
}
function blockMarkdown(lead, text) {
  const lines = pointLines(text);
  if (!lines)
    return [`${lead}${escape(text)}`, ``];
  return [lead.trim(), ``, ...lines.map((l) => isBullet(l.trim()) ? `- ${l.trim().replace(/^[-*+]\s+/, "")}` : l.trim()), ``];
}

// ../validator/dist/index.js
var import__ = __toESM(require__(), 1);
var ajv = new import__.Ajv2020({ allErrors: true, strict: false });
var validateSchema = ajv.compile(intentDocSchema);
var DEFAULT_SECRET_PATTERNS = [
  { name: "AWS access key id", re: /AKIA[0-9A-Z]{16}/ },
  { name: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "Slack token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: "Generic API key assignment", re: /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/i },
  { name: "Connection string with credentials", re: /[a-z]+:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/i }
];
function validate(doc, opts = {}) {
  const findings = [];
  const schemaOk = validateSchema(doc);
  if (!schemaOk) {
    for (const err of validateSchema.errors ?? []) {
      findings.push({ check: "schema", severity: "error", message: formatAjvError(err) });
    }
    return { ok: false, findings };
  }
  const document = doc;
  if (opts.headSha) {
    const declared = document.meta.commit_range.head_sha;
    if (!shaMatches(declared, opts.headSha)) {
      findings.push({
        check: "staleness",
        severity: "error",
        message: `Document describes an older version: commit_range.head_sha=${declared} but PR head is ${opts.headSha}. Regenerate the intent document.`
      });
    }
  }
  let coverage;
  if (opts.diff !== void 0) {
    coverage = runCoverage(document, opts.diff, findings, opts.strictCoverage ?? false);
  }
  runCrossRefs(document, findings);
  runRedaction(document, findings, opts.extraSecretPatterns ?? []);
  const ok = !findings.some((f) => f.severity === "error");
  return { ok, findings, coverage };
}
function runCoverage(document, rawDiff, findings, strict) {
  const diffFiles = parseUnifiedDiff(rawDiff);
  const anchors = [];
  document.tour.forEach((stop) => {
    stop.anchors.forEach((a, i) => {
      anchors.push({
        path: a.path,
        range: newRange(a.hunk),
        ref: `${stop.id}.anchors[${i}]`
      });
    });
  });
  const anchorMatched = new Array(anchors.length).fill(false);
  const unexplained = [];
  let totalHunks = 0;
  for (const file of diffFiles) {
    const excluded = isIntentPath(file.path);
    for (const hunk of file.hunks) {
      if (!excluded)
        totalHunks++;
      const hunkRange = newRange(hunk);
      let covered = false;
      anchors.forEach((anchor, idx) => {
        if (anchor.path === file.path && rangesOverlap(anchor.range, hunkRange)) {
          covered = true;
          anchorMatched[idx] = true;
        }
      });
      if (!covered && !excluded) {
        const matters = strict || hunk.substantive;
        if (matters) {
          unexplained.push({ path: file.path, hunk });
          findings.push({
            check: "coverage",
            severity: "error",
            path: file.path,
            message: `Unexplained change: ${file.path} lines ${hunkRange[0]}-${hunkRange[1]} (new side) are not covered by any tour stop.`
          });
        }
      }
    }
  }
  const dangling = [];
  anchors.forEach((anchor, idx) => {
    if (!anchorMatched[idx]) {
      dangling.push({ path: anchor.path, anchorIndexPath: anchor.ref });
      findings.push({
        check: "coverage",
        severity: "warning",
        path: anchor.path,
        message: `Dangling anchor: ${anchor.ref} points at ${anchor.path} lines ${anchor.range[0]}-${anchor.range[1]} but no diff hunk overlaps it (stale anchor?).`
      });
    }
  });
  return { totalHunks, unexplained, dangling };
}
function runCrossRefs(document, findings) {
  const tourIds = new Set(document.tour.map((t) => t.id));
  for (const a of document.assumptions) {
    for (const dep of a.depends ?? []) {
      if (dep.startsWith("T") && !tourIds.has(dep)) {
        findings.push({
          check: "cross_refs",
          severity: "error",
          message: `Assumption ${a.id} depends on unknown tour stop "${dep}".`
        });
      }
    }
  }
  for (const t of document.tour) {
    if (t.parent != null && !tourIds.has(t.parent)) {
      findings.push({
        check: "cross_refs",
        severity: "error",
        message: `Tour stop ${t.id} has parent "${t.parent}" which does not exist.`
      });
    }
    if (t.parent === t.id) {
      findings.push({
        check: "cross_refs",
        severity: "error",
        message: `Tour stop ${t.id} is its own parent.`
      });
    }
  }
  reportDuplicates(document.tour.map((t) => t.id), "tour stop", findings);
  reportDuplicates(document.assumptions.map((a) => a.id), "assumption", findings);
  reportDuplicates((document.open_questions ?? []).map((q) => q.id), "open question", findings);
}
function reportDuplicates(ids, label, findings) {
  const seen = /* @__PURE__ */ new Set();
  for (const id of ids) {
    if (seen.has(id)) {
      findings.push({
        check: "cross_refs",
        severity: "error",
        message: `Duplicate ${label} id "${id}".`
      });
    }
    seen.add(id);
  }
}
function runRedaction(document, findings, extra) {
  const patterns = [
    ...DEFAULT_SECRET_PATTERNS,
    ...extra.map((src, i) => ({ name: `custom pattern #${i + 1}`, re: new RegExp(src) }))
  ];
  for (const { field, value } of walkStrings(document)) {
    for (const { name, re } of patterns) {
      if (re.test(value)) {
        findings.push({
          check: "redaction",
          severity: "error",
          path: field,
          message: `Possible secret (${name}) in field "${field}". Redact before publishing.`
        });
      }
    }
  }
}
function* walkStrings(obj, prefix = "") {
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
function isIntentPath(path) {
  return path === ".intent" || path.startsWith(".intent/");
}
function shaMatches(a, b) {
  const min = Math.min(a.length, b.length);
  if (min < 7)
    return a === b;
  return a.slice(0, min) === b.slice(0, min);
}
function formatAjvError(err) {
  const loc = err.instancePath || "(root)";
  return `Schema violation at ${loc}: ${err.message}${err.params && Object.keys(err.params).length ? ` (${JSON.stringify(err.params)})` : ""}`;
}

export {
  intentDocSchema,
  indexHunks,
  DEFAULT_PAGE_BYTES,
  pageDiff,
  summarizeFiles,
  renderPrDescription,
  validate
};
