/**
 * GitHub App server-to-server auth for the webhook.
 *
 * To act as the app bot (post checks + comments) we mint a short-lived *installation
 * access token*: sign an App JWT (RS256) with the app private key, then exchange it at
 * POST /app/installations/{id}/access_tokens.
 *
 * WebCrypto's importKey only accepts PKCS#8 for RSA. GitHub issues PKCS#1 keys
 * ("BEGIN RSA PRIVATE KEY"), so those are wrapped into PKCS#8 before import. PKCS#8
 * keys ("BEGIN PRIVATE KEY") are used as-is.
 */

const GH_API = "https://api.github.com";
const UA = "review-assist-viewer";

export async function installationToken(
  appId: string,
  privateKeyPem: string,
  installationId: number
): Promise<string> {
  const jwt = await appJwt(appId, privateKeyPem);
  const res = await fetch(`${GH_API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": UA,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`installation token exchange failed (${res.status}): ${await res.text()}`);
  }
  return ((await res.json()) as { token: string }).token;
}

async function appJwt(appId: string, pem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  // iat backdated 60s for clock skew; exp <= 10 min (GitHub max).
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const key = await importRsaPrivateKey(pem);
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  const isPkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
  const der = pemToDer(pem);
  const pkcs8 = isPkcs1 ? wrapPkcs1ToPkcs8(der) : der;
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Wrap a PKCS#1 RSAPrivateKey DER as a PKCS#8 PrivateKeyInfo. */
function wrapPkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  // PrivateKeyInfo ::= SEQUENCE { version INTEGER(0), algorithm rsaEncryption, privateKey OCTET STRING }
  const rsaAlgId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const version = [0x02, 0x01, 0x00];
  const octetString = der(0x04, pkcs1);
  const body = concat([new Uint8Array(version), new Uint8Array(rsaAlgId), octetString]);
  return der(0x30, body);
}

/** TLV: tag + DER length + content. */
function der(tag: number, content: Uint8Array): Uint8Array {
  const len = content.length;
  let lenBytes: number[];
  if (len < 0x80) lenBytes = [len];
  else if (len < 0x100) lenBytes = [0x81, len];
  else if (len < 0x10000) lenBytes = [0x82, (len >> 8) & 0xff, len & 0xff];
  else lenBytes = [0x83, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff];
  return concat([new Uint8Array([tag, ...lenBytes]), content]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function b64urlJson(o: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(o)));
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
