// SPDX-License-Identifier: GPL-2.0-or-later
// Agent の 1 歩。モデルを 1 回呼び、出てきた道具を実行して、結果を保存する。
// 1 歩ずつ保存するので、途中で止まっても次の 1 歩から続けられる(Workers では alarm から呼ぶ)
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, firstUserMessage } from "./prompt.js";
import { CLIENT_TOOLS, SERVER_TOOLS, runTool } from "./tools.js";
import type { Run, Shop, Step, Store } from "./store.js";

export const MODEL = process.env.SH_MODEL ?? "claude-opus-5-5";
const MAX_TURNS = Number(process.env.SH_MAX_TURNS ?? 80);

const TOOLS = [...CLIENT_TOOLS, ...SERVER_TOOLS];

const TRIGGER_TITLE = { connect: "店とつながったので、最初の点検を始めた", schedule: "決まった時刻になったので、点検を始めた", manual: "店の人の依頼で点検を始めた", advisory: "" };

export function newRun(runId: string, shop: Shop, advisoryUrl: string | null, trigger: Run["trigger"]): Run {
  const now = Date.now();
  return {
    run_id: runId,
    shop_id: shop.shop_id,
    status: "running",
    trigger: advisoryUrl ? "advisory" : trigger,
    advisory_url: advisoryUrl,
    created_at: now,
    updated_at: now,
    wake_at: 0,
    turns: 0,
    messages: [{ role: "user", content: firstUserMessage(advisoryUrl, shop.shop_url) }],
    steps: [{ at: now, kind: "info", title: advisoryUrl ? `通知の URL を受け取った: ${advisoryUrl}` : TRIGGER_TITLE[trigger] }],
    usage: { input: 0, output: 0, cache_read: 0 },
  };
}

function push(run: Run, kind: Step["kind"], title: string, detail?: string, result?: string) {
  run.steps.push({ at: Date.now(), kind, title, result, detail: detail?.slice(0, 4000) });
}

function short(s: string, n = 600) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// 道具の結果を店の人が読める 1 行にする
export function summarize(name: string, content: string, isError?: boolean): string {
  let d: any;
  try { d = JSON.parse(content); } catch { return isError ? "失敗" : ""; }
  const errOf = (x: any) => (x && x.ok === false ? `失敗: ${x.detail ?? x.error}` : null);
  const iniPick = (ini: Record<string, unknown> | undefined) => {
    if (!ini) return "";
    const ks = Object.keys(ini);
    return ks.length <= 6 ? ks.map((k) => `${k}=${ini[k] === "" ? "(空)" : ini[k]}`).join("、") : `${ks.length} 個の設定`;
  };
  switch (name) {
    case "inspect": {
      if (errOf(d)) return errOf(d)!;
      const r = d.result ?? {};
      const parts = [];
      if (r.php) parts.push(`PHP ${r.php.version}(${r.php.sapi})`);
      if (r.app?.eccube_version) parts.push(`EC-CUBE ${r.app.eccube_version}`);
      if (r.app?.packages) parts.push(`部品 ${r.app.packages.length} 個`);
      if (r.ini) parts.push(`設定 ${Object.keys(r.ini).length} 個`);
      if (r.extensions) parts.push(`拡張 ${Object.keys(r.extensions).length} 個`);
      return parts.join("、") || "読めた";
    }
    case "list_dir":
      return errOf(d) ?? `${d.result?.entries?.length ?? 0} 件`;
    case "read_file":
      return errOf(d) ?? (d.result?.exists === false ? "ファイルは無い" : `${d.result?.size ?? 0} バイト`);
    case "http_get":
      return d.error ? `失敗: ${d.error}` : `HTTP ${d.status}${d.status >= 200 && d.status < 300 ? "(見える)" : d.status === 403 || d.status === 404 ? "(見えない)" : ""}`;
    case "lab_test":
    case "probe_lab": {
      if (d.write && d.write.ok === false) return `書けなかった: ${d.write.detail ?? d.write.error}`;
      const p = d.probe ?? d;
      if (p.error) return errOf(p.error) ?? "失敗";
      return `小部屋: HTTP ${p.status}${p.status >= 500 ? "(壊れる)" : ""}${p.ini ? "、" + iniPick(p.ini) : ""}`;
    }
    case "write_file": {
      if (errOf(d)) return errOf(d)!;
      const r = d.result ?? {};
      const v = (r.verify ?? []).map((x: any) => `${x.path} ${x.status}`).join("、");
      return r.rolled_back ? `店が開けなくなったので、同じリクエストの中で戻した(${v})` : `入れた。店を開いて確かめた(${v})`;
    }
    case "restore":
      return errOf(d) ?? "戻した";
    case "list_backups":
      return errOf(d) ?? `${d.result?.backups?.length ?? 0} 件`;
    case "wait":
      return `${d.waited_seconds} 秒待った`;
    case "report":
      return "";
    default:
      return isError ? "失敗" : "";
  }
}

