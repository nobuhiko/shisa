// SPDX-License-Identifier: GPL-2.0-or-later
// 動画の「バージョンアップのあと」の場面を録る(手元の検証環境だけで使う。ログインはデモの初期値)
// 管理画面の「システム情報」を開き、EC-CUBE のバージョンの行に寄せて見せる(上がったことを本物の画面で見せる)
// 使い方: PW=<playwright> node api/scripts/record-sysinfo.cjs <店の URL> <出力ディレクトリ> <長さ(秒)> [shot.png]
//   録画の頭はページを開く前の白い画面なので、ページが落ち着いた時刻(壁時計)を「READY <秒>」で出す。組み立てではそこから切り出す
const { chromium } = require(process.env.PW || "playwright");
const { mkdirSync } = require("node:fs");

(async () => {
  const [base, out, secs, shot] = process.argv.slice(2);
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const pre = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const lp = await pre.newPage();
  await lp.goto(`${base}/admin/login`);
  await lp.fill('input[name="login_id"]', "admin");
  await lp.fill('input[name="password"]', "password");
  await Promise.all([lp.waitForNavigation(), lp.press('input[name="password"]', "Enter")]);
  const state = await pre.storageState();
  await pre.close();

  const ctx = await browser.newContext({ storageState: state, viewport: { width: 1920, height: 1080 }, recordVideo: shot ? undefined : { dir: out, size: { width: 1920, height: 1080 } } });
  const t0 = Date.now();
  const page = await ctx.newPage();
  await page.goto(`${base}/admin/setting/system/system`);
  await page.waitForLoadState("networkidle");
  // EC-CUBE のバージョンの行を目立たせる
  await page.evaluate(() => {
    document.body.style.zoom = "1.5"; // 字を大きく(承認の場面と同じくらい)
    // 「EC-CUBE」と書いた見出しの行(div の並び)を探して、緑の枠で囲む
    const label = [...document.querySelectorAll("body *")].find((e) => e.children.length === 0 && e.textContent.trim() === "EC-CUBE");
    const row = label && label.closest(".row");
    if (row) { row.style.outline = "4px solid #22c55e"; row.style.outlineOffset = "4px"; row.style.background = "#ecfdf5"; row.style.borderRadius = "6px"; }
  });
  await page.waitForTimeout(400);
  if (shot) { await page.screenshot({ path: shot }); await browser.close(); return; }
  console.log("READY", ((Date.now() - t0) / 1000).toFixed(2));
  await page.waitForTimeout(Number(secs) * 1000 + 500);
  await ctx.close();
  await browser.close();
})();
