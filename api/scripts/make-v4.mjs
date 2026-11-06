// SPDX-License-Identifier: GPL-2.0-or-later
// 動画 v4 を組み立てる(手元だけ): 起 + 導入 + 承・転(経過を流しっぱなし、その上で話す。買い物の画面を小さく重ねる)+ 健康診断 + 承認 + 結
// 使い方: RUN=<記録> ADV=<お知らせの URL> PW=<playwright> node api/scripts/make-v4.mjs <作業ディレクトリ(video/)>
//   SHOPPING=<買い物の録画のディレクトリ>(既定 video/shopping-draft)
//   SHOP_SYNC=1 のとき、買い物の録画を点検と同じ時刻にそろえて、点検と同じ倍率で早送りする(本番の撮影: 点検と買い物を同時に録ったとき)。
//   SHOP_SYNC が無いときは試作: 買い物の録画を、承・転の長さに合わせて伸び縮みさせるだけ(時刻はそろわない)
//   K=<倍率> で早送りの倍率を決める(既定は、点検の長さが約 FILM_TARGET 秒(既定 50)になる倍率)
//   OUT=<出力のファイル名>(既定 full-v4-draft.mp4)
// 起・導入は、make-full.mjs が作った video/full/1-ki.mp4・2-intro.mp4 を使う(台本が同じなので作り直さない)。結は 1 行目を頭に足して録り直す(結の 2〜4 行目の音声は video/full のもの)
// 台本は api/demo/story.json の narration.v4。点検で起きなかったこと(書き換えの跡が無い、など)の行は、報告と経過を見て自動で外す
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const W = resolve(process.argv[2]);
const ROOT = new URL("../..", import.meta.url).pathname;
const DATA = process.env.DATA || join(W, "..", "api", "data");
const story = JSON.parse(readFileSync(join(ROOT, "api/demo/story.json"), "utf8"));
const N = story.narration, V4 = N.v4, voice = N.voice;
const SHOP = "http://127.0.0.1:8082", RUN = process.env.RUN, ADV = process.env.ADV;
if (!RUN || !ADV) throw new Error("RUN と ADV を入れてください");
const out = join(W, "full-v4"); mkdirSync(out, { recursive: true });
const prev = join(W, "full");
const sh = (cmd, args, env) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, ...(env || {}) } }).toString();
const ff = (...a) => sh("ffmpeg", ["-y", "-loglevel", "error", ...a]);
const dur = (f) => Number(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).trim());
const enc = ["-r", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-c:a", "aac", "-ar", "48000", "-ac", "2"];

// 0. 点検の記録: 報告までの経過、話の区切りが起きたか、報告の中身
const run = JSON.parse(readFileSync(join(DATA, "runs", RUN + ".json"), "utf8"));
const ri = run.steps.findIndex((s) => s.kind === "report");
const steps = (ri >= 0 ? run.steps.slice(0, ri) : run.steps);
const report = run.report || {};
const F = report.findings || [];
const has = (cat, pred = () => true) => F.some((f) => f.category === cat && pred(f));
const CUE = {
  lab: (s) => /小部屋で試す/.test(s.tool || ""),
  restore: (s) => /公式の中身に戻す/.test(s.tool || "") && /戻した/.test(s.result || ""),
  fix: (s) => /公式の修正を当てる|公式のリリースに上げる/.test(s.tool || "") && /当てた|置いた/.test(s.result || ""),
  custom: (s) => /カスタマイズしたコードの点検/.test(s.tool || "") || (/ファイルを読む/.test(s.tool || "") && /app\/(Customize|template)\//.test(s.tool || "")),
  prod: (s) => /本番に入れる/.test(s.tool || "") && /入れた/.test(s.result || ""),
};
const happened = (k) => k === "start" || steps.some((s) => CUE[k] && CUE[k](s));
const mins = Math.max(1, Math.round(((ri >= 0 ? run.steps[ri].at : steps.at(-1).at) - steps[0].at) / 60000));

// 台本の行を、この点検に合わせて選ぶ
const fixedCat = (c) => has(c, (f) => f.status === "fixed");
const lines = [];
for (const l of V4.flow) {
  if (l.need === "restore" && !happened("restore")) continue;
  if (l.need === "custom" && !(happened("custom") || has("custom"))) continue;
  if (l.step && !steps.some((x) => new RegExp(l.step).test(x.tool || ""))) continue;
  if (l.need === "fix") {
    if (!happened("fix")) continue;
    const e = fixedCat("eccube"), p = fixedCat("packages");
    if (!e && !p) continue;
    if (e !== p) { lines.push({ ...l, ...(l.variants[e ? "eccube" : "packages"]) }); continue; }
  }
  lines.push(l);
}
// この点検で出した提案(版上げの提案があれば、その版)
const props = F.filter((f) => f.proposal_id).map((f) => { try { return JSON.parse(readFileSync(join(DATA, "proposals", f.proposal_id + ".json"), "utf8")); } catch { return null; } }).filter(Boolean);
const upP = props.find((p) => p.from_version && p.to_version);
// 見つけた問題の一覧(報告から作る。当てはまらなかったものと、知らせだけのものは入れない)
const order = ["php", "tamper", "eccube", "packages", "custom", "exposure", "config"];
const found = order.filter((c) => has(c, (f) => f.status !== "not_affected" && f.severity !== "info")).slice(0, 5)
  .map((c) => {
    const n = F.filter((f) => f.category === c && f.status !== "not_affected" && f.severity !== "info").length;
    // EC-CUBE の行は、版上げの提案があれば版の数字まで書く(報告で読んだ今の版と、提案の上げ先の版)
    if (c === "eccube" && upP) return { c, text: V4.findings_eccube_upgrade.replace("{from}", upP.from_version).replace("{to}", upP.to_version) };
    return { c, text: V4.findings_labels[c] + (n > 1 ? `(${n} 件)` : "") };
  });
// 見つけた問題を、それを見つけた経過の行の時刻(実際の時計)に結びつける。見つからなければ null(あとで自然な順に置く)
const stepT = (s) => s.tool || s.kind || "";
const firstAt = (...preds) => { for (const pr of preds) { const s = steps.find((x) => pr(x, stepT(x), x.title || "", String(x.result || ""))); if (s) return s.at; } return null; };
const FOUND_AT = {
  php: () => firstAt((x, t, ti) => t === "判断" && /当てはま/.test(ti) && !/当てはまらない|当てはまりません/.test(ti), (x, t) => t === "サーバーを調べる"),
  tamper: () => firstAt((x, t) => /^(公式との違いを見る|公式の中身に戻す|隔離する)/.test(t)),
  eccube: () => firstAt((x, t) => /^(公式の修正を当てる|公式のリリースに上げる): \d/.test(t), (x, t) => /^版上げを提案/.test(t), (x, t, ti) => /EC-CUBE.*(release|リリース|修正版)/i.test(ti)),
  packages: () => firstAt((x, t) => /部品の弱点|部品の脆弱性/.test(t)),
  custom: () => firstAt((x, t) => /カスタマイズしたコードの点検/.test(t), (x, t) => CUE.custom(x)),
  exposure: () => firstAt((x, t, ti, r) => /^外から開く/.test(t) && /見える/.test(r)),
  config: () => firstAt((x, t) => /^(本番に入れる|小部屋で試す)/.test(t)),
};
for (const f of found) f.at = FOUND_AT[f.c] ? FOUND_AT[f.c]() : null;
// 見つけた順に並べる(時刻が無いものは、あとで隙間に置く)
found.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
console.log("読む行:", lines.map((l) => l.key).join(","), " 見つけた問題:", found.map((f) => f.text).join(" / "), " 点検:", mins, "分");

// 1. 音声
const clip = {};
const tts = (key, parts) => {
  const f = join(out, key);
  execFileSync("node", [join(ROOT, "api/scripts/tts.mjs"), String(voice.speaker_id), f, JSON.stringify(parts)], { env: { ...process.env, ACCENTS: JSON.stringify(voice.accents) } });
  clip[key] = { file: f + ".wav", d: dur(f + ".wav") };
};
for (const l of lines) tts(l.key, [{ text: l.read ?? l.text, pause: l.pause ?? 250 }]);
for (const l of V4.health) tts(l.key, [{ text: l.read ?? l.text, pause: l.pause ?? 250 }]);
// 承認の場面の録画の目印(版上げか、カスタマイズの直しか)。台本は種類で切り替える
const pdir = join(W, "approve");
const pm = JSON.parse(readFileSync(join(pdir, "marks.json"), "utf8"));
const APPROVE = pm.upgrade && V4.approve_upgrade ? V4.approve_upgrade : V4.approve;
// 版上げの進み具合で読む行は、実際にお店を止めた長さに合う言い方を選ぶ(買い物の記録で、承認から終わりまでに 503 を見た時刻の幅)
let maintSec = null;
try {
  const sm = JSON.parse(readFileSync(join(process.env.SHOPPING || join(W, "shopping"), "marks.json"), "utf8"));
  const wa = pm.wall_start + (pm.approved ?? 0) * 1000, wb = pm.wall_start + (pm.done ?? pm.wall_total) * 1000;
  const t5 = sm.pages.filter((pg) => (pg.status === 503 || /: 503\b/.test(String(pg.error || ""))) && pg.at >= wa && pg.at <= wb).map((pg) => pg.at);
  if (t5.length) maintSec = (Math.max(...t5) - Math.min(...t5)) / 1000 + 2;
} catch {}
for (const l of APPROVE) tts(l.key, [{ text: (l.alt_long && maintSec !== null && maintSec > 10 ? l.alt_long : (l.read ?? l.text)), pause: l.pause ?? 250 }]);
console.log("版上げでお店を止めた長さ(買い物の記録から、秒)", maintSec);
tts("k0", [{ text: V4.ketsu0.read.replace("{mins}", String(mins)), pause: 900 }]);

// 2. 承・転: 撮影モードを流しっぱなし(flow=K)で録る
const realSec = ((ri >= 0 ? run.steps[ri].at : steps.at(-1).at) - steps[0].at) / 1000;
const K = Number(process.env.K) || Math.ceil(realSec / Number(process.env.FILM_TARGET || 50));
const fdir = join(out, "film");
if (!(process.env.REUSE_FILM && existsSync(join(fdir, "marks.json")))) {
  execFileSync("rm", ["-rf", fdir]);
  sh("node", [join(ROOT, "api/scripts/record-film.cjs"), SHOP, RUN, ADV, "1200", fdir], { FLOW: String(K) });
}
const marks = JSON.parse(readFileSync(join(fdir, "marks.json"), "utf8"));
const webm = join(fdir, readdirSync(fdir).find((f) => f.endsWith(".webm")));
// 録画は時計どおりに進まないので、話の区切りの時刻は、撮影モードが右上の四角を反転させた所を録画の中で探して使う
const flips = lineFlips(webm, 1902, 6).flips;
const fok = flips.length === marks.stops.length;
if (!fok) console.log(`区切りの目印が ${flips.length} 個(${marks.stops.length} 個のはず)。時計の時刻で置く`);
const cueAt = {}; marks.stops.forEach((s, i) => { const k = s.text.replace(/^cue:/, ""); if (!(k in cueAt)) cueAt[k] = fok ? flips[i] : s.at; });
if (!("start" in cueAt) || !("end" in cueAt)) throw new Error("始めと終わりの目印がない: " + JSON.stringify(marks.stops));
const S = Math.max(0, cueAt.start - 0.2);
const endT = cueAt.end - S;
// 早送りの実際の倍率(録画は時計より遅れて進むので、録画の中の始めと終わりの目印のあいだで測る)
const t0 = steps[0].at, start = cueAt.start - S;
const Keff = fok ? realSec / (cueAt.end - cueAt.start) : K;
console.log("早送りの実際の倍率", Keff.toFixed(2), "(名目", K, ")");
// 点検の経過の時刻(時計)→ 元の早送りの秒
const oOfWall = (w) => start + (w - t0) / (Keff * 1000);
// 行の置き場の目安: 区切り(cue)の頃か、経過の段(step: 道具の名前の正規表現)の頃。follow の行は前の行のすぐあと
const tgtOf = (l) => {
  if (l.step) { const st = steps.find((x) => new RegExp(l.step).test(x.tool || "")); if (st) return oOfWall(st.at) + 0.15; }
  return (cueAt[l.cue] ?? cueAt.start) - S + 0.15;
};
// 目安の順に並べる(follow の行は前の行にくっつけたまま)
const groups = []; for (const l of lines) { if (l.follow && groups.length) groups.at(-1).push(l); else groups.push([l]); }
groups.forEach((g) => { g.tgt = tgtOf(g[0]); });
groups.sort((x, y) => x.tgt - y.tgt);
// 行を置く: 目安より前には置かない、前の行と重ならないように。late の行は、終わりの少し前に寄せる
const place = []; let tEnd = 0.15;
for (const g of groups) for (const [gi, l] of g.entries()) {
  const d = clip[l.key].d;
  let at = gi > 0 ? tEnd + 0.3 : Math.max(g.tgt, tEnd + 0.35);
  if (l.late) at = Math.max(at, endT - d - 1.5);
  place.push({ at, k: l.key, overlay: l.overlay }); tEnd = at + d;
}
if (tEnd > endT + 0.5) console.log(`承・転の話が、早送りの終わりより ${(tEnd - endT).toFixed(1)} 秒長い。K を下げるか、行を短く`);
// 沈黙を詰める: 話の無いあいだだけ早送りを速くする(区間ごとに速さを変える)。時刻の写し方は 1 つの対応表(元の早送りの秒 ⇄ 出力の秒)で持ち、
// 話・札(時計と注文の数)・見つけた問題の一覧の出る時刻は、全部この対応表で引く
const GAP = Number(process.env.GAP || 1.5);
// 健康診断: 表が出たら読む(元の秒で置く。表が出てから少し置く)
const hAtO = Math.max(endT + 0.8, tEnd + 0.4);
let ht = hAtO; for (const l of V4.health) { place.push({ at: ht, k: l.key }); ht += clip[l.key].d; }
const Eavail = marks.total - 0.3 + (fok ? flips.at(-1) - marks.stops.at(-1).at : 0);
const origLen = Math.min(Eavail - S, ht + 0.25);
// 話の区間(元の秒)のあいだの沈黙が GAP より長ければ、その区間を GAP 秒に縮める
const spans = place.map((p) => [p.at, p.at + clip[p.k].d]).sort((a, b) => a[0] - b[0]);
const segs = []; let cur = 0;
for (const [a, b] of spans) {
  if (a - cur > GAP + 0.2) { segs.push({ a: cur, b: a, f: GAP / (a - cur) }); } else if (a > cur) segs.push({ a: cur, b: a, f: 1 });
  segs.push({ a: Math.max(a, cur), b: Math.max(b, cur), f: 1 }); cur = Math.max(cur, b);
}
if (origLen > cur) segs.push({ a: cur, b: origLen, f: origLen - cur > 1.0 + 0.2 ? 1.0 / (origLen - cur) : 1 });
const segOut = []; { let t = 0; for (const g of segs) { segOut.push(t); t += (g.b - g.a) * g.f; } }
const oToOut = (o) => { for (let i = segs.length - 1; i >= 0; i--) if (o >= segs[i].a) return segOut[i] + (Math.min(o, segs[i].b) - segs[i].a) * segs[i].f; return o; };
const toOrig = (t) => { for (let i = segs.length - 1; i >= 0; i--) if (t >= segOut[i]) return segs[i].a + (t - segOut[i]) / segs[i].f; return t; };
const fromOrig = oToOut;
const flen = oToOut(origLen);
const endT2 = oToOut(endT), hAt = oToOut(hAtO);
console.log("沈黙の詰め", JSON.stringify({ origLen: origLen.toFixed(1), flen: flen.toFixed(1), fast: segs.filter((g) => g.f < 1).map((g) => `${g.a.toFixed(1)}-${g.b.toFixed(1)}x${(1 / g.f).toFixed(1)}`) }));

// 右下の札(「点検中も営業中」・時計・ご注文の件数): 点検と同時に録った買い物の記録(video/shopping/marks.json)から、こまごとに作る
const sdir = process.env.SHOPPING || join(W, "shopping");
const smarks = JSON.parse(readFileSync(join(sdir, "marks.json"), "utf8"));
const orderTimes = smarks.orders || [];
// メンテナンスの時間: お客さんが 503(メンテナンスの画面)を見た記録の少し前から、次にふつうに開けた画面まで。
// 503 のほかの失敗(500・つながらない)はメンテナンスとは数えず、件数を出して知らせる(隠さない)
const maintIv = [];
const is503 = (pg) => pg.status === 503 || (typeof pg.error === "string" && /: 503\b/.test(pg.error));
const otherBad = smarks.pages.filter((pg) => !is503(pg) && ((pg.status && pg.status >= 500) || (pg.error && !(typeof pg.error === "string" && /: 503\b/.test(pg.error)))));
console.log("買い物の記録: 503(メンテナンスの画面)", smarks.pages.filter((pg) => pg.status === 503).length, "件、そのほかの失敗(500・つながらない)", otherBad.length, "件", otherBad.slice(0, 5).map((pg) => `${pg.step}:${pg.status ?? pg.error}`).join(" "));
smarks.pages.forEach((pg, i) => {
  if (!is503(pg)) return;
  const prevAt = i > 0 ? smarks.pages[i - 1].at : pg.at - 1000;
  const next = smarks.pages.slice(i + 1).find((q) => !q.error && q.status && q.status < 500);
  maintIv.push([Math.max(prevAt, pg.at - 1500), next ? next.at : smarks.wall_end]);
});
const inMaint = (w) => maintIv.some(([a, b]) => w >= a && w <= b);
const ordersAt = (w) => orderTimes.filter((t) => t <= w).length;
const BFPS = 10;
const clockOf = (w) => new Date(w).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo" });
// こまを作って PNG にする。wallOf(t) = 出力の t 秒目の時計(ミリ秒)、showOf(t) = 札を出すか
function badgeFrames(name, len, wallOf, showOf) {
  const frames = []; let prevN = null, lastUp = -9;
  for (let i = 0; i < Math.ceil(len * BFPS); i++) {
    const t = i / BFPS, w = wallOf(t), n = ordersAt(w);
    if (prevN !== null && n > prevN) lastUp = t;
    prevN = n;
    frames.push({ show: showOf(t), clock: clockOf(w), orders: n, maint: inMaint(w), pulse: Math.max(0, 1 - (t - lastUp) / 0.5) });
  }
  const dir = join(out, name); execFileSync("rm", ["-rf", dir]); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "frames.json"), JSON.stringify({ text: V4.badge, frames }));
  sh("node", [join(ROOT, "api/scripts/badge-frames.cjs"), join(dir, "frames.json"), dir]);
  return { dir, frames };
}
// 早送りの実際の倍率(録画は時計より遅れて進むので、録画の中の始めと終わりの目印のあいだで測る)
// 見つけた問題の一覧: 見出しだけの札を「書き出していきます」の行で出し、項目は見つけた時刻に 1 行ずつ足す。早送りが終わる(健康診断の表が出る)前に消す
// 重ねるのは時間を詰める前の早送り(元の秒)なので、時刻は元の秒で決める
const fdir2 = join(out, "findings"); execFileSync("rm", ["-rf", fdir2]);
sh("node", [join(ROOT, "api/scripts/findings-card.cjs"), V4.findings_title, JSON.stringify(found.map((f) => f.text)), fdir2]);
const fp = place.find((p) => p.overlay === "findings");
const ovA = fp ? fp.at - 0.2 : 0;
const ovB = fp ? Math.min(hAtO - 0.2, endT + 0.4) : 0;
{
  const first = ovA + 1.2, last = ovB - 0.8;
  const timed = found.map((f) => (f.at == null ? null : start + (f.at - t0) / (Keff * 1000)));
  // 時刻が無いものは、前後の時刻のあいだ(無ければ均等)に置く
  let prev = first;
  found.forEach((f, i) => {
    let o = timed[i];
    if (o == null) { const nx = timed.slice(i + 1).find((x) => x != null) ?? last; o = prev + (Math.max(nx, prev + 0.6) - prev) / 2; }
    o = Math.min(Math.max(o, prev, first), last);
    f.o = o; prev = o + 0.6;
  });
}
console.log("見つけた問題を出す秒(出力)", found.map((f) => `${f.c}@${fromOrig(f.o).toFixed(1)}`).join(" "));
const fb = badgeFrames("badge-film", flen, (t) => t0 + Math.max(0, toOrig(t) - start) * Keff * 1000, (t) => t <= endT2 + 0.5);
const inputs = place.flatMap((p) => ["-i", clip[p.k].file]);
const ni = place.length;
const filt = [
  `[0:v]drawbox=x=1896:y=0:w=24:h=24:color=0x2e3e50:t=fill[f0]`,
  `[${ni + 1}:v]format=rgba,fade=t=in:st=${ovA.toFixed(2)}:d=0.3:alpha=1,fade=t=out:st=${(ovB - 0.3).toFixed(2)}:d=0.3:alpha=1[fc]`,
  `[f0][fc]overlay=0:0:enable='between(t,${ovA.toFixed(2)},${ovB.toFixed(2)})'[g0]`,
  ...found.map((f, i) => `[${ni + 2 + i}:v]format=rgba,fade=t=in:st=${f.o.toFixed(2)}:d=0.45:alpha=1,fade=t=out:st=${(ovB - 0.3).toFixed(2)}:d=0.3:alpha=1[fi${i}];[g${i}][fi${i}]overlay=0:0:enable='between(t,${f.o.toFixed(2)},${ovB.toFixed(2)})'[g${i + 1}]`),
  `[g${found.length}]null[f1]`,
  segs.length > 1
    ? `[f1]split=${segs.length}` + segs.map((_, i) => `[x${i}]`).join("") + ";" + segs.map((g, i) => `[x${i}]trim=${g.a.toFixed(3)}:${g.b.toFixed(3)},setpts=(PTS-STARTPTS)*${g.f.toFixed(5)}[y${i}]`).join(";") + ";" + segs.map((_, i) => `[y${i}]`).join("") + `concat=n=${segs.length}:v=1:a=0[f2]`
    : `[f1]null[f2]`,
  `[${ni + 2 + found.length}:v]format=rgba[bd]`,
  `[f2][bd]overlay=0:0:eof_action=pass[fv]`,
  place.map((p, i) => { const ms = Math.round(oToOut(p.at) * 1000); return `[${i + 1}:a]adelay=${ms}|${ms},aresample=48000[a${i}]`; }).join(";"),
  place.map((_, i) => `[a${i}]`).join("") + `amix=inputs=${ni}:normalize=0,apad[aout]`,
].join(";");
ff("-ss", S.toFixed(3), "-t", origLen.toFixed(3), "-i", webm, ...inputs, "-loop", "1", "-t", origLen.toFixed(3), "-i", join(fdir2, "base.png"), ...found.flatMap((_, i) => ["-loop", "1", "-t", origLen.toFixed(3), "-i", join(fdir2, `item-${i}.png`)]), "-framerate", String(BFPS), "-i", join(fb.dir, "b%05d.png"),
  "-filter_complex", filt, "-map", "[fv]", "-map", "[aout]", "-t", flen.toFixed(3), ...enc, join(out, "3-film.mp4"));
