// SPDX-License-Identifier: GPL-2.0-or-later
// 通しの 1 本を組み立てる(手元だけ): 起(できている mp4)+ 導入(画面を並べる)+ 承・転(撮影モードの録画に、止めどころごとにナレーションを置く)+ 結
// 使い方: PW=<playwright> node api/scripts/make-full.mjs <作業ディレクトリ(video/)>
// 前提: VOICEVOX が 127.0.0.1:50021、デモのお店 B が 8082、起の video/ki-v3.mp4、絵コンテの video/board/*.png
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const W = (await import("node:path")).resolve(process.argv[2]);
const ROOT = new URL("../..", import.meta.url).pathname;
const story = JSON.parse(readFileSync(join(ROOT, "api/demo/story.json"), "utf8"));
const N = story.narration;
const voice = N.voice;
const SHOP = "http://127.0.0.1:8082", RUN = process.env.RUN || "run_8b6975cd6a0135d2", ADV = process.env.ADV;
if (!ADV) throw new Error("ADV にお知らせの URL を入れてください");
const out = join(W, "full"); mkdirSync(out, { recursive: true });
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"] }).toString();
const ff = (...a) => sh("ffmpeg", ["-y", "-loglevel", "error", ...a]);
const dur = (f) => Number(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).trim());

// 1. 1 行ずつ音声に
const clip = {};
for (const sec of ["intro", "sho", "ten", "ketsu"]) N[sec].forEach((l, i) => {
  const key = `${sec}${i}`, f = join(out, key);
  execFileSync("node", [join(ROOT, "api/scripts/tts.mjs"), String(voice.speaker_id), f, JSON.stringify([{ text: l.read ?? l.text, pause: l.pause }])], { env: { ...process.env, ACCENTS: JSON.stringify(voice.accents) } });
  clip[key] = { file: f + ".wav", d: dur(f + ".wav") };
});

// 2. 止めどころ(撮影モードで止まる順)ごとに読む行。止まる長さは読む行の長さの合計
// 止めどころは帯の言葉で探す(番号は記録や撮影モードの直しでずれるので)。まず短く流して、止まる順を取る
const RULES = [[/当てはま/, ["sho1"]], [/500/, ["sho2", "sho3"]], [/別の手|500.*(効く|効き)|(効く|効き).*500/, ["sho4"]], [/本番の /, ["sho5"]], [/開けたまま守|閉めずに|営業を続け/, ["sho6"]], [/公式の中身に戻した/, ["ten0", "ten1"]], [/EC-CUBE を、/, ["ten2"]]];
const dry = join(out, "dry"); execFileSync("rm", ["-rf", dry]);
sh("node", [join(ROOT, "api/scripts/record-film.cjs"), SHOP, RUN, ADV, Array(30).fill(150).join(","), dry]);
const order = JSON.parse(readFileSync(join(dry, "marks.json"), "utf8")).stops.map((s) => s.text);
const MAP = {}; const used = new Set();
for (const [re, keys] of RULES) { const i = order.findIndex((t, j) => re.test(t) && !used.has(j)); if (i < 0) throw new Error("止めどころが無い: " + re); used.add(i); MAP[i] = keys; }
const holds = order.map((_, i) => (MAP[i] ? Math.round(MAP[i].reduce((a, k) => a + clip[k].d, 0) * 1000 + 300) : 1200));
console.log(order.map((t, i) => `${i} ${MAP[i] ? MAP[i].join("+") : "-"} ${t}`).join("\n"));
const fdir = join(out, "film"); execFileSync("rm", ["-rf", fdir]);
sh("node", [join(ROOT, "api/scripts/record-film.cjs"), SHOP, RUN, ADV, holds.join(","), fdir]);
const marks = JSON.parse(readFileSync(join(fdir, "marks.json"), "utf8"));
const webm = join(fdir, readdirSync(fdir).find((f) => f.endsWith(".webm")));

