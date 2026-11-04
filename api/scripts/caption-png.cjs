// 字幕を 1920x1080 の透明な PNG にする(ffmpeg に文字を描く機能が無いので、本物の画面の録画に重ねる用)
// 使い方: PW=<playwright> node api/scripts/caption-png.cjs <文> <出力.png>
// 見た目は場面 V・KE の字幕(.kv-cap)にそろえ、明るい管理画面の上でも読めるよう、うすい黒の帯を敷く
const { chromium } = require(process.env.PW || "playwright");
(async () => {
  const [text, out] = process.argv.slice(2);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.setContent(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}
    div{position:fixed;left:0;right:0;bottom:43px;text-align:center}
    span{display:inline-block;font:32px "Hiragino Sans","Noto Sans JP",sans-serif;color:#fff;text-shadow:0 2px 8px rgba(0,0,0,.8);background:rgba(13,23,42,.72);padding:10px 28px;border-radius:10px}</style>
    <div><span></span></div>`);
  await p.$eval("span", (e, t) => { e.textContent = t; }, text);
  await p.screenshot({ path: out, omitBackground: true });
  process.exit(0);
})();
