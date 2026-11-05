import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import type { AppliedFix, Proposal, Shop, Store } from "../src/store.js";

// 窓口の返事を差し替える(本物の窓口は呼ばない)
const reply: { value: any } = { value: null };
const sent: any[] = [];
vi.mock("../src/receiver.js", () => ({ callReceiver: async (_s: unknown, op: string, args: unknown) => { sent.push({ op, args }); return reply.value; } }));

const { semverCmp, keepList, keepString, fingerprint, upgradeNewHash, lockPackages } = await import("../src/upgradeplan.js");
const { applyUpgrade, recordUpgrade } = await import("../src/tools.js");

const fx = (pkg: string, ref: string, at: number, extra: Partial<AppliedFix> = {}): AppliedFix => ({
  path: `vendor/${pkg}/src/A.php`, sha256: "x", ref, source: "", reason: "", run_id: "r", at, from_version: "4.2.0", via: "fix", package_complete: true, ...extra,
});

describe("残す部品(新しいほうを残す)", () => {
  it("版の比べ", () => {
    expect(semverCmp("v5.4.56", "v5.4.48")).toBe(1);
    expect(semverCmp("5.4.48", "v5.4.48")).toBe(0);
    expect(semverCmp("v5.4.9", "v5.4.10")).toBe(-1);
    expect(semverCmp("dev-main", "v1.0.0")).toBeNull();
  });
  it("当てた版のほうが新しい部品だけ残す。配布物が新しいか同じなら置き換える", () => {
    const applied = [fx("symfony/http-foundation", "v5.4.56", 2), fx("symfony/routing", "v5.4.40", 2), fx("twig/twig", "v2.16.1", 2)];
    const release = [{ name: "symfony/http-foundation", version: "v5.4.48" }, { name: "symfony/routing", version: "v5.4.45" }, { name: "twig/twig", version: "v2.16.1" }];
    expect(keepList(applied, release)).toEqual([{ name: "symfony/http-foundation", version: "v5.4.56", release_version: "v5.4.48" }]);
  });
  it("同じ部品に記録が何度もあれば、一番新しい記録の版で比べる", () => {
    const applied = [fx("symfony/mime", "v5.4.50", 1), fx("symfony/mime", "v5.4.45", 3)];
    expect(keepList(applied, [{ name: "symfony/mime", version: "v5.4.48" }])).toEqual([]);
  });
  it("全部そろえて当てていない記録や、手で当て済みの記録は数えない", () => {
    const applied = [fx("a/b", "v2.0.0", 1, { package_complete: false }), fx("c/d", "v2.0.0", 1, { via: "manual" })];
    expect(keepList(applied, [{ name: "a/b", version: "v1.0.0" }, { name: "c/d", version: "v1.0.0" }])).toEqual([]);
  });
  it("印に入れる形は名前の順(プラグイン・窓口と同じ)", () => {
    expect(keepString([{ name: "twig/twig", version: "v2.16.1", release_version: "" }, { name: "symfony/a", version: "v1.0.0", release_version: "" }])).toBe("symfony/a@v1.0.0,twig/twig@v2.16.1");
    expect(keepString([])).toBe("");
  });
  it("composer.lock の部品を読む", () => {
    expect(lockPackages(JSON.stringify({ packages: [{ name: "a/b", version: "v1.0.0" }], "packages-dev": [{ name: "c/d", version: "2.0.0" }] }))).toEqual([{ name: "a/b", version: "v1.0.0" }, { name: "c/d", version: "2.0.0" }]);
  });
});

describe("調べたときの指紋", () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const mine = { "src/Eccube/Kernel.php": sha("<?php\nclass Kernel {}\n"), "vendor/acme/pkg/A.php": sha("<?php // a\n"), "html/index.php": sha("x") };
  it("窓口(receiver_upgrade_test.php)と同じ値になる", () => {
    expect(fingerprint(mine, ["src/Eccube/Kernel.php"])).toBe("55210693e24fb4ef3a96a6b396c11aea8cfb33417ffb49aa1fb810d322c375e2");
  });
  it("渡していない本体のファイルは入らず、無いファイルは '-' で入る", () => {
    expect(fingerprint(mine, [])).toBe("81f91151d38ff439c33005f35b25a44d5df93f535f3615662ba9a2a5bb14f943");
    expect(fingerprint(mine, ["src/Missing.php"])).not.toBe(fingerprint(mine, []));
  });
  it("部品のファイルが変われば指紋も変わる", () => {
    expect(fingerprint({ ...mine, "vendor/acme/pkg/A.php": sha("changed") }, ["src/Eccube/Kernel.php"])).not.toBe(fingerprint(mine, ["src/Eccube/Kernel.php"]));
  });
  it("新しい中身のハッシュは、上げ先の版・指紋・残す部品に結びつく", () => {
    expect(upgradeNewHash("4.2.3-p2", "f".repeat(64), "")).not.toBe(upgradeNewHash("4.2.3-p2", "f".repeat(64), "a/b@v1.0.0"));
  });
});

