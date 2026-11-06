// SPDX-License-Identifier: GPL-2.0-or-later
// 仕上がった動画(make-v4.mjs の出力)に合わせて、YouTube に上げる字幕(SRT)を作る(手元だけ)
// 使い方: node api/scripts/make-srt.mjs <動画> <出力.srt>
// 台詞の文は api/demo/story.json の text(画面の字幕と同じ)。時刻は次のように決める
//   承・転・承認・結: make-v4.mjs の記録(video/make-v7.log の place)に置いた時刻がある。区切りの長さもその記録から
//   起・導入: 置いた時刻の記録が無いので、動画の声の切れ目(無音の終わり)を測り、台詞を順に当てはめる。台詞の長さは、その台詞の音声のファイルから
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const [video, outSrt] = process.argv.slice(2);
const ROOT = new URL("../..", import.meta.url).pathname;
const N = JSON.parse(readFileSync(join(ROOT, "api/demo/story.json"), "utf8")).narration;
const V = join(ROOT, "video"), FULL = join(V, "full"), V4 = join(V, "full-v4");
const log = readFileSync(join(V, "make-v7.log"), "utf8");
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 }).toString();
const dur = (f) => Number(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).trim());
const silenceInfo = (f) => {
  let txt = "";
  try { txt = execFileSync("sh", ["-c", `ffmpeg -v info -i "${f}" -af silencedetect=n=-40dB:d=0.15 -f null - 2>&1`], { maxBuffer: 1 << 26 }).toString(); } catch (e) { txt = String(e.stdout || ""); }
  const starts = [...txt.matchAll(/silence_start: ([0-9.]+)/g)].map((m) => Number(m[1]));
  const ends = [...txt.matchAll(/silence_end: ([0-9.]+)/g)].map((m) => Number(m[1]));
  return { starts, ends };
};
// 台詞の音声の、声が出ている長さ(終わりの無音を除く)
const span = (f) => { const d = dur(f), { starts, ends } = silenceInfo(f); const lead = starts[0] === 0 && ends.length ? ends[0] : 0; const tail = starts.length > ends.length ? starts.at(-1) : ends.length && d - ends.at(-1) < 0.05 ? starts.at(-1) : d; return { lead, tail: Math.max(lead + 0.3, tail), d }; };
const speech = (f) => span(f).tail;
const place = (name) => { const m = new RegExp(`^${name} (\\{.*\\})`, "m").exec(log); if (!m) throw new Error(`${name} の記録が make-v7.log に無い`); return JSON.parse(m[1]); };
const lens = JSON.parse(/^full-v7\.mp4 [0-9.]+ 秒 (\{.*\})/m.exec(log)[1]);
const ITRIM = Number(process.env.ITRIM || 0.6), X = 0.4;

const flow = Object.fromEntries([...N.v4.flow, ...N.v4.health].map((l) => [l.key, l]));
const appr = Object.fromEntries(N.v4.approve_upgrade.map((l) => [l.key, l]));
const cues = [];
const add = (start, end, text) => cues.push({ start, end, text: text.replace(/\{mins\}/g, "") });

// 起: 台詞をつなぎ目なしで順に並べている(make-full.mjs)。長さを足していく
const kiEnd = lens.ki, introEnd = kiEnd + lens.intro - ITRIM;
let c = 0;
N.ki.slice(0, -1).forEach((l, i) => { const sp = span(join(FULL, `ki${i}.wav`)); add(c + sp.lead, c + sp.tail, l.text); c += sp.d; });
// 導入: 「でも、大丈夫。」を 0.5 秒から、続けて導入の 2 行。「貼ってみましょう」は貼る操作に合わせて置いているので、声の切れ目で探す
c = kiEnd + 0.5;
for (const [file, text] of [[`ki${N.ki.length - 1}`, N.ki.at(-1).text], ["intro0", N.intro[0].text], ["intro1", N.intro[1].text]]) { const sp = span(join(FULL, `${file}.wav`)); add(c + sp.lead, c + sp.tail, text); c += sp.d; }
{ const { ends: onsets } = silenceInfo(video); const on = onsets.find((t) => t >= c - 0.3 && t < introEnd) ?? c; add(on, on + speech(join(FULL, "sho0.wav")), N.sho[0].text); }

// 承・転: 置いた時刻のとおり
const film = place("承・転");
for (const p of film.place) { const [k, at] = p.split("@"); const t = introEnd + Number(at); add(t, t + speech(join(V4, `${k}.wav`)), flow[k].text); }
// 承認: 早送りのあとに 0.4 秒重ねてつないでいる
const apStart = introEnd + lens.film - X, ap = place("承認\\(版上げ\\)");
for (const p of ap.place) { const [k, at] = p.split("@"); const t = apStart + Number(at); add(t, t + speech(join(V4, `${k}.wav`)), appr[k].text); }
// 結: 1 行目は承認の結果の画面のまま、2〜4 行目は結の場面で続けて読む
let t = apStart + lens.approve;
add(t, t + speech(join(V4, "k0.wav")), N.v4.ketsu0.text); t += dur(join(V4, "k0.wav"));
for (const i of [1, 2, 3]) { const f = join(FULL, `ketsu${i}.wav`); add(t, t + speech(f), N.ketsu[i].text); t += dur(f); }

const ts = (s) => { const ms = Math.round(s * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`; };
cues.sort((a, b) => a.start - b.start);
writeFileSync(outSrt, cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join("\n"));
console.log(cues.map((c) => `${c.start.toFixed(2)}-${c.end.toFixed(2)} ${c.text.slice(0, 24)}`).join("\n"));
