/**
 * Installing role definitions has to reconcile, not just write.
 *
 * The case that motivates this: a repo still held `.claude/agents/intent-reviewer.md`
 * from an older version that installed at project scope. Claude Code prefers a
 * project-scoped subagent, so that copy shadowed the user-scoped one — the server
 * reported installing the current prompt while every session ran the old one.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { getRoles, installRoles, sweepStaleRoleDefinitions, ROLE_TOOLS } from "../src/roles.js";

const scratch = mkdtempSync(join(tmpdir(), "review-assist-roles-"));
const projectDir = join(scratch, "my-repo");
const claudeAgents = join(projectDir, ".claude", "agents");
const codexAgents = join(projectDir, ".codex", "agents");

const bundle = getRoles({ env: "claude" });

beforeEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  mkdirSync(claudeAgents, { recursive: true });
  mkdirSync(codexAgents, { recursive: true });
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("rendered definitions", () => {
  it("carry a provenance marker, so a later sweep knows what it wrote", () => {
    for (const role of Object.values(bundle.roles)) {
      expect(role.definition).toContain("review-assist-mcp: generated file");
    }
  });

  it("still render the tools allowlist that enforces the role split", () => {
    expect(bundle.roles.reviewer!.definition).toContain("mcp__review-assist__submit_document");
    expect(bundle.roles.author!.definition).not.toContain("mcp__review-assist__submit_document");
  });

  it("generate the access list from ROLE_TOOLS, so prose cannot drift from the allowlist", () => {
    // The frontmatter allowlist was already generated; the prose list beside it was not,
    // and the reviewer prompt ended up declaring three of the seven tools it had.
    for (const role of ["author", "reviewer"] as const) {
      const def = getRoles({ env: "claude", role }).roles[role]!.definition;
      for (const tool of ROLE_TOOLS[role]) {
        expect(def).toContain(`\`${tool}\``);
        expect(def).toContain(`mcp__review-assist__${tool}`);
      }
    }
  });

  it("do not grant the reviewer tools that belong to the orchestrator", () => {
    expect(ROLE_TOOLS.reviewer).not.toContain("get_role_definitions");
    expect(ROLE_TOOLS.reviewer).not.toContain("manage_consent");
    expect(ROLE_TOOLS.reviewer).toContain("submit_document");
    expect(ROLE_TOOLS.author).not.toContain("submit_document");
  });

  it("leave no unsubstituted placeholders", () => {
    for (const role of Object.values(bundle.roles)) {
      expect(role.definition).not.toMatch(/\{\{[A-Z]+\}\}/);
    }
  });
});

describe("sweepStaleRoleDefinitions", () => {
  it("removes a project-scoped definition, which always shadows the real one", () => {
    const stale = join(claudeAgents, "intent-reviewer.md");
    writeFileSync(stale, "---\nname: intent-reviewer\ntools: mcp__review-assist__submit_document\n---\nold\n");
    const removed = sweepStaleRoleDefinitions(bundle, [projectDir]);
    expect(removed).toContain(stale);
    expect(existsSync(stale)).toBe(false);
  });

  it("removes project-scoped copies for OTHER clients too — none of them belong there", () => {
    const staleCodex = join(codexAgents, "intent-author.toml");
    writeFileSync(staleCodex, 'name = "intent-author"\nenv = { REVIEW_ASSIST_ROLE = "author" }\n');
    const removed = sweepStaleRoleDefinitions(bundle, [projectDir]);
    expect(removed).toContain(staleCodex);
  });

  it("removes definitions written before the marker existed", () => {
    // No marker; recognised by the allowlist an older render always emitted.
    const legacy = join(claudeAgents, "intent-author.md");
    writeFileSync(legacy, "---\ntools: mcp__review-assist__read_transcript\n---\n");
    expect(sweepStaleRoleDefinitions(bundle, [projectDir])).toContain(legacy);
  });

  it("never touches a file it did not write", () => {
    const handWritten = join(claudeAgents, "intent-reviewer.md");
    writeFileSync(handWritten, "---\nname: intent-reviewer\n---\nMy own reviewer, nothing to do with review-assist.\n");
    const mine = join(claudeAgents, "my-helper.md");
    writeFileSync(mine, "---\nname: my-helper\ntools: mcp__review-assist__compute_diff\n---\n");

    const removed = sweepStaleRoleDefinitions(bundle, [projectDir]);
    expect(removed).not.toContain(handWritten);
    expect(existsSync(handWritten)).toBe(true);
    // Not one of our filenames, so out of scope even though it mentions our tools.
    expect(removed).not.toContain(mine);
    expect(existsSync(mine)).toBe(true);
  });

  it("leaves user-scope definitions that are part of the current bundle", () => {
    const removed = sweepStaleRoleDefinitions(bundle, [projectDir]);
    for (const role of Object.values(bundle.roles)) {
      expect(removed).not.toContain(join(bundle.install_dir!, role.filename));
    }
  });

  it("refuses to treat the home directory as project scope", () => {
    // Guards the degenerate case where the server is started from ~, which would
    // otherwise make the project sweep delete the real user-scope definitions.
    expect(sweepStaleRoleDefinitions(bundle, [homedir()])).toEqual([]);
  });

  it("is idempotent — a clean tree sweeps to nothing", () => {
    expect(sweepStaleRoleDefinitions(bundle, [projectDir])).toEqual([]);
  });
});

describe("installRoles", () => {
  it("writes definitions that the sweep then recognises as its own", () => {
    const local = { ...bundle, install_dir: claudeAgents };
    const written = installRoles(local);
    expect(written).toHaveLength(2);
    for (const path of written) {
      expect(readFileSync(path, "utf8")).toContain("review-assist-mcp: generated file");
    }
    expect(sweepStaleRoleDefinitions(bundle, [projectDir]).sort()).toEqual(written.sort());
  });

  it("onlyIfChanged does not churn a steady state", () => {
    const local = { ...bundle, install_dir: claudeAgents };
    installRoles(local);
    expect(installRoles(local, { onlyIfChanged: true })).toEqual([]);
  });
});
