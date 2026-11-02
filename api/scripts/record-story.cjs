// 通しの 1 本を、ブラウザの画面だけ 1920x1080 で録る(手元の /demo を開くだけ)
// 使い方: PW=<playwright のパス> node api/scripts/record-story.cjs <run_id> <出力ディレクトリ>。出た TRIM 秒を ffmpeg -ss で切る
const { chromium } = require(process.env.PW || "playwright");
(async () => {
  const run = process.argv[2];
  const out = process.argv[3];
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: out, size: { width: 1920, height: 1080 } } });
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:8787/demo?scene=story&run=${run}&clean=1`);
  // 録画の頭の、最初の場面が出るまでを切るための秒数(冒頭の文字が出始める少し前から)
  await page.waitForSelector(".opening b.in", { timeout: 20000 });
  console.log("TRIM", Math.max(0, (Date.now() - t0) / 1000 - 0.4).toFixed(1));
  await page.waitForFunction(() => document.title.startsWith("通し"), null, { timeout: 400000, polling: 1000 });
  console.log(await page.title());
  await page.waitForTimeout(1500);
  await ctx.close();
  await browser.close();
})();
