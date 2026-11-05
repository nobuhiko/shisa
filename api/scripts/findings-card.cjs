// SPDX-License-Identifier: GPL-2.0-or-later
// 動画用: 点検の報告で見つけた問題を、短い言葉の一覧にして 1920x1080 の透明な PNG にする(経過の上に重ねる)
// 使い方: PW=<playwright> node api/scripts/findings-card.cjs <見出し> <項目の JSON 配列> <出力.png>
const { chromium } = require(process.env.PW || "playwright");
(async () => {
  const [title, itemsJson, out] = process.argv.slice(2);
  const items = JSON.parse(itemsJson);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.setContent(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}
    .c{position:fixed;left:50%;top:46%;transform:translate(-50%,-50%);background:rgba(20,30,44,.94);color:#fff;border-radius:18px;padding:36px 56px 40px;box-shadow:0 12px 48px rgba(0,0,0,.45);min-width:980px}
    h2{margin:0 0 22px;font:700 40px "Hiragino Sans","Noto Sans JP",sans-serif;color:#ffcc80}
    ol{margin:0;padding:0 0 0 1.4em;font:600 36px/1.65 "Hiragino Sans","Noto Sans JP",sans-serif;white-space:nowrap}</style>
    <div class="c"><h2></h2><ol></ol></div>`);
  await p.evaluate(([t, xs]) => {
    document.querySelector("h2").textContent = t;
    const ol = document.querySelector("ol");
    for (const x of xs) { const li = document.createElement("li"); li.textContent = x; ol.appendChild(li); }
  }, [title, items]);
  await p.screenshot({ path: out, omitBackground: true });
  process.exit(0);
})();
