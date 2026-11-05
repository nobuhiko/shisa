// SPDX-License-Identifier: GPL-2.0-or-later
// 「承認して直す」の断る側を、4 系のデモのお店の本物の管理画面で確かめる(手元の検証環境だけで使う)
// 使い方: PW=<playwright> node api/scripts/approve-reject-check.cjs <店の URL> [スタッフのログイン ID] [スタッフのパスワード]
//   a. 確認コードを間違えて押す
//   b. 画面で見た中身のハッシュを書き換えて送る
//   c. CSRF トークンなしで送る
//   d. 権限の低い管理者(スタッフ)で押す(スタッフの ID を渡したときだけ)
//   どれも、提案が pending のまま変わらないことを、そのつど確かめる。結果は JSON で標準出力へ
const { chromium } = require(process.env.PW || "playwright");

const CONFIG = "/admin/store/plugin/SelfHarden/config";
const PROPOSALS = "/admin/store/plugin/SelfHarden/proposals";
const APPROVE = "/admin/store/plugin/SelfHarden/approve/";

async function login(ctx, base, id, pw) {
  const page = await ctx.newPage();
  await page.goto(`${base}/admin/login`);
  await page.fill('input[name="login_id"]', id);
  await page.fill('input[name="password"]', pw);
  await Promise.all([page.waitForNavigation(), page.press('input[name="password"]', "Enter")]);
  return page;
}

// 管理画面の中から(同じセッションで)提案の一覧を取る
const proposals = (page, base) => page.evaluate((u) => fetch(u, { credentials: "same-origin" }).then((r) => r.json()), base + PROPOSALS);
const token = (page) => page.evaluate(() => document.querySelector('meta[name="eccube-csrf-token"]').getAttribute("content"));
// 承認の POST を作って送る(画面の approve() と同じ形。withToken=false なら CSRF トークンを付けない)
const post = (page, url, fields, withToken, tok) =>
  page.evaluate(async ({ url, fields, withToken, tok }) => {
    const body = new URLSearchParams(withToken ? { _token: tok, ...fields } : fields);
    const r = await fetch(url, { method: "POST", credentials: "same-origin", headers: withToken ? { "ECCUBE-CSRF-TOKEN": tok } : {}, body });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text: json ? null : text.replace(/\s+/g, " ").slice(0, 160) };
  }, { url, fields, withToken, tok });

(async () => {
  const [base, staffId, staffPw] = process.argv.slice(2);
  const browser = await chromium.launch();
  const out = {};
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await login(ctx, base, "admin", "password");
  await page.goto(base + CONFIG);
  await page.waitForSelector("#sh-fix-card:not([hidden]) .sh-approve-btn", { timeout: 60000 });
  const list0 = await proposals(page, base);
  const p = list0.proposals.find((x) => x.status === "pending");
  if (!p) throw new Error("pending の提案がありません");
  out.proposal = { id: p.proposal_id, path: p.path, status: p.status };
  const stillPending = async () => (await proposals(page, base)).proposals.find((x) => x.proposal_id === p.proposal_id)?.status;
  const tok = await token(page);

  // a. 確認コードを間違えて、画面のボタンを押す
  const wrong = String((Number(p.confirm_code) + 1) % 10000).padStart(4, "0");
  // 画面は開いたあと提案を読み直して描き直すので、落ち着いてから入力して押す。結果は表示の文で待つ
  await page.waitForTimeout(3000);
  await page.fill(`#sh-code-${p.proposal_id}`, wrong);
  await page.click(`#sh-approve-${p.proposal_id}`);
  await page.waitForFunction(() => /直せません|直しました|元に戻しました/.test((document.querySelector(".sh-fix-result") || {}).textContent || ""), null, { timeout: 30000 });
  out.a = { shown: await page.locator(".sh-fix-result").first().textContent(), status: await stillPending() };
  await page.screenshot({ path: "video/chk/approve-reject-a.png", fullPage: false });

  // b. 正しい確認コードで、画面で見た中身のハッシュだけ書き換えて送る
  const fake = p.sha256_new.replace(/^./, (c) => (c === "0" ? "1" : "0"));
  out.b = { res: await post(page, base + APPROVE + p.proposal_id, { sha256_new: fake, sha256_before: p.sha256_before, confirm_code: p.confirm_code }, true, tok), status: await stillPending() };

  // c. CSRF トークンなしで送る(ほかは正しい)
  out.c = { res: await post(page, base + APPROVE + p.proposal_id, { sha256_new: p.sha256_new, sha256_before: p.sha256_before, confirm_code: p.confirm_code }, false), status: await stillPending() };

  // d. 権限の低い管理者で、画面を開いてから押す(画面は承認のボタンを出さないはず。POST も作って送る)
  if (staffId) {
    const sctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const sp = await login(sctx, base, staffId, staffPw);
    await sp.goto(base + CONFIG);
    await sp.waitForSelector("#sh-fix-card:not([hidden])", { timeout: 60000 });
    await sp.waitForTimeout(1500);
    const sl = await proposals(sp, base);
    const sprop = sl.proposals.find((x) => x.proposal_id === p.proposal_id) || {};
    out.d = {
      can_approve: sl.can_approve,
      button: await sp.locator(".sh-approve-btn").count(),
      disabled: await sp.locator(".sh-approve-btn").first().isDisabled(),
      code_input: await sp.locator(".sh-confirm-code").count(),
      shown: (await sp.locator("#sh-fix-card").textContent()).replace(/\s+/g, " ").match(/承認できるのは[^。]*/)?.[0] ?? null,
      res: await post(sp, base + APPROVE + p.proposal_id, { sha256_new: sprop.sha256_new || p.sha256_new, sha256_before: sprop.sha256_before || p.sha256_before, confirm_code: sprop.confirm_code || p.confirm_code }, true, await token(sp)),
      status: await stillPending(),
    };
    await sp.screenshot({ path: "video/chk/approve-reject-d.png", fullPage: false });
    await sctx.close();
  }
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
