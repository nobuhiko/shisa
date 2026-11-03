// SPDX-License-Identifier: GPL-2.0-or-later
// 絵コンテ用: 手元のデモのお店の管理画面を撮る。導入の画面と、撮影モードで記録を流したときの止めどころ(下の帯が出たところ)
// 使い方: PW=<playwright> node api/scripts/capture-board.cjs <店の URL> <記録の ID> <お知らせの URL> <出力ディレクトリ>
// ログインはデモのお店の初期値。手元の検証環境だけで使う
const { chromium } = require(process.env.PW || "playwright");
const { mkdirSync, writeFileSync } = require("node:fs");

(async () => {
  const [base, run, advisory, out] = process.argv.slice(2);
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  const shots = [];
  const shot = async (name, note) => { await page.screenshot({ path: `${out}/${name}.png` }); shots.push({ name, note }); };

  await page.goto(`${base}/admin/login`);
  await page.fill('input[name="login_id"]', "admin");
  await page.fill('input[name="password"]', "password");
  await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);

  await page.goto(`${base}/admin/store/plugin/install`);
  await shot("intro-1-upload", "プラグインのアップロード");
  await page.goto(`${base}/admin/store/plugin`);
  await shot("intro-2-list", "プラグインの一覧(有効にする)");
  await page.goto(`${base}/admin/store/plugin/SelfHarden/config?film=${run}&big=1`);
  const connect = page.locator('button:has-text("つなぎ直す"), button:has-text("API とつなぐ")').first();
  await connect.scrollIntoViewIfNeeded();
  await shot("intro-3-connect", "API とつなぐ");
  await page.locator("#sh-advisory").scrollIntoViewIfNeeded();
  await page.fill("#sh-advisory", advisory);
  await shot("intro-4-paste", "お知らせの URL を貼る");

  // 撮影モードで流し、帯の言葉が変わるたびに撮る
  await page.click("#sh-start");
  let last = "", n = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 300000) {
    const band = await page.evaluate(() => { const b = document.getElementById("sh-band"); return b && b.classList.contains("show") ? b.textContent : ""; });
    if (band && band !== last) {
      last = band; n++;
      await page.waitForTimeout(400);
      await shot(`stop-${String(n).padStart(2, "0")}`, band);
    }
    const done = await page.evaluate(() => { const r = document.getElementById("sh-report"); return r && !r.hidden; });
    if (done) break;
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(6000);
  const h = page.locator("#sh-health-card");
  if (await h.count()) { await h.scrollIntoViewIfNeeded(); await page.waitForTimeout(1500); }
  await shot("end-health", "健康診断の表");
  writeFileSync(`${out}/shots.json`, JSON.stringify(shots, null, 1));
  console.log(shots.length, "shots");
  await browser.close();
})();