const shop: Shop = { shop_id: "shp_aaaaaaaaaaaaaaaa", secret: "1".repeat(64), receiver_url: "http://127.0.0.1:9/self-harden.php", shop_url: "http://127.0.0.1:9", platform: "", status: "connected", created_at: 0 };
const keep = [{ name: "symfony/http-foundation", version: "v5.4.56", release_version: "v5.4.48" }];
const p: Proposal = {
  proposal_id: "prp_0123456789abcdef", shop_id: shop.shop_id, run_id: "run_x", path: "", title: "", owner_text: "", developer_text: "", sha256_before: "b".repeat(64),
  sha256_new: "c".repeat(64), new_content: "", diff: "", verify_paths: [], status: "pending", created_at: 0, kind: "upgrade", from_version: "4.2.0", to_version: "4.2.3-p2",
  fingerprint: "e".repeat(64), fp_paths: ["src/Eccube/Kernel.php"], keep,
};
const good = { proposal_id: p.proposal_id, from: "4.2.0", to: "4.2.3-p2", shop_id: shop.shop_id, expires_at: 1, sig: "d".repeat(64), fp: "e".repeat(64), keep: "symfony/http-foundation@v5.4.56" };

describe("承認のあと、調べたときから変わっていたら止まる", () => {
  let saved: Proposal[] = [];
  let shops: Shop[] = [];
  let added: AppliedFix[] = [];
  const store = {
    putProposal: async (x: Proposal) => { saved.push(x); }, getRun: async () => null,
    getShop: async () => shop, putShop: async (s: Shop) => { shops.push(s); },
    getApplied: async () => [fx("symfony/http-foundation", "v5.4.56", 5), fx("symfony/routing", "v5.4.40", 5)],
    addApplied: async (_id: string, f: AppliedFix[]) => { added.push(...f); },
  } as unknown as Store;
  beforeEach(() => { saved = []; shops = []; added = []; sent.length = 0; });

  it("指紋か残す部品が提案と合わない印は、窓口に渡さない", async () => {
    for (const over of [{ fp: "0".repeat(64) }, { keep: "" }]) {
      const r = await applyUpgrade(shop, store, p, { ...good, ...over });
      expect(r.ok).toBe(false);
      expect((r as any).error).toBe("approval_mismatch");
    }
    expect(sent).toHaveLength(0);
  });
  it("窓口に、指紋の場所の一覧を渡す", async () => {
    reply.value = { ok: false, error: "not_approved", detail: "" };
    await applyUpgrade(shop, store, p, good);
    expect(sent[0].args.fp_paths).toEqual(["src/Eccube/Kernel.php"]);
  });
  it("窓口が stale と返したら、提案を「古くなった」にして、すぐ点検し直す予約をする(何も書いていない)", async () => {
    reply.value = { ok: false, error: "stale", detail: "調べたときから、お店のファイルが変わっています" };
    const r = await applyUpgrade(shop, store, p, good);
    expect(r.ok).toBe(false);
    expect((r as any).status).toBe("stale");
    expect(saved.at(-1)?.status).toBe("stale");
    expect(shops.at(-1)?.recheck_after).toBeGreaterThan(Date.now());
  });
  it("一致して上げたら、配布物ごと上げた印と、残した部品の修正を記録し直す(上げ先の版を基準に数える)", async () => {
    await recordUpgrade(shop, store, p);
    const marker = added.find((a) => a.via === "release");
    expect(marker?.ref).toBe("4.2.3-p2");
    const kept = added.filter((a) => a.via === "fix");
    expect(kept.map((a) => a.ref)).toEqual(["v5.4.56"]);
    expect(kept[0].from_version).toBe("4.2.3-p2");
    expect(kept[0].at).toBeGreaterThan(marker!.at);
  });
});
