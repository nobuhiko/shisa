// SPDX-License-Identifier: GPL-2.0-or-later
// 動画用: プラグインの管理画面の撮影モードを 1920x1080 で録る。お知らせの URL を打ち込んで「通知を渡す」を押す所作から、記録の早送りの終わりまで
// 使い方: [FLOW=<倍率>] PW=<playwright> node api/scripts/record-film.cjs <店の URL> <記録の ID> <お知らせの URL> <止めどころの長さ(ms)> <出力ディレクトリ>
// 出力: 録画(webm)と marks.json(録画の頭からの秒: paste=貼り始め、start=押した、stops=止めどころ、end=健康診断の表)
// ログインはデモのお店の初期値。手元の検証環境だけで使う
const { chromium } = require(process.env.PW || "playwright");
const { writeFileSync } = require("node:fs");

(async () => {
  const [base, run, advisory, hold, out] = process.argv.slice(2);
  const browser = await chromium.launch();
  // ログインは録画しない
  const pre = await browser.newContext();
  const lp = await pre.newPage();
  await lp.goto(`${base}/admin/login`);
  await lp.fill('input[name="login_id"]', "admin");
  await lp.fill('input[name="password"]', "password");
  await Promise.all([lp.waitForNavigation(), lp.click('button[type="submit"]')]);
  const state = await pre.storageState();
  await pre.close();

  const ctx = await browser.newContext({ storageState: state, viewport: { width: 1920, height: 1080 }, recordVideo: { dir: out, size: { width: 1920, height: 1080 } } });
  const t0 = Date.now();
  const page = await ctx.newPage();
  const sec = (t) => +((t - t0) / 1000).toFixed(2);
  const marks = {};
  await page.goto(`${base}/admin/store/plugin/SelfHarden/config?film=${run}&big=1&hold=${hold.split(",")[0] === hold ? hold : 1200}&holds=${hold.includes(",") ? hold : ""}${process.env.FLOW ? `&flow=${process.env.FLOW}` : ""}`);
  await page.waitForTimeout(1500);
  marks.ready = sec(Date.now());
  await page.click("#sh-advisory");
  marks.paste = sec(Date.now());
  await page.keyboard.type(advisory, { delay: 18 });
  await page.waitForTimeout(600);
  await page.click("#sh-start");
  marks.start = sec(Date.now());
  await page.waitForFunction(() => { const r = document.getElementById("sh-report"); return r && !r.hidden; }, null, { timeout: 900000, polling: 250 });
  marks.report = sec(Date.now());
  await page.waitForTimeout(500);
  const h = page.locator("#sh-health-card");
  if (await h.count()) await h.scrollIntoViewIfNeeded();
  marks.end = sec(Date.now());
  await page.waitForTimeout(14000);
  const stops = await page.evaluate(() => window.__shStops || []);
  marks.stops = stops.map((s) => ({ at: sec(s.t), text: s.text }));
  marks.total = sec(Date.now());
  writeFileSync(`${out}/marks.json`, JSON.stringify(marks, null, 1));
  console.log(JSON.stringify(marks.stops.map((s) => `${s.at} ${s.text}`), null, 1));
  await ctx.close();
  await browser.close();
})();
