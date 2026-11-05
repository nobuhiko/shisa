// SPDX-License-Identifier: GPL-2.0-or-later
// 動画の「承認して直す」の場面を録る(手元の検証環境だけで使う。ログインはデモの初期値)。承認は 1 回しかできないので、録るのは一度だけ
// 使い方: PW=<playwright> node api/scripts/record-approve.cjs <店の URL> <出力ディレクトリ> <表を見せる ms> <カードを見せる ms> <押すまで ms> <結果 ms> <直ったページ ms> <トップ ms> [弱いページのパス]
//   0. 早送りの最後と同じ見た目(大きな文字・健康診断に寄せた画面)で、健康診断の表から始めて少し止める(marks.health)
//      → 遅れて読み込まれるものが全部そろって位置が落ち着いてから、ゆっくりスクロールしてカードへ下りる(同じ画面の続きに見せる)
//   1. 「店主の承認で直せること」のカードを見せる(marks.card)
//   2. 画面に出た確認コードを 1 文字ずつ入れて「承認して直す」を押す(marks.code)→ 結果が出る(marks.approved)
//   3. 弱いページ(入れた文字がタグ入り)を開き、文字として出るのを見せる(marks.after)→ お店のトップ(marks.top)
// 時刻は録画の頭からの秒(壁時計)。録画は時計より少し遅れて進むので、組み立てでは録画の長さとの比で伸ばして使う(wall_total)
// お知らせの URL(サーバー会社の名前が入る)は、画面の上でぼかす
const { chromium } = require(process.env.PW || "playwright");
const { mkdirSync, writeFileSync } = require("node:fs");

(async () => {
  const [base, out, healthMs, cardMs, codeMs, resultMs, afterMs, topMs, weak = "/order_check"] = process.argv.slice(2);
  mkdirSync(out, { recursive: true });
  const probe = `${weak}?no=${encodeURIComponent('<b style="color:red">A-1024</b>')}`;
  const browser = await chromium.launch();
  const pre = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const lp = await pre.newPage();
  await lp.goto(`${base}/admin/login`);
  await lp.fill('input[name="login_id"]', "admin");
  await lp.fill('input[name="password"]', "password");
  await Promise.all([lp.waitForNavigation(), lp.press('input[name="password"]', "Enter")]);
  const state = await pre.storageState();
  await pre.close();

  const ctx = await browser.newContext({ storageState: state, viewport: { width: 1920, height: 1080 }, recordVideo: { dir: out, size: { width: 1920, height: 1080 } } });
  const t0 = Date.now();
  const at = () => (Date.now() - t0) / 1000;
  const marks = {};
  const page = await ctx.newPage();
  const hideAdv = () => page.evaluate(() => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const hit = [];
    while (w.nextNode()) if (/kagoya/i.test(w.currentNode.nodeValue)) hit.push(w.currentNode);
    for (const n of hit) { const s = document.createElement("span"); s.style.filter = "blur(5px)"; s.textContent = n.nodeValue; n.parentNode.replaceChild(s, n); }
    document.querySelectorAll("input").forEach((i) => { if (/kagoya/i.test(i.value)) i.style.filter = "blur(5px)"; });
  });
  await page.goto(`${base}/admin/store/plugin/SelfHarden/config?big=1`);
  await page.waitForSelector("#sh-fix-card:not([hidden]) .sh-approve-btn", { timeout: 60000 });
  // 早送りの最後と同じ見た目: 健康診断に寄せる(点検と経過のカードを隠す)。遅れて読み込まれるものはこれで画面の位置を動かさない
  await page.evaluate(() => document.body.classList.add("sh-health-focus"));
  await hideAdv();
  // 位置が落ち着くまで待つ(カードの位置が 1.5 秒続けて変わらないこと)
  let last = -1, still = 0;
  for (let i = 0; i < 60 && still < 3; i++) {
    const y = await page.evaluate(() => Math.round(document.querySelector("#sh-fix-card").getBoundingClientRect().top + window.scrollY));
    still = y === last ? still + 1 : 0; last = y; await page.waitForTimeout(500);
  }
  const hy = await page.evaluate(() => Math.max(0, Math.round(document.querySelector("#sh-health-card").getBoundingClientRect().top + window.scrollY - 24)));
  await page.evaluate((y) => window.scrollTo(0, y), hy);
  await hideAdv();
  await page.waitForTimeout(300);
  marks.health = at();
  await page.waitForTimeout(Number(healthMs));
  // ゆっくりスクロール(2.6 秒、なめらかに)してカードへ
  const cy = await page.evaluate(() => Math.round(document.querySelector("#sh-fix-card").getBoundingClientRect().top + window.scrollY - 16));
  marks.scroll = at();
  await page.evaluate(([from, to]) => new Promise((res) => {
    const t0 = performance.now(), d = 2600;
    const step = (now) => { const k = Math.min(1, (now - t0) / d), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; window.scrollTo(0, from + (to - from) * e); k < 1 ? requestAnimationFrame(step) : res(); };
    requestAnimationFrame(step);
  }), [hy, cy]);
  await page.waitForTimeout(200);
  marks.card = at();
  await page.waitForTimeout(Number(cardMs));

  marks.code = at();
  const label = await page.locator(".sh-code-label").first().textContent();
  const code = (/([0-9]{4})/.exec(label || "") || [])[1] || "";
  await page.click(".sh-confirm-code");
  await page.type(".sh-confirm-code", code, { delay: 180 });
  const rest = Math.max(300, Number(codeMs) - code.length * 180 - 200);
  await page.waitForTimeout(rest);
  await page.click(".sh-approve-btn");
  await page.waitForFunction(() => window.__shApproved, null, { timeout: 90000 });
  marks.approved = at();
  const status = await page.evaluate(() => window.__shApproved);
  await page.locator(".sh-fix-result").first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(Number(resultMs));

  await page.goto(base + probe);
  marks.after = at();
  await page.waitForTimeout(Number(afterMs));
  const raw = await page.content();
  await page.goto(base + "/");
  marks.top = at();
  await page.waitForTimeout(Number(topMs));
  marks.wall_total = at();
  await ctx.close();
  await browser.close();
  marks.status = status;
  marks.after_escaped = raw.includes("&lt;b style=") && !raw.includes('<b style="color:red">A-1024</b>');
  writeFileSync(`${out}/marks.json`, JSON.stringify(marks));
  console.log(JSON.stringify(marks));
})();
