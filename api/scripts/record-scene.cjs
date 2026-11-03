// 1 つの場面を 1920x1080 で録る: PW=<playwright> node api/scripts/record-scene.cjs <scene> <出力ディレクトリ> <始まりの目印の CSS> <終わりの title の頭>
// 出た TRIM 秒を ffmpeg -ss で切ると、場面の頭(=ナレーションの頭)にそろう
const { chromium } = require(process.env.PW || "playwright");
(async () => {
  const [scene, out, startSel, doneTitle] = process.argv.slice(2);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: out, size: { width: 1920, height: 1080 } } });
  const t0 = Date.now();
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:8787/demo?scene=${scene}&clean=1`);
  await page.waitForSelector(startSel, { timeout: 20000 });
  console.log("TRIM", ((Date.now() - t0) / 1000).toFixed(2));
  await page.waitForFunction((p) => document.title.startsWith(p), doneTitle, { timeout: 600000, polling: 200 });
  console.log(await page.title());
  await page.waitForTimeout(800);
  await ctx.close(); await browser.close();
})();
