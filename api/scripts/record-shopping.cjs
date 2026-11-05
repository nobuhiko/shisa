// SPDX-License-Identifier: GPL-2.0-or-later
// 動画用: 点検と同じ時間に、お客さんとしてお店を回る様子を録る(お店が止まっていないことを見せる)。手元のデモのお店だけで使う
// 使い方: PW=<playwright> node api/scripts/record-shopping.cjs <店の URL> <出力ディレクトリ> <録る秒数>
//   商品一覧 → 商品詳細 → カートに入れる → カート → 一覧、を繰り返す。各画面の右上に、その時の時計(時:分:秒)を重ねる。
//   メンテナンス中の画面になっても、そのまま録る(隠さない)
// 出力: 録画(webm)と marks.json(wall_start = 録画の頭の時計(ミリ秒)、wall_end、pages = 開いた画面と HTTP の状態)
const { chromium } = require(process.env.PW || "playwright");
const { writeFileSync } = require("node:fs");

(async () => {
  const [base, out, secs] = process.argv.slice(2);
  const until = Date.now() + Number(secs || 60) * 1000;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: out, size: { width: 1280, height: 720 } } });
  // どの画面にも、右上に今の時計を出す(点検の経過の時計と見比べられるように)
  await ctx.addInitScript(() => {
    const put = () => {
      if (!document.body || document.getElementById("shop-clock")) return;
      const c = document.createElement("div");
      c.id = "shop-clock";
      c.style.cssText = "position:fixed;right:12px;top:12px;z-index:2147483647;background:rgba(31,41,51,.92);color:#fff;font:700 22px/1.2 sans-serif;padding:6px 12px;border-radius:6px";
      document.body.appendChild(c);
      const tick = () => { c.textContent = "お客さんの画面 " + new Date().toLocaleTimeString("ja-JP"); };
      tick(); setInterval(tick, 200);
    };
    document.addEventListener("DOMContentLoaded", put);
    setInterval(put, 500);
  });
  const wall_start = Date.now();
  const page = await ctx.newPage();
  const pages = [];
  const visit = async (url) => {
    try { const r = await page.goto(url, { timeout: 20000 }); pages.push({ at: Date.now(), url, status: r ? r.status() : null }); }
    catch (e) { pages.push({ at: Date.now(), url, error: e.message.split("\n")[0] }); }
    await page.waitForTimeout(1500);
  };
  let loop = 0;
  while (Date.now() < until) {
    // 毎回ちがう商品を見る。数回ごとにクッキーを消して、カートを空にする(1 つの商品を買い続けると販売制限の表示になるため)
    if (loop > 0 && loop % 3 === 0) await ctx.clearCookies();
    await visit(`${base}/products/list`);
    let detail = null;
    try {
      const hrefs = [...new Set(await page.locator('a[href*="/products/detail/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href"))))];
      detail = hrefs.length ? hrefs[loop % hrefs.length] : null;
    } catch (e) {}
    loop++;
    if (detail) {
      await visit(new URL(detail, base).toString());
      try {
        // 規格のある商品は最初の選択肢を選ぶ
        for (const sel of await page.locator("select[name^='classcategory_id']").all()) {
          const opts = await sel.locator("option").all();
          if (opts.length > 1) await sel.selectOption({ index: 1 });
        }
        await page.locator("button.add-cart").first().click({ timeout: 3000 });
        pages.push({ at: Date.now(), url: "add-cart" });
        await page.waitForTimeout(1800);
      } catch (e) { pages.push({ at: Date.now(), url: "add-cart", error: e.message.split("\n")[0] }); }
    }
    await visit(`${base}/cart`);
  }
  const wall_end = Date.now();
  await ctx.close();
  await browser.close();
  writeFileSync(`${out}/marks.json`, JSON.stringify({ wall_start, wall_end, pages }, null, 1));
  const bad = pages.filter((p) => p.error || (p.status && p.status >= 500));
  console.log(`録った: ${((wall_end - wall_start) / 1000).toFixed(0)} 秒、画面 ${pages.length}、うまく開けなかったもの ${bad.length}`);
})();
