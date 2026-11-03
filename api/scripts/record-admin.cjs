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
  const marks = {};
  const mark = (name) => { marks[name] = +((Date.now() - t0) / 1000).toFixed(1); console.log("MARK", name, marks[name]); require("node:fs").writeFileSync(`${out}/marks.json`, JSON.stringify(marks)); };
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
  // EC-CUBE 4.2.3 以降は、有効にすると自動でメンテナンス中にし、一覧の画面の JS が解除する。その解除が済むまで待つ(済まないとお店が 503 のまま)
  const released = page.waitForResponse((r) => /disable_maintenance/.test(r.url()), { timeout: 60000 }).catch(() => null);
  await en.click();
  await page.waitForLoadState("networkidle", { timeout: 120000 });
  await released;
  await pause(2500);
  for (let i = 0; i < 20; i++) {
    const st = await page.context().request.get(`${base}/`).then((r) => r.status()).catch(() => 0);
    if (st === 200) break;
    await pause(1000);
  }

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
