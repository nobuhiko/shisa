// SPDX-License-Identifier: GPL-2.0-or-later
// 手元(Node)で動かす入口。点検は 1 歩ずつ保存しながら、API の側で回す(店には時計が無い)
import { serve } from "@hono/node-server";
import Anthropic from "@anthropic-ai/sdk";
import { createApp } from "./app.js";
import { FileStore } from "./store.js";
import { step } from "./agent.js";

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
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`self-harden api on :${port} (api key: ${process.env.ANTHROPIC_API_KEY ? "present" : "missing"})`);
});
