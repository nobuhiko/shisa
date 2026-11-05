// SPDX-License-Identifier: GPL-2.0-or-later
// 動画用: 点検の報告で見つけた問題を、見つけた順に 1 行ずつ出す一覧の札(1920x1080 の透明な PNG)
// 使い方: PW=<playwright> node api/scripts/findings-card.cjs <見出し> <項目の JSON 配列> <出力ディレクトリ>
//   出力: base.png(見出しと札の枠だけ)、item-0.png …(その項目の 1 行だけ。枠の中の決まった位置)
//   組み立てで base を出し、項目を見つけた時刻に item-i を重ねていく。札の大きさは全部の項目を入れた大きさで最初から決めるので、足しても動かない
//   置き場は右上(経過の行の上、右下の「点検中も営業中」の札とは重ならない)
const { chromium } = require(process.env.PW || "playwright");
const { mkdirSync } = require("node:fs");
const { join } = require("node:path");
(async () => {
  const [title, itemsJson, out] = process.argv.slice(2);
  const items = JSON.parse(itemsJson);
  mkdirSync(out, { recursive: true });
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.setContent(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}
    .c{position:fixed;right:40px;top:118px;width:720px;box-sizing:border-box;background:rgba(20,30,44,.9);color:#fff;border-radius:14px;padding:20px 28px 22px;box-shadow:0 8px 32px rgba(0,0,0,.35)}
    h2{margin:0 0 10px;font:700 27px "Hiragino Sans","Noto Sans JP",sans-serif;color:#ffcc80}
    ol{margin:0;padding:0 0 0 1.5em;font:600 24px/1.42 "Hiragino Sans","Noto Sans JP",sans-serif} li{margin:3px 0}
    body.only .c{background:transparent;box-shadow:none} body.only h2{visibility:hidden} body.only li{visibility:hidden} body.only li.on{visibility:visible}
    body.base li{visibility:hidden}</style>
    <div class="c"><h2></h2><ol></ol></div>`);
  await p.evaluate(([t, xs]) => {
    document.querySelector("h2").textContent = t;
    const ol = document.querySelector("ol");
    for (const x of xs) { const li = document.createElement("li"); li.textContent = x; ol.appendChild(li); }
  }, [title, items]);
  await p.evaluate(() => { document.body.className = "base"; });
  await p.screenshot({ path: join(out, "base.png"), omitBackground: true });
  for (let i = 0; i < items.length; i++) {
    await p.evaluate((k) => {
      document.body.className = "only";
      document.querySelectorAll("li").forEach((li, j) => li.classList.toggle("on", j === k));
    }, i);
    await p.screenshot({ path: join(out, `item-${i}.png`), omitBackground: true });
  }
  process.exit(0);
})();
