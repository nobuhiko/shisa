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
  if (l.need === "fix") {
    if (!happened("fix")) continue;
    const e = fixedCat("eccube"), p = fixedCat("packages");
    if (!e && !p) continue;
    if (e !== p) { lines.push({ ...l, ...(l.variants[e ? "eccube" : "packages"]) }); continue; }
  }
  lines.push(l);
}
// 見つけた問題の一覧(報告から作る。当てはまらなかったものと、知らせだけのものは入れない)
const order = ["php", "tamper", "eccube", "packages", "custom", "exposure", "config"];
const found = order.filter((c) => has(c, (f) => f.status !== "not_affected" && f.severity !== "info")).slice(0, 5)
  .map((c) => { const n = F.filter((f) => f.category === c && f.status !== "not_affected" && f.severity !== "info").length; return V4.findings_labels[c] + (n > 1 ? `(${n} 件)` : ""); });
console.log("読む行:", lines.map((l) => l.key).join(","), " 見つけた問題:", found.join(" / "), " 点検:", mins, "分");

// 1. 音声
const clip = {};
const tts = (key, parts) => {
  const f = join(out, key);
  execFileSync("node", [join(ROOT, "api/scripts/tts.mjs"), String(voice.speaker_id), f, JSON.stringify(parts)], { env: { ...process.env, ACCENTS: JSON.stringify(voice.accents) } });
  clip[key] = { file: f + ".wav", d: dur(f + ".wav") };
};
for (const l of lines) tts(l.key, [{ text: l.read ?? l.text, pause: l.pause ?? 250 }]);
for (const l of V4.health) tts(l.key, [{ text: l.read ?? l.text, pause: l.pause ?? 250 }]);
for (const l of V4.approve) tts(l.key, [{ text: l.read ?? l.text, pause: l.pause ?? 250 }]);
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
const S = Math.max(0, cueAt.start - 0.4);
const endT = cueAt.end - S;
// 行を置く: 区切りの頃(区切りより前には置かない)、前の行と重ならないように。late の行は、終わりの少し前に寄せる
const place = []; let tEnd = 0.15;
for (const l of lines) {
  const d = clip[l.key].d;
  let at = Math.max((cueAt[l.cue] ?? cueAt.start) - S + 0.15, tEnd + 0.35);
  if (l.late) at = Math.max(at, endT - d - 1.5);
  place.push({ at, k: l.key, overlay: l.overlay }); tEnd = at + d;
}
if (tEnd > endT + 0.5) console.log(`承・転の話が、早送りの終わりより ${(tEnd - endT).toFixed(1)} 秒長い。K を下げるか、行を短く`);
// 健康診断: 表が出たら読む。読み終わって少し置くまで流す
const hAt = Math.max(endT + 0.8, tEnd + 0.4);
let ht = hAt; for (const l of V4.health) { place.push({ at: ht, k: l.key }); ht += clip[l.key].d; }
const E = Math.min(marks.total - 0.3 + (fok ? flips.at(-1) - marks.stops.at(-1).at : 0), S + Math.max(ht + 0.8, endT + 7));
const flen = E - S;
// 見つけた問題の一覧(画像)を、その行のあいだ重ねる
const fcard = join(out, "findings.png");
sh("node", [join(ROOT, "api/scripts/findings-card.cjs"), V4.findings_title, JSON.stringify(found), fcard]);
const fp = place.find((p) => p.overlay === "findings");
const ovA = fp ? fp.at - 0.2 : 0, ovB = fp ? fp.at + clip[fp.k].d + 1.6 : 0;
// 買い物の画面を右下に重ねる
const sdir = process.env.SHOPPING || join(W, "shopping-draft");
const smarks = JSON.parse(readFileSync(join(sdir, "marks.json"), "utf8"));
const swebm = join(sdir, readdirSync(sdir).find((f) => f.endsWith(".webm")));
const slen = dur(swebm), sspan = (smarks.wall_end - smarks.wall_start) / 1000;
let sa = 0, sb = slen / endT; // 試作: 承・転の長さに合わせて伸び縮み
if (process.env.SHOP_SYNC) {
  // 本番: 早送りの t 秒目 = 点検の時刻 t0 + (t - 始め) × K。その時刻の買い物の録画を出す
  const t0 = steps[0].at, start = cueAt.start - S;
  sb = (K * slen) / sspan;
  sa = ((t0 - smarks.wall_start) / 1000) * (slen / sspan) - start * sb;
}
const sShift = sa < 0 ? -sa / sb : 0, sTrim = Math.max(0, sa);
const PW = 560, PX = 1920 - PW - 8 - 28, PY = 1080 - Math.round((PW * 9) / 16) - 8 - 104;
const inputs = place.flatMap((p) => ["-i", clip[p.k].file]);
const ni = place.length;
const filt = [
  `[0:v]drawbox=x=1896:y=0:w=24:h=24:color=0x2e3e50:t=fill[f0]`,
  `[${ni + 1}:v]format=rgba,fade=t=in:st=${ovA.toFixed(2)}:d=0.3:alpha=1,fade=t=out:st=${(ovB - 0.3).toFixed(2)}:d=0.3:alpha=1[fc]`,
  `[f0][fc]overlay=0:0:enable='between(t,${ovA.toFixed(2)},${ovB.toFixed(2)})'[f1]`,
  `[${ni + 2}:v]trim=start=${sTrim.toFixed(3)},setpts=(PTS-STARTPTS)/${sb.toFixed(5)}+${sShift.toFixed(3)}/TB,scale=${PW}:-2,pad=iw+8:ih+8:4:4:color=white[pip]`,
  `[f1][pip]overlay=${PX}:${PY}:eof_action=pass:enable='lte(t,${(endT + 0.5).toFixed(2)})'[fv]`,
  place.map((p, i) => `[${i + 1}:a]adelay=${Math.round(p.at * 1000)}|${Math.round(p.at * 1000)},aresample=48000[a${i}]`).join(";"),
  place.map((_, i) => `[a${i}]`).join("") + `amix=inputs=${ni}:normalize=0,apad[aout]`,
].join(";");
ff("-ss", S.toFixed(3), "-t", flen.toFixed(3), "-i", webm, ...inputs, "-loop", "1", "-t", flen.toFixed(3), "-i", fcard, "-i", swebm,
  "-filter_complex", filt, "-map", "[fv]", "-map", "[aout]", "-t", flen.toFixed(3), ...enc, join(out, "3-film.mp4"));
