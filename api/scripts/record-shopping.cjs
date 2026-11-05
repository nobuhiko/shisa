// SPDX-License-Identifier: GPL-2.0-or-later
// 動画用: 点検と同じ時間に、お客さんとしてお店で買い物を続け、その記録を残す(お店が止まっていないことを、動画の札で見せる)。手元のデモのお店だけで使う
// 使い方: PW=<playwright> node api/scripts/record-shopping.cjs <店の URL> <出力ディレクトリ> <録る秒数>
//   1 周 = トップ → 商品一覧 → 商品詳細 → カートに入れる → カート → レジに進む → ゲスト購入(見本の名前・住所)→ ご注文手続き → 確認 → ご注文完了
//   周ごとにクッキーを消す(カートとゲストの情報を空にする)。注文はデモのお店のデータベースに本当に入る
//   メンテナンス中(503)やエラーになったら、その周はやめて、少し待ってトップからやり直す(隠さずに記録する)
// 出力: marks.json(wall_start・wall_end = 時計(ミリ秒)、pages = 開いた画面ごとの { at, step, url, status }、orders = 注文が完了した時刻の一覧)
const { chromium } = require(process.env.PW || "playwright");
const { writeFileSync, mkdirSync } = require("node:fs");

(async () => {
  const [base, out, secs] = process.argv.slice(2);
  mkdirSync(out, { recursive: true });
  const until = Date.now() + Number(secs || 60) * 1000;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const wall_start = Date.now();
  const pages = [], orders = [];
  const save = () => writeFileSync(`${out}/marks.json`, JSON.stringify({ wall_start, wall_end: Date.now(), pages, orders }, null, 1));
  const log = (step, status, extra) => { pages.push({ at: Date.now(), step, url: page.url().replace(base, ""), status, ...(extra || {}) }); };
  // 画面を開く/ボタンを押したあとの状態(HTTP の状態)を取る。500 番台なら止める
  const ok = (step, resp) => {
    const st = resp ? resp.status() : null;
    log(step, st);
    if (st && st >= 500) throw new Error(`${step}: ${st}`);
  };
  const go = async (step, url) => ok(step, await page.goto(url, { timeout: 20000 }));
  const click = async (step, locator) => {
    const [resp] = await Promise.all([page.waitForNavigation({ timeout: 20000 }).catch(() => null), locator.first().click({ timeout: 5000 })]);
    ok(step, resp);
  };
  const rest = () => page.waitForTimeout(1200);
  let loop = 0;
  while (Date.now() < until) {
    try {
      await ctx.clearCookies();
      await go("top", `${base}/`); await rest();
      await go("list", `${base}/products/list`); await rest();
      const hrefs = [...new Set(await page.locator('a[href*="/products/detail/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href"))))];
      if (!hrefs.length) throw new Error("商品が無い");
      await go("detail", new URL(hrefs[loop % hrefs.length], base).toString()); await rest();
      // 規格のある商品は最初の選択肢を選ぶ
      for (const sel of await page.locator("select[name^='classcategory_id']").all()) {
        if ((await sel.locator("option").count()) > 1) await sel.selectOption({ index: 1 });
      }
      await page.locator("button.add-cart").first().click({ timeout: 5000 });
      await page.waitForTimeout(1500);
      log("add-cart", null);
      await go("cart", `${base}/cart`); await rest();
      await click("buystep", page.locator("a[href*='/cart/buystep/']")); await rest();
      await click("nonmember", page.locator("a[href*='/shopping/nonmember']"));
      const f = (n, v) => page.fill(`[name="nonmember[${n}]"]`, v);
      await f("name][name01", "見本"); await f("name][name02", "花子"); await f("kana][kana01", "ミホン"); await f("kana][kana02", "ハナコ");
      await f("postal_code", "1000001"); await page.selectOption('[name="nonmember[address][pref]"]', { index: 13 });
      await f("address][addr01", "千代田区千代田"); await f("address][addr02", "1-1"); await f("phone_number", "0300000000");
      await f("email][first", "demo@example.com"); await f("email][second", "demo@example.com");
      await click("shopping", page.locator("button.ec-blockBtn--action")); await rest();
      await click("confirm", page.locator("button.ec-blockBtn--action")); await rest();
      await click("complete", page.locator("button.ec-blockBtn--action"));
      const done = /ご注文ありがとうございました/.test(await page.content());
      if (!done) throw new Error("完了の画面が出ない");
      orders.push(Date.now());
      pages[pages.length - 1].order = true;
      await rest();
    } catch (e) {
      pages.push({ at: Date.now(), step: "error", url: page.url().replace(base, ""), error: e.message.split("\n")[0] });
      await page.waitForTimeout(2000);
    }
    loop++;
    save();
  }
  save();
  await browser.close();
  const bad = pages.filter((p) => p.error || (p.status && p.status >= 500));
  console.log(`録った: ${((Date.now() - wall_start) / 1000).toFixed(0)} 秒、画面 ${pages.length}、注文 ${orders.length} 件、うまくいかなかったもの ${bad.length}`);
})();
