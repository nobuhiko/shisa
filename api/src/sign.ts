// SPDX-License-Identifier: GPL-2.0-or-later
// 署名(docs/api.md)。WebCrypto だけを使うので Node でも Workers でも動く
const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(data)));
}

export async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function stringToSign(method: string, path: string, shop: string, ts: string, nonce: string, body: string) {
  return ["SH1", method, path, shop, ts, nonce, await sha256Hex(body)].join("\n");
}

export async function signRequest(secret: string, method: string, path: string, shop: string, body: string, now = Date.now()) {
  const ts = String(Math.floor(now / 1000));
  const nonce = randomHex(16);
  const sig = await hmacHex(secret, await stringToSign(method, path, shop, ts, nonce, body));
  return { "X-SH-Shop": shop, "X-SH-Timestamp": ts, "X-SH-Nonce": nonce, "X-SH-Signature": sig };
}

export async function responseSignature(secret: string, nonce: string, body: string) {
  return hmacHex(secret, `SH1-RES\n${nonce}\n${await sha256Hex(body)}`);
}

export const TIME_WINDOW_SEC = 300;
export const NONCE_TTL_SEC = 600;

// 店から API への呼び出しを確かめる。通れば nonce を返す(記録は呼び出し側)
export async function verifyRequest(
  secret: string,
  shopId: string,
  method: string,
  path: string,
  headers: { get(name: string): string | null | undefined },
  body: string,
  now = Date.now(),
): Promise<string | null> {
  const shop = headers.get("x-sh-shop");
  const ts = headers.get("x-sh-timestamp");
  const nonce = headers.get("x-sh-nonce");
  const sig = headers.get("x-sh-signature");
  if (!shop || !ts || !nonce || !sig) return null;
  if (!/^[0-9]{1,12}$/.test(ts) || !/^[0-9a-f]{32,64}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) return null;
  if (shop !== shopId) return null;
  if (Math.abs(Math.floor(now / 1000) - Number(ts)) > TIME_WINDOW_SEC) return null;
  const expect = await hmacHex(secret, await stringToSign(method, path, shop, ts, nonce, body));
  return timingSafeEqualHex(expect, sig) ? nonce : null;
}
