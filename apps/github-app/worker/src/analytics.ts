/**
 * Product events for Google Analytics, sent from the Worker over the Measurement Protocol.
 *
 * The steps of the funnel that happen without a browser on reviewassist.dev: an App
 * installed or removed, repositories added to it, a guided review posted on a pull request.
 * The site pages report their own steps through gtag; these complete the picture.
 *
 * What is sent, and only this: an event name, counts, GitHub's all/selected setting and
 * the pull request action. Never a repository, owner or account name, and never content.
 * The installation is identified by an HMAC of its id, so GA can count per installation
 * without holding the id GitHub uses.
 *
 * The HMAC key is derived from SESSION_SECRET, which only this Worker holds. It used to be
 * the GA API secret, but that travels to Google in every request URL and is readable in
 * the GA admin UI, and installation ids are small sequential integers: anyone holding the
 * key could hash every id and read the pseudonyms back. Rotating SESSION_SECRET (which
 * also signs everyone out) re-keys every installation, and they count as new from then on.
 *
 * Off unless GA_API_SECRET is set. The measurement id is a public var in wrangler.toml, so
 * a self-hosted copy deployed from this repo would otherwise report into this property;
 * the secret is what it does not have.
 */

export interface AnalyticsEnv {
  GA_MEASUREMENT_ID?: string;
  GA_API_SECRET?: string;
  SESSION_SECRET?: string;
}

type Params = Record<string, string | number>;

const MP_COLLECT = "https://www.google-analytics.com/mp/collect";

export async function reportEvent(env: AnalyticsEnv, installationId: number, name: string, params: Params = {}): Promise<void> {
  if (!env.GA_MEASUREMENT_ID || !env.GA_API_SECRET || !env.SESSION_SECRET) return;
  const url = `${MP_COLLECT}?measurement_id=${encodeURIComponent(env.GA_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(env.GA_API_SECRET)}`;
  const body = {
    client_id: await installationPseudonym(env.SESSION_SECRET, installationId),
    non_personalized_ads: true,
    // Without an engagement time GA records the event but leaves it out of user counts.
    events: [{ name, params: { ...params, engagement_time_msec: 1 } }],
  };
  try {
    await fetch(url, { method: "POST", body: JSON.stringify(body) });
  } catch {
    // Analytics never fails a webhook. The Measurement Protocol answers 2xx even to a
    // malformed hit, so there is nothing useful to do with a response either.
  }
}

/** HMAC-SHA256 of the installation id, first 128 bits as hex. Stable per installation.
 *  The label keeps this use of the secret apart from the session cookie's. */
export async function installationPseudonym(secret: string, installationId: number): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`review-assist/ga-pseudonym/installation:${installationId}`));
  return [...new Uint8Array(mac).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface InstallationPayload {
  action: string;
  installation?: { id: number; repository_selection?: string };
  repositories?: unknown[];
  repository_selection?: string;
  repositories_added?: unknown[];
  repositories_removed?: unknown[];
}

/**
 * Map GitHub's `installation` and `installation_repositories` events (delivered to every
 * App by default, with no subscription) to a GA event, or null for actions not counted
 * (suspend, unsuspend, new_permissions_accepted). Counts only: the repository lists in
 * these payloads carry names, and none of them leave this function.
 */
export function installationEvent(event: string, p: InstallationPayload): { name: string; params: Params } | null {
  if (event === "installation") {
    if (p.action === "created") return { name: "app_installed", params: {
      repository_selection: p.installation?.repository_selection ?? "unknown",
      repositories: p.repositories?.length ?? 0,
    } };
    if (p.action === "deleted") return { name: "app_uninstalled", params: {} };
    return null;
  }
  if (event === "installation_repositories" && (p.action === "added" || p.action === "removed")) {
    return { name: "app_repositories_changed", params: {
      repository_selection: p.repository_selection ?? p.installation?.repository_selection ?? "unknown",
      added: p.repositories_added?.length ?? 0,
      removed: p.repositories_removed?.length ?? 0,
    } };
  }
  return null;
}
