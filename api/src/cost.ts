// SPDX-License-Identifier: GPL-2.0-or-later
// 点検ごとの費用と、鍵が漏れても呼び放題にさせない上限
import type { Run } from "./store.js";

// ドル / 100 万トークン。値は環境変数で変えられる(既定は claude-opus-5-5 と claude-haiku-5-5 の公開価格)
const num = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);
export const PRICE = {
  input: num("SH_PRICE_INPUT", 4),
  output: num("SH_PRICE_OUTPUT", 20),
  cache_read: num("SH_PRICE_CACHE_READ", 0.2),
  cache_write: num("SH_PRICE_CACHE_WRITE", 5), // 5 分のキャッシュの書き込みは入力の 1.25 倍
  web_search: num("SH_PRICE_WEB_SEARCH", 0.01), // 1 回あたり
  haiku_input: num("SH_PRICE_HAIKU_INPUT", 0.1),
  haiku_output: num("SH_PRICE_HAIKU_OUTPUT", 0.5),
};

export const LIMITS = {
  run_usd: num("SH_RUN_BUDGET_USD", 6), // 1 回の点検の上限。超えたら報告を出して終える
  first_run_usd: num("SH_FIRST_RUN_BUDGET_USD", 12), // 初回の点検の上限。初回は全部を診るので高くする。2 回目からは前回との違いだけ
  shop_daily_usd: num("SH_SHOP_DAILY_USD", 15), // 店ごとの 1 日の上限
  shop_daily_runs: num("SH_SHOP_DAILY_RUNS", 6), // 店ごとの 1 日の点検の回数
};

export type Usage = Run["usage"];

export function usd(u: Usage): number {
  const m = 1_000_000;
  return (
    (u.input * PRICE.input + u.output * PRICE.output + u.cache_read * PRICE.cache_read + (u.cache_write ?? 0) * PRICE.cache_write) / m +
    (u.web_searches ?? 0) * PRICE.web_search +
    ((u.haiku_input ?? 0) * PRICE.haiku_input + (u.haiku_output ?? 0) * PRICE.haiku_output) / m
  );
}

// 店ごとの 1 日の枠が残っているか。残っていなければ理由を返す
export function dailyQuotaExceeded(runs: Run[], now = Date.now()): string | null {
  const today = runs.filter((r) => now - r.created_at < 24 * 3600_000);
  if (today.length >= LIMITS.shop_daily_runs) return `この 24 時間の点検が上限(${LIMITS.shop_daily_runs} 回)に達しました`;
  const spent = today.reduce((a, r) => a + usd(r.usage), 0);
  // 初回の点検があった日は、その分だけ 1 日の上限を広げる(初回のあとに 1 回は通常の点検ができるように)
  const cap = LIMITS.shop_daily_usd + (today.some((r) => r.first) ? Math.max(0, LIMITS.first_run_usd - LIMITS.run_usd) : 0);
  if (spent >= cap) return `この 24 時間の費用が上限($${cap})に達しました`;
  return null;
}

// この点検の費用の上限。初回(その店で終わった点検がまだ無い)は高い
export function runBudget(run: Pick<Run, "first">): number {
  return run.first ? LIMITS.first_run_usd : LIMITS.run_usd;
}

// その店で、終わった点検がまだ 1 つも無ければ初回
export function isFirstRun(runs: Pick<Run, "status">[]): boolean {
  return !runs.some((r) => r.status === "done");
}
