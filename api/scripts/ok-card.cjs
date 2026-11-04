// 「でも、大丈夫。」の重ね絵: 1920x1080 の PNG(うすい紺の幕 + 阿吽のシーサー + 大きな文字)。本物の管理画面の録画に重ねてフェードで消す
// 使い方: PW=<playwright> node api/scripts/ok-card.cjs <文> <シーサーの SVG> <出力.png>
const { chromium } = require(process.env.PW || "playwright");
const { readFileSync } = require("node:fs");
(async () => {
  const [text, svg, out] = process.argv.slice(2);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.setContent(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}
    .v{position:fixed;inset:0;background:rgba(13,23,42,.82);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:36px}
    .v svg{width:520px;height:auto}
    b{font:700 132px "Hiragino Sans","Noto Sans JP",sans-serif;color:#fff;text-shadow:0 4px 24px rgba(0,0,0,.6);letter-spacing:.04em}</style>
    <div class="v">${readFileSync(svg, "utf8")}<b></b></div>`);
  await p.$eval("b", (e, t) => { e.textContent = t; }, text);
  await p.screenshot({ path: out, omitBackground: true });
  process.exit(0);
})();
