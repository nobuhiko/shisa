import { describe, it, expect } from "vitest";
import { usd, dailyQuotaExceeded, LIMITS } from "../src/cost.js";

const run = (ago: number, u: Partial<{ input: number; output: number; cache_read: number; cache_write: number }> = {}) =>
  ({ created_at: Date.now() - ago, usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, ...u } }) as any;

describe("費用と上限", () => {
  it("トークンからドルを出す", () => {
    expect(usd({ input: 1_000_000, output: 1_000_000, cache_read: 1_000_000, cache_write: 1_000_000, web_searches: 10 })).toBeCloseTo(4 + 20 + 0.2 + 5 + 0.1, 5);
  });
  it("店ごとの 1 日の回数を超えたら始めない", () => {
    expect(dailyQuotaExceeded(Array.from({ length: LIMITS.shop_daily_runs }, () => run(3600_000)))).toMatch(/回/);
    expect(dailyQuotaExceeded(Array.from({ length: LIMITS.shop_daily_runs }, () => run(25 * 3600_000)))).toBeNull();
  });
  it("店ごとの 1 日の費用を超えたら始めない", () => {
    expect(dailyQuotaExceeded([run(60_000, { output: 1_000_000 })])).toMatch(/費用/);
  });
});

describe("初回の上限", () => {
  it("終わった点検が無ければ初回で、上限が高い", async () => {
    const { isFirstRun, runBudget, LIMITS } = await import("../src/cost.js");
    expect(isFirstRun([])).toBe(true);
    expect(isFirstRun([{ status: "failed" }])).toBe(true);
    expect(isFirstRun([{ status: "done" }])).toBe(false);
    expect(runBudget({ first: true })).toBe(LIMITS.first_run_usd);
    expect(runBudget({ first: false })).toBe(LIMITS.run_usd);
  });
});