// 3. 承・転: 録画の「通知を渡す」を押したところ(貼る所作は導入の本物の操作で見せる)から「健康診断の表 + 結の 1 行目」まで。止めどころに行を置く
const S = Math.max(0, marks.start - 0.3);
const k0 = clip.ketsu0.d;
// 健康診断の表は 0.7 秒ずつ行が埋まる(7 行で約 5.5 秒)。埋まりきって少し置くまで流す
const E = Math.min(marks.total - 0.3, marks.end + Math.max(k0 + 1.0, 12));
const place = [];
for (const [i, keys] of Object.entries(MAP)) { let t = marks.stops[i].at - S + 0.15; for (const k of keys) { place.push({ at: t, k }); t += clip[k].d; } }
place.push({ at: marks.end - S + 0.3, k: "ketsu0" });
const inputs = place.flatMap((p) => ["-i", clip[p.k].file]);
const filt = place.map((p, i) => `[${i + 1}:a]adelay=${Math.round(p.at * 1000)}|${Math.round(p.at * 1000)},aresample=48000[a${i}]`).join(";") + ";" + place.map((_, i) => `[a${i}]`).join("") + `amix=inputs=${place.length}:normalize=0,apad[aout]`;
ff("-ss", String(S), "-t", String(E - S), "-i", webm, ...inputs, "-filter_complex", filt, "-map", "0:v", "-map", "[aout]", "-t", String(E - S), "-r", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-c:a", "aac", "-ar", "48000", "-ac", "2", join(out, "3-film.mp4"));

// 4. 導入: 本物の管理画面の操作の録画(video/admin)。プラグインを上げる → 有効にする → つなぐ → お知らせの URL を貼って「通知を渡す」。
// 貼った URL(サーバー会社の名前が入る)の入力欄は、打ち始めからぼかす
const adir = join(W, "admin"), am = JSON.parse(readFileSync(join(adir, "marks.json"), "utf8"));
const awebm = join(adir, readdirSync(adir).find((f) => f.endsWith(".webm")));
const A0 = Math.max(0, am.login - 0.2), A1 = am.started + 1.2;
const iplace = [{ at: 0.6, k: "intro0" }, { at: 0.6 + clip.intro0.d, k: "intro1" }, { at: Math.max(am.paste - A0, 0.6 + clip.intro0.d + clip.intro1.d), k: "sho0" }];
const ilen = Math.max(A1 - A0, iplace[2].at + clip.sho0.d + 0.3);
const blurFrom = (am.paste - A0).toFixed(2);
ff("-ss", String(A0), "-t", String(A1 - A0), "-i", awebm, ...iplace.flatMap((p) => ["-i", clip[p.k].file]),
  "-filter_complex",
  `[0:v]split[base][cp];[cp]crop=1100:40:248:312,boxblur=8:3[bl];[base][bl]overlay=248:312:enable='gte(t,${blurFrom})',tpad=stop_mode=clone:stop_duration=${Math.max(0, ilen - (A1 - A0)).toFixed(2)}[v];` +
  iplace.map((p, i) => `[${i + 1}:a]adelay=${Math.round(p.at * 1000)}|${Math.round(p.at * 1000)},aresample=48000[ia${i}]`).join(";") + ";" + iplace.map((_, i) => `[ia${i}]`).join("") + `amix=inputs=${iplace.length}:normalize=0,apad[ia]`,
  "-map", "[v]", "-map", "[ia]", "-t", String(ilen), "-r", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-c:a", "aac", "-ar", "48000", "-ac", "2", join(out, "2-intro.mp4"));

// 5. 結の 2〜4 行目: 版の違う店の健康診断 → 志の 1 行 → 屋根のシーサーと名前(再生の画面の場面 KE を録る)
const kd = ["ketsu1", "ketsu2", "ketsu3"].map((k) => clip[k].d.toFixed(2));
const kdir = join(out, "ke"); execFileSync("rm", ["-rf", kdir]);
const krec = sh("node", [join(ROOT, "api/scripts/record-scene.cjs"), `KE&d=${kd.join(",")}`, kdir, ".kv-layer.in", "結"]);
const ktrim = (/TRIM ([0-9.]+)/.exec(krec) ?? [])[1] ?? "0";
writeFileSync(join(out, "end.list"), ["ketsu1", "ketsu2", "ketsu3"].map((k) => `file '${clip[k].file}'`).join("\n"));
const endA = join(out, "end.wav"); ff("-f", "concat", "-safe", "0", "-i", join(out, "end.list"), "-c", "copy", endA);
const kwebm = join(kdir, readdirSync(kdir).find((f) => f.endsWith(".webm")));
ff("-ss", ktrim, "-i", kwebm, "-i", endA, "-map", "0:v", "-map", "1:a", "-r", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", join(out, "4-end.mp4"));

// 6. 起をそろえて、つなぐ
ff("-i", join(W, "ki-v3.mp4"), "-vf", "fps=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-c:a", "aac", "-ar", "48000", "-ac", "2", join(out, "1-ki.mp4"));
writeFileSync(join(out, "all.list"), ["1-ki", "2-intro", "3-film", "4-end"].map((n) => `file '${join(out, n + ".mp4")}'`).join("\n"));
ff("-f", "concat", "-safe", "0", "-i", join(out, "all.list"), "-c", "copy", "-movflags", "+faststart", join(W, "full-v1.mp4"));
console.log("full-v1.mp4", dur(join(W, "full-v1.mp4")).toFixed(1), "秒", JSON.stringify({ ki: dur(join(out, "1-ki.mp4")), intro: dur(join(out, "2-intro.mp4")), film: dur(join(out, "3-film.mp4")), end: dur(join(out, "4-end.mp4")) }));
