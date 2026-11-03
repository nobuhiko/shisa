// SPDX-License-Identifier: GPL-2.0-or-later
// Agent の 1 歩。モデルを 1 回呼び、出てきた道具を実行して、結果を保存する。
// 1 歩ずつ保存するので、途中で止まっても次の 1 歩から続けられる(Workers では alarm から呼ぶ)
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, firstUserMessage, advisoryNote } from "./prompt.js";
import { CLIENT_TOOLS, SERVER_TOOLS, runTool } from "./tools.js";
import type { Run, Shop, Step, Store } from "./store.js";
import { usd, runBudget } from "./cost.js";
import { fingerprint } from "./research.js";

// 1 回の点検で使う web_search / web_fetch の合計の上限。超えたら、それ以降は公開の情報を調べる道具を渡さない
const MAX_WEB = Number(process.env.SH_RUN_MAX_WEB ?? 30);

export const MODEL = process.env.SH_MODEL ?? "claude-opus-5-5";
const MAX_TURNS = Number(process.env.SH_MAX_TURNS ?? 80);

const TOOLS = [...CLIENT_TOOLS, ...SERVER_TOOLS];


const TRIGGER_TITLE = { connect: "店とつながったので、最初の点検を始めた", schedule: "決まった時刻になったので、点検を始めた", manual: "店の人の依頼で点検を始めた", advisory: "" };

export function newRun(runId: string, shop: Shop, advisoryUrl: string | null, trigger: Run["trigger"], first = false): Run {
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
    first,
  };
}

function push(run: Run, kind: Step["kind"], title: string, detail?: string, result?: string, tool?: string) {
  run.steps.push({ at: Date.now(), kind, title, tool, result, detail: detail?.slice(0, 4000) });
}

const KANA = /[\u3040-\u30ff]/;
const HAIKU = process.env.SH_TRANSLATE_MODEL ?? "claude-haiku-5-5";

