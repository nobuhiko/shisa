// SPDX-License-Identifier: GPL-2.0-or-later
// 動画用: 手元のデモのお店の本物の管理画面で、プラグインを入れる → API とつなぐ → お知らせの URL を貼る、を 1920x1080 で録る
// 使い方: PW=<playwright のパス> node api/scripts/record-admin.cjs <店の URL> <プラグインの zip> <お知らせの URL> <出力ディレクトリ>
// ログインはデモのお店の初期値(demo-servers/common/setup-eccube.sh で入れたもの)。手元の検証環境だけで使う
const { chromium } = require(process.env.PW || "playwright");

(async () => {
  const [base, zip, advisory, out] = process.argv.slice(2);
  const browser = await chromium.launch({ slowMo: 250 });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, recordVideo: { dir: out, size: { width: 1920, height: 1080 } } });
  const page = await ctx.newPage();
  const t0 = Date.now();
  const mark = (name) => console.log("MARK", name, ((Date.now() - t0) / 1000).toFixed(1));
  const pause = (ms) => page.waitForTimeout(ms);

  await page.goto(`${base}/admin/login`);
  mark("login");
  await page.fill('input[name="login_id"]', "admin");
  await page.fill('input[name="password"]', "password");
  await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
  await pause(800);

  // プラグインを入れる(管理画面のアップロード)
  await page.goto(`${base}/admin/store/plugin/install`);
  mark("upload");
  await pause(1200);
  await page.setInputFiles('input[type="file"]', zip);
  await pause(800);
  await Promise.all([page.waitForNavigation({ timeout: 120000 }), page.click('form button[type="submit"]')]);
  await pause(1500);

  // 有効にする
  mark("enable");
  // 最初から入っているプラグインもあるので、Shisa の行の「有効にする」を押す
  const en = page.locator("tr", { hasText: "Shisa" }).locator('a[href$="/enable"]').first();
  await en.scrollIntoViewIfNeeded();
  await pause(800);
  await en.click();
  await page.waitForLoadState("networkidle", { timeout: 120000 });
  await pause(2000);

  // プラグインの画面で API とつなぐ
  await page.goto(`${base}/admin/store/plugin/SelfHarden/config`);
  mark("connect");
  await pause(1500);
  const btn = page.locator('button:has-text("API とつなぐ")');
  await btn.scrollIntoViewIfNeeded();
  await pause(800);
  await Promise.all([page.waitForNavigation({ timeout: 60000 }), btn.click()]);
  await pause(1500);

  // お知らせの URL を貼って渡す
  mark("paste");
  await page.locator("#sh-advisory").scrollIntoViewIfNeeded();
  await page.click("#sh-advisory");
  await page.keyboard.type(advisory, { delay: 25 });
  await pause(800);
  await page.click("#sh-start");
  mark("started");
  await pause(12000);
  mark("end");
  await ctx.close();
  await browser.close();
})();
