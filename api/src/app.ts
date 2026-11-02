// SPDX-License-Identifier: GPL-2.0-or-later
// API の入口(docs/api.md の「店 → API」)
import { Hono, type Context } from "hono";
import { verifyRequest, randomHex, NONCE_TTL_SEC } from "./sign.js";
import { callReceiver } from "./receiver.js";
import { newRun } from "./agent.js";
import type { Shop, Store } from "./store.js";

export function createApp(store: Store, kick: (runId: string) => void) {
  // 店ごとに同時に回す点検は 1 つだけ
  async function startRun(shop: Shop, advisoryUrl: string | null, trigger: "connect" | "manual") {
    const running = (await store.listRuns(shop.shop_id)).find((r) => r.status === "running");
    if (running && !advisoryUrl) return running.run_id;
    const run = newRun(`run_${randomHex(8)}`, shop, advisoryUrl, trigger);
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
    const runId = ping.ok ? await startRun(shop, null, "connect") : null;
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
    return c.json({ ok: true, run_id: await startRun(shop, adv ?? null, "manual") });
  });

  app.get("/v1/shops/:id/runs/:run_id", async (c) => {
    const shop = await authShop(c, c.req.param("id"), "");
    if (!shop) return unauthorized(c);
    const run = await store.getRun(c.req.param("run_id"));
    if (!run || run.shop_id !== shop.shop_id) return c.json({ ok: false, error: "not_found" }, 404);
    return c.json({ ok: true, run_id: run.run_id, status: run.status, trigger: run.trigger, advisory_url: run.advisory_url, steps: run.steps, report: run.report ?? null, usage: run.usage });
  });

  app.get("/v1/shops/:id/runs", async (c) => {
    const shop = await authShop(c, c.req.param("id"), "");
    if (!shop) return unauthorized(c);
    const runs = await store.listRuns(shop.shop_id);
    return c.json({ ok: true, runs: runs.slice(0, 20).map((r) => ({ run_id: r.run_id, status: r.status, trigger: r.trigger, advisory_url: r.advisory_url, created_at: r.created_at })) });
  });

  return app;
}
