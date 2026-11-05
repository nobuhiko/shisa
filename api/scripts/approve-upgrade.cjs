// SPDX-License-Identifier: GPL-2.0-or-later
// 店主の承認で版上げする流れを、本物の管理画面で押して確かめる(手元のデモのお店だけ)。
// 使い方: PW=<playwright> node api/scripts/approve-upgrade.cjs <店の URL> <スクリーンショットの頭> [録画のフォルダ]
//   ログイン → Shisa の設定画面 → 「承認して上げる」のカード → 確認コードを入れて押す → 終わるまで進み具合を見る
const { chromium } = require(process.env.PW || "playwright");

(async () => {
  const [base, shot, recDir] = process.argv.slice(2);
  const browser = await chromium.launch();
  const opts = { viewport: { width: 1440, height: 1000 } };
  if (recDir) opts.recordVideo = { dir: recDir, size: { width: 1440, height: 1000 } };
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(base + "/admin/login");
  await page.fill('input[name="login_id"]', "admin");
  await page.fill('input[name="password"]', "password");
  await Promise.all([page.waitForNavigation(), page.press('input[name="password"]', "Enter")]);
  await page.goto(base + "/admin/store/plugin/SelfHarden/config");
  // 承認待ちのカード(古い失敗のカードが残っていても、承認ボタンのある方)
  const card = page.locator(".sh-upgrade:has(.sh-approve-btn)").first();
  await card.waitFor({ timeout: 60000 });
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await card.screenshot({ path: `${shot}-card.png` });
  const label = await card.locator(".sh-code-label").innerText();
  const code = (/(\d{4})/.exec(label) || [])[1];
  if (!code) throw new Error("確認コードが見つかりません: " + label);
  await card.locator(".sh-confirm-code").fill(code);
  await card.locator(".sh-approve-btn").click();
  const tApprove = Date.now();
  await page.waitForFunction(() => window.__shApproved !== undefined, null, { timeout: 60000 });
  const started = await page.evaluate(() => window.__shApproved);
  console.log("approve:", started);
  if (started === "failed") {
    // 始められなかった(調べたときからファイルが変わっていた stale など)。様子を写して終わる
    const msg = await card.locator(".sh-fix-result").innerText().catch(() => "");
    console.log("final: not_started", msg);
    await card.screenshot({ path: `${shot}-after.png` }).catch(() => {});
    await ctx.close();
    await browser.close();
    return;
  }
  let mid = false;
  // 終わるまで待つ(進み具合はカードが 3 秒ごとに読み直す)
  for (let i = 0; i < 150; i++) {
    const st = await page.evaluate(() => window.__shUpgrade || null).catch(() => null);
    if (!mid && st === "running") {
      await page.locator(".sh-upgrade").first().screenshot({ path: `${shot}-progress.png` }).catch(() => {});
      mid = true;
    }
    if (st && st !== "running") break;
    await page.waitForTimeout(2000);
  }
  let final = await page.evaluate(() => window.__shUpgrade || null).catch(() => null);
  const gateSeen = await page.evaluate(() => !!window.__shUpgradeGate).catch(() => false);
  // 版上げのあとも管理画面のログインが続いているか(ログインの画面へ回されないか)
  await page.goto(base + "/admin/");
  const loggedIn = !/\/login/.test(page.url());
  console.log("gate seen:", gateSeen, "still logged in:", loggedIn);
  if (final === "relogin" || final === "running" || !loggedIn) {
    // 管理画面を開き直して、終わった様子を読む(版が変わってログインが切れた場合はログインし直す)
    await page.goto(base + "/admin/store/plugin/SelfHarden/config");
    if (/\/login/.test(page.url())) {
      await page.fill('input[name="login_id"]', "admin");
      await page.fill('input[name="password"]', "password");
      await Promise.all([page.waitForNavigation(), page.press('input[name="password"]', "Enter")]);
      await page.goto(base + "/admin/store/plugin/SelfHarden/config");
    }
    await page.waitForFunction(() => window.__shUpgrade && window.__shUpgrade !== "running", null, { timeout: 120000 }).catch(() => {});
    final = await page.evaluate(() => window.__shUpgrade || null).catch(() => null);
  }
  await page.locator(".sh-upgrade").first().scrollIntoViewIfNeeded().catch(() => {});
  await page.locator(".sh-upgrade").first().screenshot({ path: `${shot}-after.png` }).catch(() => {});
  const log = await page.locator(".sh-upgrade .sh-upgrade-log").innerText().catch(() => "");
  console.log("final:", final, "seconds:", ((Date.now() - tApprove) / 1000).toFixed(0), "total:", ((Date.now() - t0) / 1000).toFixed(0));
  console.log(log);
  await ctx.close();
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
