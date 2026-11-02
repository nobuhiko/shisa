// SPDX-License-Identifier: GPL-2.0-or-later
// 店の受け口を署名付きで 1 回呼ぶ。返事の署名も確かめる
import { signRequest, responseSignature, timingSafeEqualHex } from "./sign.js";
import type { Shop } from "./store.js";

export type ReceiverResult = { ok: true; result: any } | { ok: false; error: string; detail?: string };

export async function callReceiver(shop: Shop, op: string, args: Record<string, unknown> = {}): Promise<ReceiverResult> {
  const url = new URL(shop.receiver_url);
  const body = JSON.stringify({ op, args });
  const headers = await signRequest(shop.secret, "POST", url.pathname, shop.shop_id, body);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(28_000),
    });
  } catch (e) {
    return { ok: false, error: "unreachable", detail: `受け口につながりません: ${(e as Error).message}` };
  }
  const text = await res.text();
  if (res.status === 401) return { ok: false, error: "unauthorized", detail: "受け口が署名を受け付けませんでした" };
  const sig = res.headers.get("x-sh-signature") ?? "";
  const expect = await responseSignature(shop.secret, headers["X-SH-Nonce"], text);
  if (!timingSafeEqualHex(expect, sig)) {
    return { ok: false, error: "bad_response_signature", detail: `返事の署名が合いません(HTTP ${res.status}、先頭: ${text.slice(0, 200)})` };
  }
  try {
    return JSON.parse(text) as ReceiverResult;
  } catch {
    return { ok: false, error: "bad_response", detail: text.slice(0, 500) };
  }
}
