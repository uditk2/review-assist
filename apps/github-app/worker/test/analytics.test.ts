import { afterEach, describe, expect, it, vi } from "vitest";
import { installationEvent, installationPseudonym, reportEvent } from "../src/analytics.js";

const ON = { GA_MEASUREMENT_ID: "G-TEST", GA_API_SECRET: "s3cret", SESSION_SECRET: "worker-only" };

afterEach(() => vi.unstubAllGlobals());

describe("installationEvent", () => {
  it("counts an install with its repository setting and size", () => {
    expect(installationEvent("installation", {
      action: "created",
      installation: { id: 7, repository_selection: "selected" },
      repositories: [{ full_name: "acme/a" }, { full_name: "acme/b" }],
    })).toEqual({ name: "app_installed", params: { repository_selection: "selected", repositories: 2 } });
  });

  it("counts an uninstall, and ignores suspend and permission changes", () => {
    expect(installationEvent("installation", { action: "deleted", installation: { id: 7 } })?.name).toBe("app_uninstalled");
    expect(installationEvent("installation", { action: "suspend", installation: { id: 7 } })).toBeNull();
    expect(installationEvent("installation", { action: "new_permissions_accepted", installation: { id: 7 } })).toBeNull();
  });

  it("counts repositories added and removed", () => {
    expect(installationEvent("installation_repositories", {
      action: "added",
      installation: { id: 7 },
      repository_selection: "selected",
      repositories_added: [{ full_name: "acme/c" }],
      repositories_removed: [],
    })).toEqual({ name: "app_repositories_changed", params: { repository_selection: "selected", added: 1, removed: 0 } });
  });

  // The payloads carry repository names; the whole point of this module is that they stay here.
  it("never passes a repository or account name through", () => {
    const counted = installationEvent("installation", {
      action: "created",
      installation: { id: 7, repository_selection: "all" },
      repositories: [{ name: "secret-repo", full_name: "acme-corp/secret-repo" }],
    });
    expect(JSON.stringify(counted)).not.toMatch(/acme-corp|secret-repo/);
  });
});

describe("reportEvent", () => {
  it("sends nothing without the API secret, or without a key to hash with", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await reportEvent({ GA_MEASUREMENT_ID: "G-TEST", SESSION_SECRET: "worker-only" }, 7, "app_installed");
    await reportEvent({ GA_MEASUREMENT_ID: "G-TEST", GA_API_SECRET: "s3cret" }, 7, "app_installed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts one event under a pseudonym, not the installation id", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    await reportEvent(ON, 4242, "review_posted", { changes_total: 4 });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://www.google-analytics.com/mp/collect?measurement_id=G-TEST&api_secret=s3cret");
    const body = JSON.parse(init.body);
    expect(body.client_id).toMatch(/^[0-9a-f]{32}$/);
    expect(body.client_id).not.toContain("4242");
    // The api_secret is in the URL Google receives, so it must not be what keys the hash:
    // with it and the small, sequential id space, the pseudonym could be reversed.
    expect(body.client_id).toBe(await installationPseudonym("worker-only", 4242));
    expect(body.client_id).not.toBe(await installationPseudonym("s3cret", 4242));
    expect(body.events).toEqual([{ name: "review_posted", params: { changes_total: 4, engagement_time_msec: 1 } }]);
  });

  it("keeps the same pseudonym per installation, and a different one per installation", async () => {
    expect(await installationPseudonym("k", 1)).toBe(await installationPseudonym("k", 1));
    expect(await installationPseudonym("k", 1)).not.toBe(await installationPseudonym("k", 2));
  });

  it("never throws when GA is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(reportEvent(ON, 7, "app_installed")).resolves.toBeUndefined();
  });
});
