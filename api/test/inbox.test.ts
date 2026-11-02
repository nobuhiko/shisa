import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { FileStore, type Shop } from "../src/store.js";
import { newRun, step } from "../src/agent.js";

const shop: Shop = { shop_id: "shp_test0001", secret: "0".repeat(64), receiver_url: "http://invalid/self-harden.php", shop_url: "http://invalid", platform: "", status: "connected", created_at: 0 };

// Claude の代わり: 毎回 wait を 1 回呼ぶ。呼ばれている途中で店の人が通知を貼る
function fakeClient(store: FileStore, runId: string) {
  let n = 0;
  return {
    beta: { messages: { create: async () => {
      if (n++ === 0) await store.addInbox(runId, "https://example.com/advisory-1");
      return { content: [{ type: "tool_use", id: `tu_${n}`, name: "wait", input: { note: "少し待ちます", seconds: 1 } }], stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
    } } },
    messages: { create: async () => ({ content: [{ type: "text", text: "訳" }] }) },
  } as any;
}

describe("点検の途中で貼られた通知", () => {
  it("1 歩の途中で貼られても消えずに、次のメッセージで渡る", async () => {
    const store = new FileStore(mkdtempSync(join(process.cwd(), "data", "t-")));
    const run = newRun("run_inbox0001", shop, null, "manual");
    await store.putRun(run);
    const client = fakeClient(store, run.run_id);
    const after = await step(client, store, run, shop);
    const last = after.messages.at(-1) as any;
    expect(JSON.stringify(last.content)).toContain("https://example.com/advisory-1");
    expect(after.steps.some((s) => s.kind === "info" && s.title.includes("advisory-1"))).toBe(true);
    expect(await store.takeInbox(run.run_id)).toEqual([]);
  });
});