export async function step(client: Anthropic, store: Store, run: Run, shop: Shop): Promise<Run> {
  if (run.status !== "running") return run;
  if (run.turns >= MAX_TURNS) {
    run.status = "failed";
    push(run, "error", `${MAX_TURNS} 回やり取りしても終わらなかったので止めた`);
    await store.putRun(run);
    return run;
  }
  run.turns++;

  let msg: Anthropic.Beta.BetaMessage;
  try {
    msg = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      cache_control: { type: "ephemeral" },
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: run.messages as Anthropic.Beta.BetaMessageParam[],
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError) {
      // 一時的なもの。少し待って同じ 1 歩をやり直す
      run.turns--;
      run.wake_at = Date.now() + 20_000;
      push(run, "info", "Claude が混んでいるので 20 秒待つ");
      await store.putRun(run);
      return run;
    }
    run.status = "failed";
    push(run, "error", "Claude の呼び出しに失敗した", e instanceof Anthropic.APIError ? `${e.status} ${e.message}` : String(e));
    await store.putRun(run);
    return run;
  }

  run.usage.input += msg.usage.input_tokens;
  run.usage.output += msg.usage.output_tokens;
  run.usage.cache_read += msg.usage.cache_read_input_tokens ?? 0;
  run.usage.cache_write = (run.usage.cache_write ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0);
  run.messages.push({ role: "assistant", content: msg.content });

  // 経過に出す: Agent の一言、調べものの様子
  for (const b of msg.content) {
    if (b.type === "text" && b.text.trim()) push(run, "think", short(b.text.trim(), 1000));
    if (b.type === "server_tool_use") {
      const q = (b.input as any)?.query ?? (b.input as any)?.url ?? "";
      push(run, "tool", b.name === "web_search" ? `公開の情報を探す: ${q}` : `公開の情報を読む: ${q}`);
    }
  }

  if (msg.stop_reason === "refusal") {
    run.status = "failed";
    push(run, "error", "Claude がこの続きを断った");
    await store.putRun(run);
    return run;
  }
  if (msg.stop_reason === "pause_turn") {
    await store.putRun(run);
    return run;
  }

  const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
  if (uses.length === 0) {
    if (msg.stop_reason === "max_tokens") {
      run.messages.push({ role: "user", content: "続けてください。" });
      await store.putRun(run);
      return run;
    }
    // 報告を出さずに終わろうとした
    run.messages.push({ role: "user", content: "まだ report を呼んでいません。終わるなら report で報告を出してください。" });
    await store.putRun(run);
    return run;
  }
  if (msg.stop_reason === "max_tokens") {
    run.messages.push({
      role: "user",
      content: uses.map((u) => ({ type: "tool_result" as const, tool_use_id: u.id, is_error: true, content: "tool input was truncated; please retry" })),
    });
    await store.putRun(run);
    return run;
  }

  const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
  let waitSec = 0;
  for (const u of uses) {
    let out;
    try {
      out = await runTool(shop, u.name, u.input);
    } catch (e) {
      out = { content: JSON.stringify({ error: (e as Error).message }), isError: true, title: u.name };
    }
    push(run, out.isError ? "error" : "tool", out.title, short(out.content, 3000), summarize(u.name, out.content, out.isError));
    if (out.waitSec) waitSec = Math.max(waitSec, out.waitSec);
    if (out.report) {
      run.report = out.report;
      run.status = "done";
      push(run, "report", "報告を出した");
    }
    results.push({ type: "tool_result", tool_use_id: u.id, content: out.content, is_error: out.isError || undefined });
  }
  run.messages.push({ role: "user", content: results });
  if (waitSec) run.wake_at = Date.now() + waitSec * 1000;
  await store.putRun(run);
  return run;
}
