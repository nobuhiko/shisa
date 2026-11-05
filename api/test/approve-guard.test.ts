import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Proposal, Shop, Store } from "../src/store.js";

// 窓口の返事を差し替える(本物の窓口は呼ばない)
const reply: { value: any } = { value: null };
vi.mock("../src/receiver.js", () => ({ callReceiver: async () => reply.value }));

const { applyApproved, changedSpan, PROPOSAL_MAX_LINES } = await import("../src/tools.js");
const { createApp } = await import("../src/app.js");
const { signRequest, apiResponseSignature } = await import("../src/sign.js");

const shop: Shop = { shop_id: "shp_aaaaaaaaaaaaaaaa", secret: "1".repeat(64), receiver_url: "http://127.0.0.1:9/self-harden.php", shop_url: "http://127.0.0.1:9", platform: "", status: "connected", created_at: 0 };
const p: Proposal = {
  proposal_id: "prp_0123456789abcdef", shop_id: shop.shop_id, run_id: "run_x", path: "app/Customize/Controller/A.php", title: "", owner_text: "", developer_text: "",
  sha256_before: "b".repeat(64), sha256_new: "c".repeat(64), new_content: "<?php\n", diff: "", verify_paths: ["/"], status: "pending", created_at: 0,
};
const good = { proposal_id: p.proposal_id, path: p.path, sha256_new: p.sha256_new, sha256_before: p.sha256_before, shop_id: shop.shop_id, expires_at: 1, sig: "d".repeat(64) };
let saved: Proposal[] = [];
const store = { putProposal: async (x: Proposal) => { saved.push(x); }, getRun: async () => null } as unknown as Store;

describe("偽の承認で、正しい提案を潰せない", () => {
  beforeEach(() => { saved = []; });
  for (const code of ["not_approved", "approval_expired", "approval_used", "conflict"]) {
    it(`窓口が ${code} と断ったら、提案の状態を変えない`, async () => {
      reply.value = { ok: false, error: code, detail: "" };
      const r = await applyApproved(shop, store, p, good);
      expect(r.ok).toBe(false);
      expect((r as any).status).toBe("pending");
      expect(saved).toHaveLength(0);
    });
  }
  it("実際に書いたときだけ applied にする", async () => {
    reply.value = { ok: true, result: { rolled_back: false, verify: [] } };
    const r = await applyApproved(shop, store, p, good);
    expect((r as any).status).toBe("applied");
    expect(saved[0].status).toBe("applied");
  });
  it("書いて戻したときは rolled_back", async () => {
    reply.value = { ok: true, result: { rolled_back: true, verify: [] } };
    const r = await applyApproved(shop, store, p, good);
    expect((r as any).status).toBe("rolled_back");
  });
});

describe("承認の直しは小さく", () => {
  it("変わる範囲の行数", () => {
    expect(changedSpan("a\nb\nc", "a\nX\nc")).toBe(1);
    expect(changedSpan("a\nc", "a\nb1\nb2\nc")).toBe(2);
    expect(changedSpan("x", "x")).toBe(0);
    expect(PROPOSAL_MAX_LINES).toBe(200);
  });
});

describe("承認にかかわる API の返事には署名が付く", () => {
  it("提案の一覧の返事に、呼び出しの nonce に結びついた署名が付く", async () => {
    const mem = {
      getShop: async (id: string) => (id === shop.shop_id ? shop : null),
      useNonce: async () => true,
      listProposals: async () => [p],
    } as unknown as Store;
    const app = createApp(mem, () => {});
    const path = `/v1/shops/${shop.shop_id}/proposals`;
    const h = await signRequest(shop.secret, "GET", path, shop.shop_id, "");
    const res = await app.request(path, { headers: h });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("x-sh-api-signature")).toBe(await apiResponseSignature(shop.secret, h["X-SH-Nonce"], body));
    // 本文を 1 文字でも変えれば合わない
    expect(res.headers.get("x-sh-api-signature")).not.toBe(await apiResponseSignature(shop.secret, h["X-SH-Nonce"], body + " "));
  });
});
