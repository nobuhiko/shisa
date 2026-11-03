// 回帰の点検の結果を表にする: node regress-report.mjs <runs dir> server-x:run_id ...
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const [dir, ...pairs] = process.argv.slice(2);
const find = (id) => { for (const f of readdirSync(dir)) if (f.includes(id)) return join(dir, f); return null; };
const load = (id) => { const f = find(id); return f ? JSON.parse(readFileSync(f, "utf8")) : null; };
for (;;) {
  const rs = pairs.map((p) => load(p.split(":")[1]));
  if (rs.every((r) => r && r.status !== "running")) break;
  await new Promise((r) => setTimeout(r, 10000));
}
const row = (name, r) => {
  const st = r.steps;
  const ver = (st.map((s) => /公式 (4\.[0-9.]+(?:-p\d+)?) と比べた/.exec(s.result ?? "")).filter(Boolean)[0] ?? [])[1] ?? "?";
  const up = st.filter((s) => /公式のリリースに上げる|公式の修正を当てる/.test(s.tool ?? "") && /置いた|当てた/.test(s.result ?? "")).map((s) => s.tool.replace(/^.*@ |^公式のリリースに上げる: /, "")).join(",") || "-";
  const php = st.some((s) => /本番に入れる: root\/\.(user\.ini|htaccess)/.test(s.tool ?? "") && /入れた/.test(s.result ?? "")) ? "✓" : "-";
  const restored = st.filter((s) => /公式の中身に戻す|隔離する/.test(s.tool ?? "") && /戻した|隔離した/.test(s.result ?? "")).length;
  const pk = (st.filter((s) => /部品の弱点/.test(s.tool ?? "")).map((s) => /(\d+) 件に公表済み/.exec(s.result ?? "")).filter(Boolean).map((m) => m[1]));
  const after = st.filter((s) => /照らし合わせる/.test(s.tool ?? "")).at(-1)?.result ?? "";
  const mins = Math.round((st.at(-1).at - st[0].at) / 60000);
  const fixed = (r.report?.findings ?? []).filter((f) => f.status === "fixed" || f.status === "mitigated").length;
  return [name, ver, up, php, restored, pk.length ? `${pk[0]}→${pk.at(-1)}` : "-", fixed, `$${(r.usage.usd ?? 0).toFixed(2)}`, `${mins}分`, r.status, after.replace(/^公式 /, "").slice(0, 60)];
};
const head = ["店", "最初の版", "上げた版", "PHP応急", "戻した", "部品の弱点(前→後)", "守った", "費用", "時間", "状態", "最後の照らし合わせ"];
console.log("| " + head.join(" | ") + " |\n|" + head.map(() => "---").join("|") + "|");
for (const p of pairs) { const [n, id] = p.split(":"); console.log("| " + row(n, load(id)).join(" | ") + " |"); }
