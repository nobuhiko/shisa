// SPDX-License-Identifier: GPL-2.0-or-later
// 結の素材: 版の違うデモのお店の、本物の管理画面で、撮影モードの早送りの最後(健康診断の表)を撮る
// 使い方: PW=<playwright> node api/scripts/capture-health.cjs <出力ディレクトリ> <名前>=<種類>,<店の URL>,<記録の ID> ...
//   種類: 4(EC-CUBE 4 系)/ 3(3.0)/ 2(2.17)。ログインはデモのお店の初期値。手元の検証環境だけで使う
const { chromium } = require(process.env.PW || "playwright");
const { mkdirSync } = require("node:fs");

const PAGE = {
  4: (b, run) => `${b}/admin/store/plugin/SelfHarden/config?film=${run}&big=1&rs=60&hold=700`,
  3: (b, run) => `${b}/admin/plugin/SelfHarden3/config?film=${run}&big=1&rs=60&hold=700`,
  2: (b, run) => `${b}/admin/load_plugin_config.php?plugin_id=10000&film=${run}&big=1&rs=60&hold=700`,
};
const LOGIN = { 4: "/admin/login", 3: "/admin/login", 2: "/admin/" };

(async () => {
  const [out, ...shops] = process.argv.slice(2);
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  for (const spec of shops) {
    const [name, rest] = spec.split("=");
    const [kind, base, run] = rest.split(",");
    // 動きのまま並べるので、ログインのあとから録画する(早送りの経過 → 健康診断の表が埋まるまで)
    const pre = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    let page = await pre.newPage();
    let ctx = pre, t0 = 0;
    const vdir = `${out}/rec-${name}`;
    try {
      await page.goto(base + LOGIN[kind]);
      await page.fill('input[name="login_id"]', "admin");
      await page.fill('input[name="password"]', "password");
      await Promise.all([page.waitForNavigation(), page.press('input[name="password"]', "Enter")]);
      const state = await pre.storageState();
      ctx = await browser.newContext({ storageState: state, viewport: { width: 1920, height: 1080 }, recordVideo: { dir: vdir, size: { width: 1920, height: 1080 } } });
      t0 = Date.now();
      page = await ctx.newPage();
      await page.goto(PAGE[kind](base, run));
      await page.waitForTimeout(1500);
      await page.fill("#sh-advisory", "https://example.invalid/");
      await page.click("#sh-start");
      await page.waitForFunction(() => document.body.classList.contains("sh-health-focus"), null, { timeout: 300000, polling: 100 });
      const focus = (Date.now() - t0) / 1000;
      await page.waitForTimeout(8000);
      require("node:fs").writeFileSync(`${vdir}/marks.json`, JSON.stringify({ focus }));
      await page.screenshot({ path: `${out}/${name}.png` });
      console.log("ok", name);
    } catch (e) {
      await page.screenshot({ path: `${out}/${name}-error.png` }).catch(() => {});
      console.log("ng", name, e.message.split("\n")[0]);
    }
    await ctx.close();
    if (ctx !== pre) await pre.close();
  }
  await browser.close();
})();
