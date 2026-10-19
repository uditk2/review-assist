/**
 * Every tool says what it does to the user's machine, and says it consistently.
 *
 * The directories that list this server read these annotations, and a client may let a
 * read-only tool run without asking. A wrong `readOnlyHint` is therefore not cosmetic: it
 * would let something that writes slip past the one prompt meant to catch it.
 */

import { describe, it, expect } from "vitest";
import { TOOL_META, toolAnnotations, toolMeta, type ToolName } from "../src/tool-meta.js";
import { ROLE_TOOLS } from "../src/roles.js";

const names = Object.keys(TOOL_META) as ToolName[];

describe("tool annotations", () => {
  it("covers every tool either role can reach", () => {
    for (const t of [...ROLE_TOOLS.author, ...ROLE_TOOLS.reviewer]) expect(names).toContain(t);
  });

  it("gives every tool a title and all four hints as booleans", () => {
    for (const n of names) {
      const a = toolAnnotations(toolMeta(n));
      expect(a.title.length, n).toBeGreaterThan(0);
      for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        expect(typeof a[k], `${n}.${k}`).toBe("boolean");
      }
    }
  });

  it("never marks a read-only tool destructive, and never reaches outside the machine", () => {
    for (const n of names) {
      const a = toolAnnotations(toolMeta(n));
      if (a.readOnlyHint) expect(a.destructiveHint, n).toBe(false);
      expect(a.openWorldHint, n).toBe(false);
    }
  });

  it("marks the tools that write the user's files as destructive", () => {
    // submit_document replaces .intent/<branch>.json in the repository; manage_consent
    // deletes a recorded decision; get_role_definitions with `install` writes and sweeps
    // agent files under the user's home.
    for (const n of ["submit_document", "manage_consent", "get_role_definitions"] as const) {
      expect(toolMeta(n).destructive, n).toBe(true);
    }
  });

  it("makes get_role_definitions read-only inside a plugin, where it installs nothing", () => {
    const a = toolAnnotations(toolMeta("get_role_definitions", { plugin: true }));
    expect(a.readOnlyHint).toBe(true);
    expect(a.destructiveHint).toBe(false);
  });
});
