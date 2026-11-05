// SPDX-License-Identifier: GPL-2.0-or-later
// 動画の 0 秒の場面(場面 O: 応募先の名前「Built with Claude: Japan 2026」)を 1920x1080 で録る
// 使い方: PW=<playwright> node api/scripts/record-opening.cjs <出力ディレクトリ> <長さ(秒)>
//   TRIM(録画の頭から、名前が出始めるまでの秒)を出す。make-v4.mjs がそこから切る
const { chromium } = require(process.env.PW || "playwright");
(async () => {
  const [out, secs] = process.argv.slice(2);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: out, size: { width: 1920, height: 1080 } } });
  const t0 = Date.now();
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:8787/demo?scene=O&clean=1");
  await page.waitForSelector(".opening b", { timeout: 20000 });
  console.log("TRIM", ((Date.now() - t0) / 1000).toFixed(2));
  await page.waitForTimeout(Number(secs || 3.2) * 1000 + 600);
  await ctx.close(); await browser.close();
})();
