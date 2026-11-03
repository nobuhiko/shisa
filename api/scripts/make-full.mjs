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
const SHOP = "http://127.0.0.1:8082", RUN = "run_8b6975cd6a0135d2", ADV = "https://www.kagoya.jp/news/2026102337094/";
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
const RULES = [[/当てはま/, ["sho1"]], [/500/, ["sho2", "sho3"]], [/別の手/, ["sho4"]], [/本番の /, ["sho5"]], [/開けたまま守/, ["sho6"]], [/公式の中身に戻した/, ["ten0", "ten1"]], [/EC-CUBE を、/, ["ten2"]]];
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

// 3. 承・転: 録画の「貼る前」から「健康診断の表 + 結の 1 行目」まで。止めどころに行を置く
const S = Math.max(0, marks.ready - 0.4);
const k0 = clip.ketsu0.d;
const E = marks.end + k0 + 0.8;
const place = [{ at: marks.paste - S, k: "sho0" }];
for (const [i, keys] of Object.entries(MAP)) { let t = marks.stops[i].at - S + 0.15; for (const k of keys) { place.push({ at: t, k }); t += clip[k].d; } }
place.push({ at: marks.end - S + 0.3, k: "ketsu0" });
const inputs = place.flatMap((p) => ["-i", clip[p.k].file]);
const filt = place.map((p, i) => `[${i + 1}:a]adelay=${Math.round(p.at * 1000)}|${Math.round(p.at * 1000)},aresample=48000[a${i}]`).join(";") + ";" + place.map((_, i) => `[a${i}]`).join("") + `amix=inputs=${place.length}:normalize=0,apad[aout]`;
ff("-ss", String(S), "-t", String(E - S), "-i", webm, ...inputs, "-filter_complex", filt, "-map", "0:v", "-map", "[aout]", "-t", String(E - S), "-r", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-c:a", "aac", "-ar", "48000", "-ac", "2", join(out, "3-film.mp4"));

// 4. 導入: 絵コンテで撮った管理画面を、ナレーションの長さで並べる(仮。本物の操作は後で撮る)
const introA = join(out, "intro.wav");
writeFileSync(join(out, "intro.list"), ["intro0", "intro1"].map((k) => `file '${clip[k].file}'`).join("\n"));
ff("-f", "concat", "-safe", "0", "-i", join(out, "intro.list"), "-c", "copy", introA);
const iD = dur(introA), stills = ["intro-1-upload", "intro-2-list", "intro-3-connect"].map((n) => join(W, "board", n + ".png"));
const per = iD / stills.length;
ff(...stills.flatMap((s) => ["-loop", "1", "-t", String(per), "-i", s]), "-i", introA, "-filter_complex", stills.map((_, i) => `[${i}:v]scale=1920:1080,fps=30[v${i}]`).join(";") + ";" + stills.map((_, i) => `[v${i}]`).join("") + `concat=n=${stills.length}:v=1:a=0[v]`, "-map", "[v]", "-map", `${stills.length}:a`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", join(out, "2-intro.mp4"));

// 5. 結の 2〜3 行目: 屋根にシーサーの絵(起の最後のコマ)
const roof = join(out, "roof.png"); ff("-sseof", "-0.5", "-i", join(W, "ki-v3.mp4"), "-frames:v", "1", roof);
writeFileSync(join(out, "end.list"), ["ketsu1", "ketsu2"].map((k) => `file '${clip[k].file}'`).join("\n"));
const endA = join(out, "end.wav"); ff("-f", "concat", "-safe", "0", "-i", join(out, "end.list"), "-c", "copy", endA);
ff("-loop", "1", "-i", roof, "-i", endA, "-vf", "scale=1920:1080,fps=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", join(out, "4-end.mp4"));

// 6. 起をそろえて、つなぐ
ff("-i", join(W, "ki-v3.mp4"), "-vf", "fps=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-c:a", "aac", "-ar", "48000", "-ac", "2", join(out, "1-ki.mp4"));
writeFileSync(join(out, "all.list"), ["1-ki", "2-intro", "3-film", "4-end"].map((n) => `file '${join(out, n + ".mp4")}'`).join("\n"));
ff("-f", "concat", "-safe", "0", "-i", join(out, "all.list"), "-c", "copy", "-movflags", "+faststart", join(W, "full-v1.mp4"));
console.log("full-v1.mp4", dur(join(W, "full-v1.mp4")).toFixed(1), "秒", JSON.stringify({ ki: dur(join(out, "1-ki.mp4")), intro: dur(join(out, "2-intro.mp4")), film: dur(join(out, "3-film.mp4")), end: dur(join(out, "4-end.mp4")) }));
