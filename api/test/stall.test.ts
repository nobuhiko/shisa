import { describe, it, expect } from "vitest";
import { isUpgradeStalled, UPGRADE_STALL_MS } from "../src/tools.js";

const now = 1_800_000_000_000;
const up = (o: any) => ({ kind: "upgrade" as const, status: "running" as const, decided_at: now - 5_000, upgrade: null, ...o });

describe("版上げが止まっているか(管理画面の赤い表示)", () => {
  it("最初の呼び出しが時間切れで窓口の記録がまだ無くても、承認したばかりなら止まっていない", () => {
    expect(isUpgradeStalled(up({ upgrade: { error: "timeout", detail: "x" } }), now)).toBe(false);
    expect(isUpgradeStalled(up({ upgrade: null }), now)).toBe(false);
  });
  it("窓口の記録が新しければ止まっていない", () => {
    expect(isUpgradeStalled(up({ upgrade: { step: "files", updated_at: (now - 60_000) / 1000 } }), now)).toBe(false);
  });
  it("窓口の記録が 10 分以上動いていなければ止まっている", () => {
    expect(isUpgradeStalled(up({ upgrade: { step: "files", updated_at: (now - UPGRADE_STALL_MS - 1000) / 1000 } }), now)).toBe(true);
  });
  it("記録が無いまま承認から 10 分以上たてば止まっている", () => {
    expect(isUpgradeStalled(up({ decided_at: now - UPGRADE_STALL_MS - 1000, upgrade: { error: "timeout" } }), now)).toBe(true);
  });
  it("窓口に届かない・stuck は止まっている", () => {
    expect(isUpgradeStalled(up({ upgrade: { status: "unreachable", updated_at: now / 1000 } }), now)).toBe(true);
    expect(isUpgradeStalled(up({ status: "stuck" }), now)).toBe(true);
  });
  it("終わった・戻した・カスタマイズの直しは出さない", () => {
    expect(isUpgradeStalled(up({ status: "applied" }), now)).toBe(false);
    expect(isUpgradeStalled(up({ status: "rolled_back" }), now)).toBe(false);
    expect(isUpgradeStalled({ kind: "fix", status: "running", upgrade: null, decided_at: 0 } as any, now)).toBe(false);
  });
});
