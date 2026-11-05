// SPDX-License-Identifier: GPL-2.0-or-later
// API の入口(docs/api.md の「店 → API」)
import { Hono, type Context } from "hono";
import { verifyRequest, randomHex, NONCE_TTL_SEC, apiResponseSignature } from "./sign.js";
import { callReceiver } from "./receiver.js";
import { newRun } from "./agent.js";
import type { Shop, Store, Proposal } from "./store.js";
import { applyApproved, applyUpgrade } from "./tools.js";
import { dailyQuotaExceeded, isFirstRun, usd } from "./cost.js";

export function createApp(store: Store, kick: (runId: string) => void) {
  // 店ごとに同時に回す点検は 1 つだけ
  async function startRun(shop: Shop, advisoryUrl: string | null, trigger: "connect" | "manual"): Promise<string | { refused: string }> {
    const runs = await store.listRuns(shop.shop_id);
    const running = runs.find((r) => r.status === "running");
    if (running) {
      // 同じ店で 2 つの点検が同時に書き換えないように、通知は動いている点検に渡す
      if (advisoryUrl) await store.addInbox(running.run_id, advisoryUrl);
      return running.run_id;
    }
    // 鍵が漏れても呼び放題にさせない: 店ごとの 1 日の回数と費用の上限
    const over = dailyQuotaExceeded(runs);
    if (over) return { refused: over };
    const run = newRun(`run_${randomHex(8)}`, shop, advisoryUrl, trigger, isFirstRun(runs));
    await store.putRun(run);
    kick(run.run_id);
    return run.run_id;
  }

  const app = new Hono();

  // 店からの署名付き呼び出しを確かめる
  async function authShop(c: Context, shopId: string, body: string): Promise<Shop | null> {
    const shop = await store.getShop(shopId);
    if (!shop) return null;
    const path = new URL(c.req.url).pathname;
    const nonce = await verifyRequest(shop.secret, shop.shop_id, c.req.method, path, c.req.raw.headers, body);
    if (!nonce) return null;
    if (!(await store.useNonce(`${shop.shop_id}:${nonce}`, NONCE_TTL_SEC))) return null;
    return shop;
  }

  const unauthorized = (c: Context) => c.json({ ok: false, error: "unauthorized" }, 401);
  // 承認にかかわる返事には署名を付ける(プラグインが確かめる。途中で書き換えられた提案を承認させないため)。呼び出しの nonce に結びつける
  async function signedJson(c: Context, shop: Shop, data: unknown, status = 200) {
    const body = JSON.stringify(data);
    const nonce = c.req.header("x-sh-nonce") ?? "";
    return c.body(body, status as any, { "Content-Type": "application/json", "X-SH-Api-Signature": await apiResponseSignature(shop.secret, nonce, body) });
  }

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/v1/shops", async (c) => {
    const body = await c.req.text();
    let req: any;
    try { req = JSON.parse(body); } catch { return c.json({ ok: false, error: "bad_request" }, 400); }
    const { receiver_url, shop_url, secret, platform } = req ?? {};
    const valid = (u: unknown) => typeof u === "string" && /^https?:\/\//.test(u);
    if (!valid(receiver_url) || !valid(shop_url) || typeof secret !== "string" || !/^[0-9a-f]{64}$/.test(secret)) {
      return c.json({ ok: false, error: "bad_request" }, 400);
    }
    let shopId: string = typeof req.shop_id === "string" && /^shp_[a-z0-9]{8,32}$/.test(req.shop_id) ? req.shop_id : `shp_${randomHex(8)}`;
    const existing = await store.getShop(shopId);
    // 登録し直すときは、前の鍵で署名されていること(他人の登録を上書きさせない)
    if (existing && !(await authShop(c, shopId, body))) return unauthorized(c);
    const shop: Shop = { shop_id: shopId, secret, receiver_url, shop_url, platform: String(platform ?? ""), status: "registered", created_at: Date.now() };
    const ping = await callReceiver(shop, "ping", {});
    shop.status = ping.ok ? "connected" : "error";
    await store.putShop(shop);
    // つながったら、押されるのを待たずに最初の点検を始める
    // 撮影などで、つないだだけでは始めたくないときは SH_AUTO_ON_CONNECT=0
    const started = ping.ok && process.env.SH_AUTO_ON_CONNECT !== "0" ? await startRun(shop, null, "connect") : null;
    const runId = typeof started === "string" ? started : null;
    return c.json({ ok: ping.ok, shop_id: shopId, status: shop.status, run_id: runId, ping: ping.ok ? ping.result : ping });
  });

  app.post("/v1/shops/:id/runs", async (c) => {
    const body = await c.req.text();
    const shop = await authShop(c, c.req.param("id"), body);
    if (!shop) return unauthorized(c);
    let req: any = {};
    try { req = body ? JSON.parse(body) : {}; } catch { return c.json({ ok: false, error: "bad_request" }, 400); }
    const adv = req.advisory_url;
    if (adv != null && (typeof adv !== "string" || !/^https?:\/\/[^\s]{1,2000}$/.test(adv))) return c.json({ ok: false, error: "bad_advisory_url" }, 400);
    const started = await startRun(shop, adv ?? null, "manual");
    if (typeof started !== "string") return c.json({ ok: false, error: "quota", detail: started.refused }, 429);
    return c.json({ ok: true, run_id: started });
  });

  app.get("/v1/shops/:id/runs/:run_id", async (c) => {
    const shop = await authShop(c, c.req.param("id"), "");
    if (!shop) return unauthorized(c);
    const run = await store.getRun(c.req.param("run_id"));
    if (!run || run.shop_id !== shop.shop_id) return c.json({ ok: false, error: "not_found" }, 404);
    return c.json({ ok: true, interval_hours: Number(process.env.SH_AUTO_INTERVAL_HOURS ?? 24), run_id: run.run_id, status: run.status, trigger: run.trigger, advisory_url: run.advisory_url, steps: run.steps, report: run.report ?? null, usage: { ...run.usage, usd: Number(usd(run.usage).toFixed(2)) } });
  });

  app.get("/v1/shops/:id/runs", async (c) => {
    const shop = await authShop(c, c.req.param("id"), "");
    if (!shop) return unauthorized(c);
    const runs = await store.listRuns(shop.shop_id);
    return c.json({ ok: true, runs: runs.slice(0, 20).map((r) => ({ run_id: r.run_id, status: r.status, trigger: r.trigger, advisory_url: r.advisory_url, created_at: r.created_at, usd: Number(usd(r.usage).toFixed(2)) })) });
  });

  // 店主の承認で直す提案。新しいものから。中身(書く中身の全部と差分)も渡す。管理画面はお店の中で今の中身と比べて見せる
  const proposalOut = (p: Proposal) => ({ proposal_id: p.proposal_id, run_id: p.run_id, path: p.path, title: p.title, owner_text: p.owner_text, developer_text: p.developer_text,
    sha256_before: p.sha256_before, sha256_new: p.sha256_new, new_content: p.new_content, diff: p.diff, status: p.status, created_at: p.created_at, decided_at: p.decided_at ?? null, result: p.result ?? null,
    kind: p.kind ?? "fix", from_version: p.from_version ?? null, to_version: p.to_version ?? null, upgrade: p.upgrade ?? null,
    fingerprint: p.fingerprint ?? null, keep: p.keep ?? [] });

  app.get("/v1/shops/:id/proposals", async (c) => {
    const shop = await authShop(c, c.req.param("id"), "");
    if (!shop) return unauthorized(c);
    const list = (await store.listProposals(shop.shop_id)).filter((p) => p.status !== "superseded").slice(0, 20);
    return signedJson(c, shop, { ok: true, proposals: list.map(proposalOut) });
  });

  app.get("/v1/shops/:id/proposals/:pid", async (c) => {
    const shop = await authShop(c, c.req.param("id"), "");
    if (!shop) return unauthorized(c);
    const p = await store.getProposal(c.req.param("pid"));
    if (!p || p.shop_id !== shop.shop_id) return signedJson(c, shop, { ok: false, error: "not_found" }, 404);
    return signedJson(c, shop, { ok: true, proposal: proposalOut(p) });
  });

  // 承認の印は、お店の管理画面(プラグイン)がお店の中の承認の鍵で作る。API は印を作れず、窓口へ取り次ぐだけ
  app.post("/v1/shops/:id/proposals/:pid/approve", async (c) => {
    const body = await c.req.text();
    const shop = await authShop(c, c.req.param("id"), body);
    if (!shop) return unauthorized(c);
    const p = await store.getProposal(c.req.param("pid"));
    if (!p || p.shop_id !== shop.shop_id) return signedJson(c, shop, { ok: false, error: "not_found" }, 404);
    if (p.status !== "pending") return signedJson(c, shop, { ok: false, error: "not_pending", detail: "この提案はもう決まっています", status: p.status }, 409);
    let req: any;
    try { req = JSON.parse(body); } catch { return signedJson(c, shop, { ok: false, error: "bad_request" }, 400); }
    return signedJson(c, shop, p.kind === "upgrade" ? await applyUpgrade(shop, store, p, req?.approval) : await applyApproved(shop, store, p, req?.approval));
  });

  return app;
}