console.log("承・転", JSON.stringify({ K, realSec: Math.round(realSec), len: flen.toFixed(1), end: endT.toFixed(1), place: place.map((p) => `${p.k}@${p.at.toFixed(1)}`), pip: { sa: sa.toFixed(1), sb: sb.toFixed(2) } }));

// 3. 承認の場面: video/approve の録画(健康診断の表 → カード → 確認コード → 承認 → 「直しました」の結果)
const pdir = join(W, "approve");
const pm = JSON.parse(readFileSync(join(pdir, "marks.json"), "utf8"));
const pwebm = join(pdir, readdirSync(pdir).find((f) => f.endsWith(".webm")));
const pr = dur(pwebm) / pm.wall_total;
// 直ったページとお店のトップは映さない(お店が止まっていないことは、承・転の買い物の画面で見せている)。「直しました」の結果がカードに出たところで終える
const P0 = Math.max(0, (pm.health ?? pm.card) * pr - 0.1), P1 = (pm.after ?? pm.top ?? pm.wall_total) * pr - 0.3;
const at = (m) => m * pr - P0 + 0.2;
const pplace = [];
let pt = 0;
for (const l of V4.approve) { const a = Math.max(at(pm[l.at]), pt + 0.3); pplace.push({ at: a, k: l.key }); pt = a + clip[l.key].d; }
// 結の 1 行目は、結の頭(版の違うお店の健康診断が並ぶところ)で読む。承認の場面は 3 行目を読み終えたら終える
const plen = Math.max(P1 - P0, pt + 0.4);
ff("-ss", P0.toFixed(3), "-t", (P1 - P0).toFixed(3), "-i", pwebm, ...pplace.flatMap((p) => ["-i", clip[p.k].file]), "-filter_complex",
  `[0:v]fps=30,tpad=stop_mode=clone:stop_duration=${Math.max(0, plen - (P1 - P0)).toFixed(2)}[v];` +
  pplace.map((p, i) => `[${i + 1}:a]adelay=${Math.round(p.at * 1000)}|${Math.round(p.at * 1000)},aresample=48000[pa${i}]`).join(";") + ";" + pplace.map((_, i) => `[pa${i}]`).join("") + `amix=inputs=${pplace.length}:normalize=0,apad[pa]`,
  "-map", "[v]", "-map", "[pa]", "-t", plen.toFixed(3), ...enc, join(out, "3b-approve.mp4"));
console.log("承認", JSON.stringify({ len: plen.toFixed(1), place: pplace.map((p) => `${p.k}@${p.at.toFixed(1)}`) }));

