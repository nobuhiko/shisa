import { describe, it, expect } from "vitest";
import { applyApproved } from "../src/tools.js";
import type { Proposal, Shop, Store } from "../src/store.js";

// 承認の印が提案と合わなければ、窓口を呼ばずに断る(窓口でも印を確かめるが、API でも取り次がない)
const shop: Shop = { shop_id: "shp_aaaaaaaaaaaaaaaa", secret: "0".repeat(64), receiver_url: "http://127.0.0.1:9/self-harden.php", shop_url: "http://127.0.0.1:9", platform: "", status: "connected", created_at: 0 };
const p: Proposal = {
  proposal_id: "prp_0123456789abcdef", shop_id: shop.shop_id, run_id: "run_x", path: "app/Customize/Controller/A.php", title: "", owner_text: "", developer_text: "",
  sha256_before: "b".repeat(64), sha256_new: "c".repeat(64), new_content: "<?php\n", diff: "", verify_paths: ["/"], status: "pending", created_at: 0,
};
const saved: Proposal[] = [];
const store = { putProposal: async (x: Proposal) => { saved.push(x); }, getRun: async () => null } as unknown as Store;
const good = { proposal_id: p.proposal_id, path: p.path, sha256_new: p.sha256_new, sha256_before: p.sha256_before, shop_id: shop.shop_id, expires_at: 1, sig: "d".repeat(64) };

describe("店主の承認で直す(API の取り次ぎ)", () => {
  for (const [name, over] of [
    ["印が無い", null],
    ["別の提案の印", { proposal_id: "prp_ffffffffffffffff" }],
    ["別のファイルの印", { path: "app/Customize/Controller/B.php" }],
    ["別の中身の印", { sha256_new: "e".repeat(64) }],
    ["前の中身が違う印", { sha256_before: "e".repeat(64) }],
    ["別のお店の印", { shop_id: "shp_bbbbbbbbbbbbbbbb" }],
  ] as const) {
    it(`${name}は窓口に取り次がない`, async () => {
      const r = await applyApproved(shop, store, p, over === null ? null : { ...good, ...over });
      expect(r.ok).toBe(false);
      expect((r as any).error).toBe("approval_mismatch");
      expect(saved).toHaveLength(0);
    });
  }
});
