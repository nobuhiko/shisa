// SPDX-License-Identifier: GPL-2.0-or-later
// 手元(Node)で動かす入口。点検は 1 歩ずつ保存しながら、API の側で回す(店には時計が無い)
import { serve } from "@hono/node-server";
import Anthropic from "@anthropic-ai/sdk";
import { createApp } from "./app.js";
import { mountDemo } from "./demo.js";
import { FileStore } from "./store.js";
import { step, newRun } from "./agent.js";
import { randomHex } from "./sign.js";
import { dailyQuotaExceeded, isFirstRun } from "./cost.js";

const store = new FileStore(process.env.SH_DATA_DIR ?? "./data");
const client = new Anthropic(); // ANTHROPIC_API_KEY は env_file(.env)から入る
const active = new Set<string>();

async function drive(runId: string) {
  if (active.has(runId)) return;
  active.add(runId);
  try {
    for (;;) {
      let run = await store.getRun(runId);
      if (!run || run.status !== "running") return;
      const shop = await store.getShop(run.shop_id);
      if (!shop) return;
      const delay = run.wake_at - Date.now();
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      run = await step(client, store, { ...run, wake_at: 0 }, shop);
      console.log(`[run ${runId}] turn ${run.turns} ${run.status} ${run.steps.at(-1)?.title ?? ""}`);
    }
  } catch (e) {
    console.error(`[run ${runId}]`, e);
  } finally {
    active.delete(runId);
  }
}

const app = createApp(store, (id) => void drive(id));
mountDemo(app, store);

// 時計は API が持つ。店には cron も常駐も無いので、決まった間隔で API が自分で点検を始める
const INTERVAL_MS = Number(process.env.SH_AUTO_INTERVAL_HOURS ?? 24) * 3600_000;
async function tick() {
  for (const shop of await store.listShops()) {
    if (shop.status !== "connected") continue;
    const runs = await store.listRuns(shop.shop_id);
    if (runs.some((r) => r.status === "running")) continue;
    // まだ点検していない店は、つないだ時刻から数える(最初の点検は「つないだら始める」か、店の人が始める)
    const last = runs[0]?.created_at ?? shop.created_at;
    // 版上げの提案が古くなった(調べたときからファイルが変わっていた)店は、間隔を待たずに調べ直す
    const recheck = !!shop.recheck_after && Date.now() >= shop.recheck_after;
    if (!recheck && Date.now() - last < INTERVAL_MS) continue;
    if (dailyQuotaExceeded(runs)) continue;
    if (recheck) await store.putShop({ ...shop, recheck_after: undefined });
    const run = newRun(`run_${randomHex(8)}`, shop, null, "schedule", isFirstRun(runs));
    await store.putRun(run);
    void drive(run.run_id);
  }
}
// 起動したら、途中だった点検を続きから回す
for (const r of await store.listRunning()) void drive(r.run_id);
setInterval(() => void tick().catch((e) => console.error("[tick]", e)), 60_000);
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`self-harden api on :${port} (api key: ${process.env.ANTHROPIC_API_KEY ? "present" : "missing"})`);
});