console.log("承・転", JSON.stringify({ K, realSec: Math.round(realSec), len: flen.toFixed(1), end: endT2.toFixed(1), place: place.map((p) => `${p.k}@${oToOut(p.at).toFixed(1)}`), orders: fb.frames.at(-1).orders }));

// 3. 承認の場面: video/approve の録画(健康診断の表 → カード → 確認コード → 承認 → 「直しました」の結果)
const pwebm = join(pdir, readdirSync(pdir).find((f) => f.endsWith(".webm")));
const pr = dur(pwebm) / pm.wall_total;
// 直ったページとお店のトップは映さない(お店が止まっていないことは、承・転の買い物の画面で見せている)。「直しました」の結果がカードに出たところで終える
const P0 = Math.max(0, (pm.health ?? pm.card) * pr - 0.1), P1 = (pm.after ?? pm.top ?? pm.wall_total) * pr - 0.3;
const at = (m) => m * pr - P0 + 0.2;
const pplace = [];
let pt = 0;
for (const l of APPROVE) { const a = Math.max(at(pm[l.at]), pt + 0.3); pplace.push({ at: a, k: l.key }); pt = a + clip[l.key].d; }
// 結の 1 行目は、結の頭(版の違うお店の健康診断が並ぶところ)で読む。承認の場面は 3 行目を読み終えたら終える
const plen = Math.max(P1 - P0, pt + 0.4);
if (pm.upgrade && pm.done) {
  // 版上げ: 承認を押してから終わるまで(数十秒)は早送りにし、右下に同じ時刻の買い物の画面を重ねる(メンテナンス中もそのまま)
  // 区間は壁時計(録画の頭からの秒)で決め、録画の秒(× pr)に直して切る
  // 結果のカード(「上げました。お店を開いて確かめました」)のあとは、そのまま結へ。お店のトップに移るところは映さない
  // (お店が動いていることは札で見せている。トップが一瞬だけ映ると不自然なため)
  const w0 = P0 / pr, wA = pm.approved + 1.2, wB = Math.max(wA + 1, pm.done - 0.3), w1 = Math.min(Math.max(wB + 1, (pm.after ?? pm.wall_total) - 0.1), wB + 1.8); // 結果は約 1.8 秒見せて結へ
  // 沈黙を詰める: 健康診断の表で止まっている所は約 0.4 秒、カードへのスクロールは約 1.6 秒に。
  // 承認から終わりまで(進み具合)は速めるが、お客さんがメンテナンスの画面を見ていた区間(札が黄色)は約 1.2 秒残す
  const wS = Math.min(Math.max(w0 + 0.1, pm.scroll ?? w0), pm.card), wC = Math.max(wS + 0.1, pm.card);
  const mWin = maintIv.map(([x, y]) => [(x - pm.wall_start) / 1000, (y - pm.wall_start) / 1000]).filter(([x, y]) => y > wA && x < wB);
  const mA = mWin.length ? Math.max(wA, Math.min(...mWin.map((m) => m[0]))) : null, mB = mWin.length ? Math.min(wB, Math.max(...mWin.map((m) => m[1]))) : null;
  // 進み具合の長さは、そこで読む行(承認のあとの行)が収まる長さより短くしない
  const progLines = APPROVE.filter((l) => l.at === "approved").reduce((x, l) => x + clip[l.key].d + 0.3, 0);
  const PROG = Math.max(Number(process.env.PROG || 3.2), progLines - 1.2 - 0.2), MAINT = 1.2;
  const segs = [[w0, wS, Math.min(1, 0.4 / (wS - w0))], [wS, wC, Math.min(1, 1.6 / (wC - wS))], [wC, wA, 1]];
  if (mA !== null && mB > mA) {
    const fastLen = (mA - wA) + (wB - mB), ff2 = Math.min(1, Math.max(0.5, PROG - MAINT) / Math.max(0.1, fastLen));
    if (mA > wA) segs.push([wA, mA, ff2]);
    segs.push([mA, mB, Math.min(1, MAINT / (mB - mA))]);
    if (wB > mB) segs.push([mB, wB, ff2]);
  } else segs.push([wA, wB, Math.min(1, PROG / (wB - wA))]);
  segs.push([wB, w1, 1]);
  const FAST = (PROG) / (wB - wA);
  const parts = [];
  segs.filter(([a, b]) => b - a > 0.05).forEach(([a, b, f], i) => {
    const outLen = (b - a) * f, o = join(out, `3b-ap${i}.mp4`);
    ff("-ss", (a * pr).toFixed(3), "-t", ((b - a) * pr).toFixed(3), "-i", pwebm, "-vf", `fps=30,setpts=(PTS-STARTPTS)*${(outLen / ((b - a) * pr)).toFixed(5)},trim=duration=${outLen.toFixed(3)}`,
      "-an", "-r", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", o);
    parts.push({ o, a, b, f, outLen });
  });
  writeFileSync(join(out, "ap.list"), parts.map((x) => `file '${x.o}'`).join("\n"));
  const apv = join(out, "3b-ap-v.mp4"); ff("-f", "concat", "-safe", "0", "-i", join(out, "ap.list"), "-c", "copy", apv);
  // 版上げのカードの下にある、ほかの承認待ちのカード(カスタマイズの直しなど)は暗くする(版上げを承認しているのが分かるように)。
  // カードとカードのあいだは「枠線(暗い 1 行)→ 明るい隙間 15 行 → 枠線」なので、x=1000 の 1 列でそれを探し、下のカードの上端を 0.1 秒ごとに求める
  const below = [];
  {
    const raw = execFileSync("ffmpeg", ["-v", "error", "-i", apv, "-vf", "fps=10,crop=2:1080:1000:0", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1 << 28 });
    for (let f = 0; (f + 1) * 1080 * 2 <= raw.length; f++) {
      const g = (y) => raw[(f * 1080 + y) * 2];
      let top = null;
      for (let y = 280; y < 1060; y++) {
        if (g(y) >= 232) continue;
        for (const d of [14, 15, 16]) {
          if (y + d < 1080 && g(y + d) < 232) {
            let ok = true; for (let k = y + 2; k < y + d - 1; k++) if (g(k) < 240) { ok = false; break; }
            if (ok) { top = y + d; break; }
          }
        }
        if (top !== null) break;
      }
      below.push(top);
    }
  }
  // 同じ高さが続く区間にまとめて、半透明の紺を重ねる式にする
  const dim = [];
  below.forEach((y, i) => {
    const q = y === null ? null : Math.round(y / 4) * 4, t = i / 10, last = dim.at(-1);
    if (last && last.y === q) last.b = t + 0.1; else dim.push({ y: q, a: t, b: t + 0.1 });
  });
  if (dim.length) dim.at(-1).b = 9999;
  // 健康診断の表を見せているあいだ(カードへスクロールする前)は暗くしない(早送りの最後の表とのつなぎ目を変えないため)
  const dimFrom = (() => { let t = 0; for (const x of parts) { if (pm.scroll <= x.b) return t + Math.max(0, pm.scroll - x.a) * x.f; t += x.outLen; } return 0; })();
  // 2026-11-06: 半透明の紺が白い画面の上で灰色に見えるので、暗くするのはやめた(DIM=1 のときだけ重ねる)
  const dimF = process.env.DIM !== "1" ? "" : dim.filter((d) => d.y !== null && d.b > dimFrom).map((d) => ({ ...d, a: Math.max(d.a, dimFrom) })).map((d) => `drawbox=x=0:y=${d.y}:w=1920:h=${1080 - d.y}:color=0x0d172a@0.82:t=fill:enable='between(t,${d.a.toFixed(2)},${d.b.toFixed(2)})'`).join(",");
  const belowAt = (t) => below[Math.max(0, Math.min(below.length - 1, Math.round(t * 10)))];
  // 壁時計 → 出力の秒
  const outT = (w) => { let t = 0; for (const x of parts) { if (w <= x.b) return t + Math.max(0, w - x.a) * x.f; t += x.outLen; } return t; };
  const up = []; let ut = 0;
  // 最初の行(スクロールの頃)は、表からの切り替え(0.4 秒の重ね)が済んだらすぐ読む(沈黙を長くしない)
  for (const [li, l] of APPROVE.entries()) { const a2 = li === 0 && l.at === "scroll" ? 0.45 : Math.max(outT(pm[l.at]) + 0.2, ut + 0.3); up.push({ at: a2, k: l.key }); ut = a2 + clip[l.key].d; }
  const total = parts.reduce((x, y) => x + y.outLen, 0), ulen = Math.max(total, ut + 0.4);
  // 寄せる: カードの「4.2.0 → 4.2.3-p2」(1 行目を読むあいだ)と、結果の版(終わってから)。ゆっくり寄って、ゆっくり戻る
  const zw = [];
  // 文字は左寄せなので、行の幅いっぱいではなく、左から 900px ほどの真ん中に寄せる
  const box = (r) => r && r.w > 0 ? { cx: r.x + Math.min(r.w, 900) / 2, cy: r.y + r.h / 2 } : null;
  const cb = box(pm.cardBox), rb = box(pm.resultBox);
  // カードは「4.2.0 → 4.2.3-p2」の行が上の方に来るように寄せる(下にカードの説明が見える。上のほかのカードは映さない)
  // 寄る先は版上げのカードだけ: カードの上端(管理画面の見出しの下、64px)から、下のカードの上端までの真ん中。下のカードは暗くしてある
  const cardWinA = outT(pm.card) + 0.4, cardWinB = Math.max(outT(pm.card) + 2.5, outT(pm.code) - 0.3);
  const bCard = belowAt((cardWinA + cardWinB) / 2) ?? 360;
  if (cb) zw.push({ a: cardWinA, b: cardWinB, cx: cb.cx, cy: Math.min(cb.cy + 170, (64 + bCard) / 2 + 30) });
  // 進み具合: 版上げの記録の行(カードの中で下へ伸びていく)のあたりに、少しだけ寄る
  const pA = outT(pm.approved) + 0.6, pB = outT(pm.done) - 0.2;
  // (進み具合には寄らない。記録の途中の一時的な表示まで大きく見せないため)
  void pA; void pB;
  // 結果: 結果の行と、その上の記録の終わりのほう。下のカードは暗い
  if (rb) zw.push({ a: outT(pm.done) + 0.3, b: ulen, cx: rb.cx, cy: rb.cy - 150, end: true });
  const ZM = 1.8, RAMP = 0.6;
  // zoompan の式: 窓ごとの寄り具合 e(t)(0〜1)を足し合わせる
  const eOf = (w) => `(between(it,${w.a.toFixed(2)},${w.b.toFixed(2)})*min(1,min((it-${w.a.toFixed(2)})/${RAMP},${w.end ? 1 : `(${w.b.toFixed(2)}-it)/${RAMP}`})))`;
  const e = zw.length ? zw.map(eOf).join("+") : "0";
  const cx = zw.length ? zw.map((w) => `${eOf(w)}*${w.cx.toFixed(0)}`).join("+") + `+(1-(${e}))*960` : "960";
  const cy = zw.length ? zw.map((w) => `${eOf(w)}*${w.cy.toFixed(0)}`).join("+") + `+(1-(${e}))*540` : "540";
  const zz = zw.length ? zw.map((w) => `${eOf(w)}*${((w.z ?? ZM) - 1).toFixed(2)}`).join("+") : "0";
  const zoomF = `zoompan=z='1+(${zz})':x='max(0,min(iw-iw/zoom,(${cx})-iw/zoom/2))':y='max(0,min(ih-ih/zoom,(${cy})-ih/zoom/2))':d=1:s=1920x1080:fps=30`;
  // 札: 承認の録画の時計 → 買い物の記録の時刻(版上げのメンテナンス中は黄色)
  const inv = (t) => { let acc = 0; for (const x of parts) { if (t <= acc + x.outLen) return x.a + (t - acc) / x.f; acc += x.outLen; } return parts.at(-1).b; };
  const ab = badgeFrames("badge-approve", ulen, (t) => pm.wall_start + inv(t) * 1000, () => true);
  ff("-i", apv, ...up.flatMap((p) => ["-i", clip[p.k].file]), "-framerate", String(BFPS), "-i", join(ab.dir, "b%05d.png"), "-filter_complex",
    `[0:v]tpad=stop_mode=clone:stop_duration=${Math.max(0, ulen - total).toFixed(2)},${dimF ? dimF + "," : ""}${zoomF}[vz];[${up.length + 1}:v]format=rgba[bd];[vz][bd]overlay=0:0:eof_action=pass[v];` +
    up.map((p, i) => `[${i + 1}:a]adelay=${Math.round(p.at * 1000)}|${Math.round(p.at * 1000)},aresample=48000[pa${i}]`).join(";") + ";" + up.map((_, i) => `[pa${i}]`).join("") + `amix=inputs=${up.length}:normalize=0,apad[pa]`,
    "-map", "[v]", "-map", "[pa]", "-t", ulen.toFixed(3), ...enc, join(out, "3b-approve.mp4"));
  console.log("承認(版上げ)", JSON.stringify({ len: ulen.toFixed(1), fast: FAST.toFixed(3), upgradeWall: (pm.done - pm.approved).toFixed(1), place: up.map((p) => `${p.k}@${p.at.toFixed(1)}`), zoom: zw.map((w) => `${w.a.toFixed(1)}-${w.b.toFixed(1)}`), maintFrames: ab.frames.filter((f) => f.maint).length, dim: dim.filter((d) => d.y !== null).map((d) => `${d.y}@${d.a.toFixed(1)}`).slice(0, 12).join(" "), ordersEnd: ab.frames.at(-1).orders }));
} else
ff("-ss", P0.toFixed(3), "-t", (P1 - P0).toFixed(3), "-i", pwebm, ...pplace.flatMap((p) => ["-i", clip[p.k].file]), "-filter_complex",
  `[0:v]fps=30,tpad=stop_mode=clone:stop_duration=${Math.max(0, plen - (P1 - P0)).toFixed(2)}[v];` +
  pplace.map((p, i) => `[${i + 1}:a]adelay=${Math.round(p.at * 1000)}|${Math.round(p.at * 1000)},aresample=48000[pa${i}]`).join(";") + ";" + pplace.map((_, i) => `[pa${i}]`).join("") + `amix=inputs=${pplace.length}:normalize=0,apad[pa]`,
  "-map", "[v]", "-map", "[pa]", "-t", plen.toFixed(3), ...enc, join(out, "3b-approve.mp4"));
if (!(pm.upgrade && pm.done)) console.log("承認", JSON.stringify({ len: plen.toFixed(1), place: pplace.map((p) => `${p.k}@${p.at.toFixed(1)}`) }));

// 4. つなぐ: 早送りの最後(健康診断の表)と承認の場面の頭(同じ表)は 0.4 秒のクロスフェード
{ const fl = dur(join(out, "3-film.mp4")), X = 0.4;
  ff("-i", join(out, "3-film.mp4"), "-i", join(out, "3b-approve.mp4"), "-filter_complex",
    `[0:v][1:v]xfade=transition=fade:duration=${X}:offset=${(fl - X).toFixed(3)}[v];[0:a][1:a]acrossfade=d=${X}[a]`,
    "-map", "[v]", "-map", "[a]", ...enc, join(out, "3c-film-approve.mp4")); }
// 3c. 結の 1 行目(k0「店主さんがしたのは…」)は、承認の場面の最後(上げて確かめた結果の画面)を止めたまま読む。
// 結の場面 KE(並び → 志 → 名前)は 2 行目(ketsu1「2系から、4系まで」)から始める(2026-11-06: 並びの絵の上で k0 を読むと、話と画面が 1 行ずれていた)
{ const src = join(out, "3c-film-approve.mp4"), tmp = join(out, "3c-film-approve-k0.mp4");
  // 右下の札(点検中も営業中・ご注文の件数)は、買い物の録画が終わると最後の約 1 秒で消える。止めるあいだは、まだ札がはっきり出ているコマ(終わりの 1.6 秒前)から切り出して重ねる(終わりの 1 秒ほどは札が消えかけて薄い)
  const sd = dur(src), badge = join(out, "k0-badge.png");
  ff("-ss", (sd - 1.6).toFixed(3), "-i", src, "-frames:v", "1", "-vf", "crop=370:110:1515:930", badge);
  // 結果の画面を止めたまま読む(2026-11-06: システム情報に切り替えるのは時間つぶしに見えるのでやめ、台詞を短くした)
  ff("-i", src, "-i", clip.k0.file, "-i", badge, "-filter_complex", `[0:v]tpad=stop_mode=clone:stop_duration=${clip.k0.d.toFixed(3)}[t];[t][2:v]overlay=1515:930:enable='gte(t,${(sd - 1.2).toFixed(3)})'[v];[1:a]aresample=48000,aformat=channel_layouts=stereo[k];[0:a][k]concat=n=2:v=0:a=1[a]`,
    "-map", "[v]", "-map", "[a]", ...enc, tmp);
  execFileSync("mv", [tmp, src]); }
for (const k of ["ketsu1", "ketsu2", "ketsu3"]) clip[k] = { file: join(prev, k + ".wav"), d: dur(join(prev, k + ".wav")) };
{
  const segs = [clip.ketsu1.d, clip.ketsu2.d, clip.ketsu3.d];
  const kdir = join(out, "ke"); execFileSync("rm", ["-rf", kdir]);
  sh("node", [join(ROOT, "api/scripts/record-scene.cjs"), `KE&d=${segs.map((x) => x.toFixed(2)).join(",")}&mark=1`, kdir, ".kv-layer.in", "結"]);
  const kwebm = join(kdir, readdirSync(kdir).find((f) => f.endsWith(".webm")));
  const { flips, end } = lineFlips(kwebm, 1902, 1062);
  if (flips.length !== 3) throw new Error(`結の目印が ${flips.length} 個(3 個のはず)`);
  const ratio = (flips[2] - flips[0]) / (segs[0] + segs[1]);
  const seg = flips.map((a, i) => [a, i + 1 < 3 ? flips[i + 1] : Math.min(end, a + segs[2] * ratio)]);
  writeFileSync(join(out, "end.list"), ["ketsu1", "ketsu2", "ketsu3"].map((k) => `file '${clip[k].file}'`).join("\n"));
  const ewav = join(out, "end-voice.wav"); ff("-f", "concat", "-safe", "0", "-i", join(out, "end.list"), "-c", "copy", ewav);
  ff("-i", kwebm, "-i", ewav, "-filter_complex",
    `[0:v]fps=30,drawbox=x=1896:y=1056:w=24:h=24:color=0x0d172a:t=fill,split=3[s0][s1][s2];` +
    seg.map(([a, b], i) => `[s${i}]trim=${a.toFixed(3)}:${b.toFixed(3)},setpts=(PTS-STARTPTS)*${(segs[i] / (b - a)).toFixed(5)}[v${i}]`).join(";") +
    `;[v0][v1][v2]concat=n=3:v=1:a=0[v]`,
    "-map", "[v]", "-map", "1:a", "-t", segs.reduce((a, x) => a + x, 0).toFixed(3), ...enc, join(out, "4-end.mp4"));
}
for (const p of ["1-ki", "2-intro"]) if (!existsSync(join(prev, p + ".mp4"))) throw new Error(`${p}.mp4 が video/full に無い(先に make-full.mjs を回す)`);
// 0 秒: 応募先の名前(場面 O)。音は無音。story.json の opening.show が false なら出さない(2026-11-06: 名前からシーサーへの切り替わりが急に感じるので外した)
const SHOW_OPEN = story.opening?.show !== false;
if (SHOW_OPEN) {
  const odir = join(out, "open"); execFileSync("rm", ["-rf", odir]);
  const olen = (story.opening?.hold || 2.5) + 0.7;
  const orec = sh("node", [join(ROOT, "api/scripts/record-opening.cjs"), odir, String(olen)]);
  const trim = Number((/TRIM ([0-9.]+)/.exec(orec) || [])[1] || 0.3);
  const owebm = join(odir, readdirSync(odir).find((f) => f.endsWith(".webm")));
  // 録画の頭はページを開いた直後の白い画面が残るので、目印が出たあと少し進めてから切り出す(0 秒の白い点滅を出さない)
  ff("-ss", (trim + 0.15).toFixed(3), "-t", olen.toFixed(3), "-i", owebm, "-f", "lavfi", "-t", olen.toFixed(3), "-i", "anullsrc=r=48000:cl=stereo",
    "-map", "0:v", "-map", "1:a", "-t", olen.toFixed(3), ...enc, join(out, "0-open.mp4"));
}
// 導入の終わりの無音(最後の行「貼ってみましょう」のあとの間)と、結の終わりの無音を少し詰める(3 分に収めるため。話は削らない)。導入のあとは、貼る操作を見せる間として少し残す
const ITRIM = Number(process.env.ITRIM || 0.6), ETRIM = Number(process.env.ETRIM || 0.6);
const introT = join(out, "2-intro-trim.mp4"); ff("-i", join(prev, "2-intro.mp4"), "-t", (dur(join(prev, "2-intro.mp4")) - ITRIM).toFixed(3), ...enc, introT);
const endT9 = join(out, "4-end-trim.mp4"); ff("-i", join(out, "4-end.mp4"), "-t", (dur(join(out, "4-end.mp4")) - ETRIM).toFixed(3), "-af", `afade=t=out:st=${(dur(join(out, "4-end.mp4")) - ETRIM - 0.4).toFixed(3)}:d=0.4`, ...enc, endT9);
// 紺の背景の場面(冒頭・起・結)は、Playwright の録画(VP8)で背景の紺が数コマごとに少しずつ違う色にゆれて、ちらついて見える。紺に近い色を、ちょうどの紺 #0d172a に塗りそろえる
const FLAT = "split[a][b];[a]drawbox=c=0x0d172a:t=fill[bg];[b]colorkey=0x0d172a:0.05:0[k];[bg][k]overlay,format=yuv420p";
const flat = (src, name) => { const f = join(out, name); ff("-i", src, "-vf", FLAT, ...enc, f); return f; };
const openF = SHOW_OPEN ? flat(join(out, "0-open.mp4"), "0-open-flat.mp4") : null, kiF = flat(join(prev, "1-ki.mp4"), "1-ki-flat.mp4"), endF = flat(endT9, "4-end-flat.mp4");
writeFileSync(join(out, "all.list"), [openF, kiF, introT, join(out, "3c-film-approve.mp4"), endF].filter(Boolean).map((f) => `file '${f}'`).join("\n"));
const OUT = process.env.OUT || "full-v5.mp4";
ff("-f", "concat", "-safe", "0", "-i", join(out, "all.list"), "-c", "copy", "-movflags", "+faststart", join(W, OUT));
ff("-i", join(W, OUT), "-vf", "scale=1280:720", "-c:v", "libx264", "-crf", "28", "-preset", "medium", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", join(W, OUT.replace(/\.mp4$/, "-720p.mp4")));
console.log(OUT, dur(join(W, OUT)).toFixed(1), "秒", JSON.stringify({ open: SHOW_OPEN ? dur(join(out, "0-open.mp4")) : 0, ki: dur(join(prev, "1-ki.mp4")), intro: dur(join(prev, "2-intro.mp4")), film: dur(join(out, "3-film.mp4")), approve: dur(join(out, "3b-approve.mp4")), end: dur(join(out, "4-end.mp4")) }));

// 右上などの四角が白黒に反転した時刻を、録画の中で探す
function lineFlips(file, x, y) {
  const txt = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `crop=12:12:${x}:${y},signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`, "-f", "null", "-"]).toString();
  const fl = []; let pts = 0, prevW = null;
  for (const ln of txt.split("\n")) {
    const m = /pts_time:([0-9.]+)/.exec(ln); if (m) { pts = Number(m[1]); continue; }
    const yv = /YAVG=([0-9.]+)/.exec(ln); if (!yv) continue;
    const v = Number(yv[1]);
    if (prevW === null) { if (v < 40) prevW = false; continue; }
    const white = v > 128;
    if (white !== prevW) { fl.push(pts); prevW = white; }
  }
  return { flips: fl, end: pts };
}
