// 使い方: ACCENTS='[{"match":"モーラの並び","accent":N}]' node api/scripts/tts.mjs <話者 ID> <出力の頭> '[{"text":"…","pause":700}]'(VOICEVOX を 127.0.0.1:50021 で動かしておく)
// VOICEVOX(手元の 127.0.0.1:50021)で台本を読ませ、文のあいだに間を入れて 1 本の wav にする
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [speaker, out, ...rest] = process.argv.slice(2);
const lines = JSON.parse(rest.join(" "));
const parts = [];
for (const [i, l] of lines.entries()) {
  const q = await (await fetch(`http://127.0.0.1:50021/audio_query?speaker=${speaker}&text=${encodeURIComponent(l.text)}`, { method: "POST" })).json();
  // アクセントの直し(耳で選んだもの): モーラの並びの頭で句を見つけ、アクセントの位置を変えて高さを付け直す
  let touched = false;
  for (const a of JSON.parse(process.env.ACCENTS ?? "[]")) for (const [i, p] of q.accent_phrases.entries()) if (p.moras.map((m) => m.text).join("").startsWith(a.match)) {
    // join: 前の句につなげて 1 つの言葉として読む(「インストール|するだけで」が 2 つに割れて、するで声が上がるのを防ぐ)
    if (a.join && i > 0) { const prev = q.accent_phrases[i - 1]; prev.moras.push(...p.moras); prev.pause_mora = p.pause_mora; p.moras = []; touched = true; continue; }
    if (a.accent) { p.accent = a.accent; touched = true; }
  }
  q.accent_phrases = q.accent_phrases.filter((p) => p.moras.length);
  if (touched) q.accent_phrases = await (await fetch(`http://127.0.0.1:50021/mora_pitch?speaker=${speaker}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(q.accent_phrases) })).json();
  q.speedScale = 1.08; q.postPhonemeLength = (l.pause ?? 700) / 1000;
  const wav = Buffer.from(await (await fetch(`http://127.0.0.1:50021/synthesis?speaker=${speaker}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(q) })).arrayBuffer());
  const f = `${out}.${i}.wav`; writeFileSync(f, wav); parts.push(f);
}
writeFileSync(`${out}.list`, parts.map((p) => `file '${p.split("/").pop()}'`).join("\n"));
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", `${out}.list`, "-c", "copy", `${out}.wav`]);
// 行ごとの長さ(秒、間を含む)を残す。画面の切り替えをこれに合わせる
const durs = parts.map((p) => { const b = execFileSync("afinfo", [p]).toString(); return Number((/estimated duration: ([0-9.]+)/.exec(b) ?? [])[1] ?? 0); });
writeFileSync(`${out}.timing.json`, JSON.stringify(durs));
for (const p of parts) execFileSync("rm", [p]); execFileSync("rm", [`${out}.list`]);
