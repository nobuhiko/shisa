import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { FileStore, type Shop } from "../src/store.js";
import { newRun, step } from "../src/agent.js";

const shop: Shop = { shop_id: "shp_test0001", secret: "0".repeat(64), receiver_url: "http://invalid/self-harden.php", shop_url: "http://invalid", platform: "", status: "connected", created_at: 0 };

describe("待つ", () => {
  it("同じ 1 歩の中で待つより後に呼ばれた道具は実行せず、次の 1 歩を待たせる", async () => {
    const store = new FileStore(mkdtempSync(join(process.cwd(), "data", "t-")));
    const run = newRun("run_wait0001", shop, null, "manual");
    const client = {
      beta: { messages: { create: async () => ({
        content: [
          { type: "tool_use", id: "tu_1", name: "wait", input: { note: "待ちます", seconds: 300 } },
          { type: "tool_use", id: "tu_2", name: "probe_lab", input: { note: "確かめます" } },
        ],
        stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 },
      }) } },
      messages: { create: async () => ({ content: [] }) },
    } as any;
    const t0 = Date.now();
    const after = await step(client, store, run, shop);
    const results = (after.messages.at(-1) as any).content;
    expect(results[1].is_error).toBe(true);
    expect(results[1].content).toContain("not_run_before_wait");
    expect(after.wake_at).toBeGreaterThanOrEqual(t0 + 300_000);
  });
});
