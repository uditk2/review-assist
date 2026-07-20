/**
 * Stateless session handling.
 *
 * The user's GitHub access token is held only inside an encrypted, HTTP-only cookie
 * (AES-GCM, key derived from SESSION_SECRET). The Worker keeps NO server-side session
 * store — decrypting the cookie is the entire session lookup. This is what lets the
 * whole App run on Workers with zero state.
 */

export interface Session {
  token: string;
  login: string;
  /** Epoch seconds when the GitHub token is expected to expire (best-effort). */
  exp?: number;
}

const COOKIE = "idsess";
const enc = new TextEncoder();
const dec = new TextDecoder();

async function keyFrom(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sealSession(session: Session, secret: string): Promise<string> {
  const key = await keyFrom(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = enc.encode(JSON.stringify(session));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt));
  return `${b64urlEncode(iv)}.${b64urlEncode(ct)}`;
}

export async function openSession(value: string, secret: string): Promise<Session | null> {
  try {
    const [ivPart, ctPart] = value.split(".");
    if (!ivPart || !ctPart) return null;
    const key = await keyFrom(secret);
    const iv = b64urlDecode(ivPart);
    const ct = b64urlDecode(ctPart);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    const session = JSON.parse(dec.decode(pt)) as Session;
    if (session.exp && session.exp < Math.floor(Date.now() / 1000)) return null;
    return session;
  } catch {
    return null;
  }
}

export function readCookie(request: Request, name = COOKIE): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export function setCookieHeader(value: string, maxAgeSeconds: number, name = COOKIE): string {
  const attrs = [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  return attrs.join("; ");
}

export function clearCookieHeader(name = COOKIE): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export { COOKIE };