// 4. つなぐ: 早送りの最後(健康診断の表)と承認の場面の頭(同じ表)は 0.4 秒のクロスフェード
{ const fl = dur(join(out, "3-film.mp4")), X = 0.4;
  ff("-i", join(out, "3-film.mp4"), "-i", join(out, "3b-approve.mp4"), "-filter_complex",
    `[0:v][1:v]xfade=transition=fade:duration=${X}:offset=${(fl - X).toFixed(3)}[v];[0:a][1:a]acrossfade=d=${X}[a]`,
    "-map", "[v]", "-map", "[a]", ...enc, join(out, "3c-film-approve.mp4")); }
// 3c. 結: 場面 KE を録り直し、1 行目(k0)と 2 行目(ketsu1)を、健康診断が並ぶ最初の画面で続けて読む。
// 場面 KE は 3 つの区切り(並び → 志 → 名前)なので、最初の区切りの長さを k0 + ketsu1 にする。最初の区切りの字幕は ketsu1 の文なので、k0 を読むあいだは字幕を隠す
for (const k of ["ketsu1", "ketsu2", "ketsu3"]) clip[k] = { file: join(prev, k + ".wav"), d: dur(join(prev, k + ".wav")) };
{
  const segs = [clip.k0.d + clip.ketsu1.d, clip.ketsu2.d, clip.ketsu3.d];
  const kdir = join(out, "ke"); execFileSync("rm", ["-rf", kdir]);
  sh("node", [join(ROOT, "api/scripts/record-scene.cjs"), `KE&d=${segs.map((x) => x.toFixed(2)).join(",")}&mark=1`, kdir, ".kv-layer.in", "結"]);
  const kwebm = join(kdir, readdirSync(kdir).find((f) => f.endsWith(".webm")));
  const { flips, end } = lineFlips(kwebm, 1902, 1062);
  if (flips.length !== 3) throw new Error(`結の目印が ${flips.length} 個(3 個のはず)`);
  const ratio = (flips[2] - flips[0]) / (segs[0] + segs[1]);
  const seg = flips.map((a, i) => [a, i + 1 < 3 ? flips[i + 1] : Math.min(end, a + segs[2] * ratio)]);
  writeFileSync(join(out, "end.list"), ["k0", "ketsu1", "ketsu2", "ketsu3"].map((k) => `file '${clip[k].file}'`).join("\n"));
  const ewav = join(out, "end-voice.wav"); ff("-f", "concat", "-safe", "0", "-i", join(out, "end.list"), "-c", "copy", ewav);
  ff("-i", kwebm, "-i", ewav, "-filter_complex",
    `[0:v]fps=30,drawbox=x=1896:y=1056:w=24:h=24:color=0x0d172a:t=fill,split=3[s0][s1][s2];` +
    seg.map(([a, b], i) => `[s${i}]trim=${a.toFixed(3)}:${b.toFixed(3)},setpts=(PTS-STARTPTS)*${(segs[i] / (b - a)).toFixed(5)}[v${i}]`).join(";") +
    `;[v0][v1][v2]concat=n=3:v=1:a=0,drawbox=x=0:y=960:w=1920:h=120:color=0x0d172a:t=fill:enable='lte(t,${clip.k0.d.toFixed(2)})'[v]`,
    "-map", "[v]", "-map", "1:a", "-t", segs.reduce((a, x) => a + x, 0).toFixed(3), ...enc, join(out, "4-end.mp4"));
}
for (const p of ["1-ki", "2-intro"]) if (!existsSync(join(prev, p + ".mp4"))) throw new Error(`${p}.mp4 が video/full に無い(先に make-full.mjs を回す)`);
writeFileSync(join(out, "all.list"), [join(prev, "1-ki.mp4"), join(prev, "2-intro.mp4"), join(out, "3c-film-approve.mp4"), join(out, "4-end.mp4")].map((f) => `file '${f}'`).join("\n"));
const OUT = process.env.OUT || "full-v4-draft.mp4";
ff("-f", "concat", "-safe", "0", "-i", join(out, "all.list"), "-c", "copy", "-movflags", "+faststart", join(W, OUT));
ff("-i", join(W, OUT), "-vf", "scale=1280:720", "-c:v", "libx264", "-crf", "28", "-preset", "medium", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", join(W, OUT.replace(/\.mp4$/, "-720p.mp4")));
console.log(OUT, dur(join(W, OUT)).toFixed(1), "秒", JSON.stringify({ ki: dur(join(prev, "1-ki.mp4")), intro: dur(join(prev, "2-intro.mp4")), film: dur(join(out, "3-film.mp4")), approve: dur(join(out, "3b-approve.mp4")), end: dur(join(out, "4-end.mp4")) }));

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