// 店の人に出す一言に、かなが無ければ(英語などになっていたら)日本語にしてから出す
export async function toJapanese(client: Anthropic, text: string, run?: Run): Promise<string> {
  if (!text || KANA.test(text)) return text;
  try {
    const r = await client.messages.create({
      model: HAIKU,
      max_tokens: 1024,
      messages: [{ role: "user", content: `次の文を、ネットショップの店主向けの自然な日本語にしてください。訳文だけを出してください。\n\n${text}` }],
    });
    if (run && r.usage) {
      run.usage.haiku_input = (run.usage.haiku_input ?? 0) + r.usage.input_tokens;
      run.usage.haiku_output = (run.usage.haiku_output ?? 0) + r.usage.output_tokens;
    }
    const out = r.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    return out || text;
  } catch {
    return text;
  }
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
      if (d.error === "would_remove_lines") return `元の行を ${d.removed_lines.length} 行消すことになるので、書かなかった`;
      if (errOf(d)) return errOf(d)!;
      const r = d.result ?? {};
      const v = (r.verify ?? []).map((x: any) => `${x.path} ${x.status}`).join("、");
      const lines = `${d.added_lines?.length ? `${d.added_lines.length} 行足した` : ""}${d.removed_lines?.length ? `、元の行を ${d.removed_lines.length} 行消した` : ""}`;
      return r.rolled_back ? `店が開けなくなったので、同じリクエストの中で戻した(${v})` : `入れた${lines ? `(${lines})` : ""}。店を開いて確かめた(${v})`;
    }
    case "restore":
      return errOf(d) ?? "戻した";
    case "check_packages":
      return d.error ? `失敗: ${d.error}` : `${d.checked_packages} 個の部品のうち ${d.affected_count} 件に公表済みの弱点`;
    case "compare_with_official":
      return d.error ? `失敗: ${d.error}` : `公式 ${d.official.version} と比べた: 違う ${d.modified.count} 件、公式に無い ${d.added.count} 件、無い ${d.missing.count} 件${d.intended?.count ? `、当てた修正 ${d.intended.count} 件` : ""}`;
    case "diff_with_official":
      return d.error ? `失敗: ${d.error}` : d.official === null ? "公式には無いファイル" : `${(d.diff.match(/^[-+][^-+]/gm) ?? []).length} 行の違い`;
    case "restore_official": {
      if (errOf(d)) return errOf(d)!;
      const r = d.result ?? {};
      const v = (r.verify ?? []).map((x: any) => `${x.path} ${x.status}`).join("、");
      return r.rolled_back ? `店が開けなくなったので戻した(${v})` : `公式の中身に戻した。店を開いて確かめた(${v})`;
    }
    case "clear_cache":
      return errOf(d) ?? `キャッシュを消した。店を開いて確かめた(${((d.result?.verify ?? []) as any[]).map((x) => `${x.path} ${x.status}`).join("、")})`;
    case "apply_official_release": {
      if (d.error === "customized_files") return `お店の改造があるファイル(${d.count} 件)を上書きしてしまうので、何も置いていない`;
      if (d.error === "needs_db_change") return "データベースの作り変えが要る版なので、何も置いていない";
      if (errOf(d)) return `${errOf(d)}(何も置いていない)`;
      const r = d.result;
      if (!r) return d.detail ?? "";
      const v = (r.verify ?? []).map((x: any) => `${x.path} ${x.status}`).join("、");
      return r.rolled_back ? `店が開けなくなったので、全部戻した(${v})` : `${r.from} → ${r.ref}: ${r.written} ファイルを公式の配布物どおりに置いた(部品 ${r.by_top?.vendor ?? 0}${r.composer_lock ? "、composer.lock も" : ""})。店を開いて確かめた(${v})`;
    }
    case "apply_official_fix": {
      if (d.error === "customized_files") return `お店の改造があるファイル(${d.customized.length} 件)を上書きしてしまうので、何も置いていない`;
      if (d.error === "incomplete_fix") return `公式の修正のファイルがそろっていないので、何も置いていない(足りない ${d.missing.length} 件)`;
      if (d.error === "needs_db_or_vendor_change") return "DB や部品の変更が要る版なので、何も置いていない";
      if (errOf(d)) return `${errOf(d)}(何も置いていない)`;
      const r = d.result ?? {};
      const v = (r.verify ?? []).map((x: any) => `${x.path} ${x.status}`).join("、");
      return r.rolled_back ? `店が開けなくなったので、全部戻した(${v})` : `${r.applied.length} ファイルをそろえて当てた。店を開いて確かめた(${v})`;
    }
    case "quarantine": {
      if (errOf(d)) return errOf(d)!;
      const r = d.result ?? {};
      return r.released ? "店が開けなくなったので元に戻した" : `隔離した(${r.quarantine_id})`;
    }
    case "release_quarantine":
      return errOf(d) ?? "元の場所に戻した";
    case "list_quarantine":
      return errOf(d) ?? `${d.result?.quarantine?.length ?? 0} 件`;
    case "list_backups":
      return errOf(d) ?? `${d.result?.backups?.length ?? 0} 件`;
    case "wait":
      return `${d.will_wait_seconds} 秒あけてから次へ進む`;
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
  run.usage.usd = usd(run.usage);
  const budget = runBudget(run);
  if (run.usage.usd >= budget && !run.budget_hit) {
    // 上限に達したら、それ以上は調べずに報告を出してもらう
    run.budget_hit = true;
    push(run, "info", `この点検の費用が上限($${budget}${run.first ? "、初回" : ""})に達したので、報告をまとめて終える`);
    const last = run.messages.at(-1) as any;
    const note = { type: "text", text: "この点検の費用の上限に達しました。これ以上調べたり変更したりせず、ここまでの結果で report を呼んで終えてください。" };
    if (last?.role === "user" && Array.isArray(last.content)) last.content.push(note);
    else run.messages.push({ role: "user", content: [note] });
  } else if (run.budget_hit && run.usage.usd >= budget * 1.2) {
    run.status = "failed";
    push(run, "error", "費用の上限を超えたので止めた");
    await store.putRun(run);
    return run;
  }

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
      // 道具の一覧は途中で変えない(web 検索は裏で code_execution を使い、その呼び出しが会話に残るため。キャッシュにも効く)
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
  run.usage.web_searches = (run.usage.web_searches ?? 0) + (msg.usage.server_tool_use?.web_search_requests ?? 0);
  run.usage.web_fetches = (run.usage.web_fetches ?? 0) + (msg.usage.server_tool_use?.web_fetch_requests ?? 0);
  run.usage.usd = usd(run.usage);
  run.messages.push({ role: "assistant", content: msg.content });

  // 経過に出す: 道具を呼ばない発言(最後の言葉など)と、調べものの様子。道具を呼ぶときの一言は note で出す
  const callsTools = msg.content.some((b) => b.type === "tool_use");
  for (const b of msg.content) {
    if (b.type === "text" && b.text.trim() && !callsTools) push(run, "think", await toJapanese(client, short(b.text.trim(), 1000), run));
    if (b.type === "server_tool_use" && (b.name === "web_search" || b.name === "web_fetch")) {
      const q = (b.input as any)?.query ?? (b.input as any)?.url ?? "";
      if (q) push(run, "tool", b.name === "web_search" ? `公開の情報を探す: ${q}` : `公開の情報を読む: ${q}`);
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
    // 「待つ」は次の 1 歩を遅らせるもの。同じ 1 歩の中で「待つ」より後に呼ばれた道具は、待つ前に動いてしまうので実行しない
    if (waitSec > 0) {
      const content = JSON.stringify({ ok: false, error: "not_run_before_wait", detail: `Not run: it was called in the same turn after wait. Call it again in the next turn; the pause of ${waitSec} seconds happens before the next turn.` });
      push(run, "info", "待ったあとで確かめ直すため、この確認はあとに回した", content, undefined, u.name);
      results.push({ type: "tool_result", tool_use_id: u.id, content, is_error: true });
      continue;
    }
    let out;
    try {
      out = await runTool(shop, u.name, u.input, { store, runId: run.run_id });
    } catch (e) {
      out = { content: JSON.stringify({ error: (e as Error).message }), isError: true, title: u.name };
    }
    const note = typeof (u.input as any)?.note === "string" && (u.input as any).note.trim() ? await toJapanese(client, (u.input as any).note.trim(), run) : out.title;
    push(run, out.isError ? "error" : out.decision ? "decision" : "tool", note, short(out.content, 3000), out.decision ? undefined : summarize(u.name, out.content, out.isError), out.title);
    if (out.waitSec) waitSec = Math.max(waitSec, out.waitSec);
    if (out.report) {
      // 次の点検で「前回から変わったか」を見られるように、終わったときの指紋を残す
      try { (run as any).fingerprint = await fingerprint(shop); } catch { /* 無くても報告は出す */ }
      run.report = out.report;
      run.status = "done";
      push(run, "report", "報告を出した");
    }
    results.push({ type: "tool_result", tool_use_id: u.id, content: out.content, is_error: out.isError || undefined });
  }
  const content: Anthropic.Beta.BetaContentBlockParam[] = [...results];
  // 1 回の点検の公開の情報の上限に達したら、一度だけ伝える
  if (!(run as any).web_cap_noted && (run.usage.web_searches ?? 0) + (run.usage.web_fetches ?? 0) >= MAX_WEB) {
    (run as any).web_cap_noted = true;
    content.push({ type: "text", text: "この点検で公開の情報を調べる回数の上限に達しました。これ以上 web_search / web_fetch は使わず、ここまでの情報と保存した調べた結果で進めてください。" });
  }
  for (const url of await store.takeInbox(run.run_id)) {
    content.push({ type: "text", text: advisoryNote(url) });
    push(run, "info", `通知の URL を受け取った: ${url}`);
  }
  run.messages.push({ role: "user", content });
  if (waitSec) run.wake_at = Date.now() + waitSec * 1000;
  await store.putRun(run);
  return run;
}
