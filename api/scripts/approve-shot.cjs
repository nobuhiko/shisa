// SPDX-License-Identifier: GPL-2.0-or-later
// 4 系のデモのお店で「承認して直す」を押し、前後を撮る(手元の検証環境だけで使う。ログインはデモの初期値)
// 使い方: PW=<playwright> node api/scripts/approve-shot.cjs <店の URL> <出力の頭(例 video/chk/approve)> [弱いページのパス 例 /order_check]
//   1. 管理画面の Shisa の画面を開き、「店主の承認で直せること」が出るのを待って撮る(-proposal.png)
//   2. 弱いページに、入れた文字がそのまま出るのを撮る(-before.png)
//   3. 「承認して直す」を押し、結果が出るのを待って撮る(-approved.png)
//   4. 弱いページで、入れた文字が escape されて出るのを撮る(-after.png)
const { chromium } = require(process.env.PW || "playwright");

(async () => {
  const [base, out, weak = "/order_check"] = process.argv.slice(2);
  const probe = `${weak}?no=${encodeURIComponent('<b style="color:red">A-1024</b>')}`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/admin/login`);
  await page.fill('input[name="login_id"]', "admin");
  await page.fill('input[name="password"]', "password");
  await Promise.all([page.waitForNavigation(), page.press('input[name="password"]', "Enter")]);

  const shop = await ctx.newPage();
  await shop.goto(base + probe);
  const rawBefore = await shop.content();
  await shop.screenshot({ path: `${out}-before.png` });

  await page.goto(`${base}/admin/store/plugin/SelfHarden/config`);
  await page.waitForSelector("#sh-fix-card:not([hidden]) .sh-approve-btn", { timeout: 60000 });
  const card = page.locator("#sh-fix-card");
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: `${out}-proposal.png` });
  await page.click(".sh-approve-btn");
  await page.waitForFunction(() => window.__shApproved, null, { timeout: 90000 });
  const status = await page.evaluate(() => window.__shApproved);
  await card.screenshot({ path: `${out}-approved.png` });

  await shop.goto(base + probe);
  const rawAfter = await shop.content();
  await shop.screenshot({ path: `${out}-after.png` });
  console.log(JSON.stringify({
    status,
    before_raw_tag: rawBefore.includes('<b style="color:red">A-1024</b>'),
    after_escaped: rawAfter.includes("&lt;b style=") && !rawAfter.includes('<b style="color:red">A-1024</b>'),
    result: await page.locator(".sh-fix-result").first().textContent(),
  }));
  await browser.close();
})();
