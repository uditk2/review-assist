/**
 * Intent Document Viewer — Cloudflare Worker.
 *
 * Role: auth broker + thin GitHub proxy. It is deliberately NOT a renderer — the
 * viewer SPA renders client-side. The Worker only:
 *   - runs the GitHub OAuth web flow (the token endpoint lacks CORS, so this MUST be
 *     server-side; nothing else needs a server)
 *   - holds the user's token in an encrypted, HTTP-only cookie (see session.ts)
 *   - fetches the intent document + PR diff from GitHub with the user's own token
 *
 * Statelessness (normative, per SPEC §6.2):
 *   - no KV/D1/R2/DO; the only "state" is the encrypted cookie
 *   - responses carrying repo content are `private, no-store` and MUST NOT be cached
 *   - static assets (the SPA) MAY be edge-cached; they contain no repo content
 */

import {
  sealSession,
  openSession,
  readCookie,
  setCookieHeader,
  clearCookieHeader,
  type Session,
} from "./session.js";

interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  APP_NAME?: string;
}

const GH_API = "https://api.github.com";
const UA = "review-assist-viewer";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/login") return handleLogin(url, env);
      if (path === "/api/callback") return handleCallback(url, env);
      if (path === "/api/logout") return handleLogout();
      if (path === "/api/me") return handleMe(request, env);
      if (path === "/api/document") return handleDocument(request, url, env);
    } catch (e) {
      return json({ error: (e as Error).message }, 500, true);
    }

    // Everything else: the static viewer SPA (edge-cacheable, no repo content).
    return env.ASSETS.fetch(request);
  },
};

function handleLogin(url: URL, env: Env): Response {
  const redirectUri = `${url.origin}/api/callback`;
  const returnTo = url.searchParams.get("return") ?? "/";
  const state = b64url(JSON.stringify({ r: returnTo, n: crypto.randomUUID() }));
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", "repo read:user");
  authorize.searchParams.set("state", state);
  // state is echoed back and validated in the callback (CSRF guard).
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      "Set-Cookie": setCookieHeader(state, 600, "idstate"),
    },
  });
}

async function handleCallback(url: URL, env: Env): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return json({ error: "missing code/state" }, 400, true);

  let returnTo = "/";
  try {
    returnTo = JSON.parse(new TextDecoder().decode(fromB64url(state))).r ?? "/";
  } catch {
    /* ignore; default home */
  }

  // Server-side token exchange (GitHub's token endpoint does not send CORS headers,
  // which is exactly why a purely static page cannot do this and the Worker must).
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/api/callback`,
    }),
  });
  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!tokenData.access_token) {
    return json({ error: tokenData.error_description ?? "token exchange failed" }, 401, true);
  }

  const login = await fetchLogin(tokenData.access_token);
  const session: Session = {
    token: tokenData.access_token,
    login,
    exp: tokenData.expires_in ? Math.floor(Date.now() / 1000) + tokenData.expires_in : undefined,
  };
  const sealed = await sealSession(session, env.SESSION_SECRET);

  const headers = new Headers({ Location: safeReturn(returnTo, url.origin) });
  headers.append("Set-Cookie", setCookieHeader(sealed, 8 * 3600));
  headers.append("Set-Cookie", clearCookieHeader("idstate"));
  return new Response(null, { status: 302, headers });
}

function handleLogout(): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: "/", "Set-Cookie": clearCookieHeader() },
  });
}

async function handleMe(request: Request, env: Env): Promise<Response> {
  const session = await currentSession(request, env);
  return json({ login: session?.login ?? null }, 200, true);
}

async function handleDocument(request: Request, url: URL, env: Env): Promise<Response> {
  const session = await currentSession(request, env);
  if (!session) return json({ error: "unauthenticated" }, 401, true);

  const owner = url.searchParams.get("owner");
  const repo = url.searchParams.get("repo");
  const pull = url.searchParams.get("pull");
  if (!owner || !repo || !pull) return json({ error: "owner, repo, pull required" }, 400, true);

  const gh = (p: string, accept = "application/vnd.github+json") =>
    fetch(`${GH_API}${p}`, {
      headers: {
        Authorization: `Bearer ${session.token}`,
        Accept: accept,
        "User-Agent": UA,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

  // 1. PR metadata → head ref/sha, base sha.
  const prRes = await gh(`/repos/${owner}/${repo}/pulls/${pull}`);
  if (!prRes.ok) return json({ error: `PR fetch failed (${prRes.status})` }, prRes.status, true);
  const pr = (await prRes.json()) as {
    head: { ref: string; sha: string };
    base: { sha: string };
    number: number;
    title: string;
  };

  // 2. Intent document from the head ref: .intent/<branch>.json.
  const branchFile = pr.head.ref.replace(/[/\\]/g, "-");
  let document: unknown = null;
  const docRes = await gh(
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(`.intent/${branchFile}.json`)}?ref=${pr.head.sha}`,
    "application/vnd.github.raw+json"
  );
  if (docRes.ok) {
    document = await docRes.json();
  }

  // 3. PR diff (base...head).
  const diffRes = await gh(
    `/repos/${owner}/${repo}/compare/${pr.base.sha}...${pr.head.sha}`,
    "application/vnd.github.diff"
  );
  const diff = diffRes.ok ? await diffRes.text() : "";

  return json(
    {
      meta: { owner, repo, pull: pr.number, title: pr.title, head_sha: pr.head.sha },
      document,
      diff,
      document_missing: document === null,
    },
    200,
    true // no-store: this carries private repo content
  );
}

async function currentSession(request: Request, env: Env): Promise<Session | null> {
  const raw = readCookie(request);
  if (!raw) return null;
  return openSession(raw, env.SESSION_SECRET);
}

async function fetchLogin(token: string): Promise<string> {
  const res = await fetch(`${GH_API}/user`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": UA },
  });
  if (!res.ok) return "unknown";
  return ((await res.json()) as { login: string }).login;
}

function json(body: unknown, status = 200, noStore = false): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // Any response that may carry repo content is private + uncacheable, by contract.
  headers["Cache-Control"] = noStore ? "private, no-store" : "no-cache";
  return new Response(JSON.stringify(body), { status, headers });
}

function safeReturn(returnTo: string, origin: string): string {
  // Only allow same-origin relative returns, to prevent open-redirect via state.
  if (returnTo.startsWith("/") && !returnTo.startsWith("//")) return origin + returnTo;
  return origin + "/";
}

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Uint8Array {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
