// SPDX-License-Identifier: GPL-2.0-or-later
// 動画用: 右下の小さな札(「点検中も営業中」・時計・ご注文の件数)を、こま送りの透明な PNG にする(ffmpeg に文字を描く機能が無いため)
// 使い方: PW=<playwright> node api/scripts/badge-frames.cjs <こまの JSON> <出力ディレクトリ>
//   JSON: { "text": { "title", "maint", "orders" }, "frames": [ { "show": true, "clock": "12:03:41", "orders": 4, "maint": false, "pulse": 0〜1 }, ... ] }
//   中身(時計・件数・メンテナンス)は、点検と同時に録った買い物の記録から make-v4.mjs が作る。ここは描くだけ
const { chromium } = require(process.env.PW || "playwright");
const { readFileSync, mkdirSync } = require("node:fs");

(async () => {
  const [src, out] = process.argv.slice(2);
  const { text, frames } = JSON.parse(readFileSync(src, "utf8"));
  mkdirSync(out, { recursive: true });
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.setContent(`<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;background:transparent}
    #b{position:fixed;right:36px;bottom:40px;min-width:330px;padding:14px 20px 14px 18px;border-radius:14px;background:rgba(255,255,255,.95);
       box-shadow:0 6px 24px rgba(0,0,0,.18);font-family:"Hiragino Sans","Noto Sans JP",sans-serif;color:#1f2933;transition:none}
    #b.hide{display:none}
    #b.maint{background:rgba(255,248,225,.97)}
    .row{display:flex;align-items:center;gap:10px}
    .dot{width:14px;height:14px;border-radius:50%;background:#2e9e5b;box-shadow:0 0 0 4px rgba(46,158,91,.18)}
    #b.maint .dot{background:#e0a100;box-shadow:0 0 0 4px rgba(224,161,0,.22)}
    .t{font-weight:700;font-size:24px;letter-spacing:.02em}
    .c{margin-left:auto;font-size:20px;color:#52606d;font-variant-numeric:tabular-nums}
    .o{margin-top:6px;font-size:22px;padding-left:24px}
    .o b{display:inline-block;font-size:26px;font-variant-numeric:tabular-nums;transform-origin:center}
  </style><div id="b"><div class="row"><span class="dot"></span><span class="t"></span><span class="c"></span></div><div class="o"></div></div>`);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    await p.evaluate(({ f, text }) => {
      const b = document.getElementById("b");
      b.className = f.show ? (f.maint ? "maint" : "") : "hide";
      b.querySelector(".t").textContent = f.maint ? text.maint : text.title;
      b.querySelector(".c").textContent = f.clock || "";
      const [pre, post] = text.orders.split("{n}");
      const o = b.querySelector(".o"); o.textContent = pre;
      const n = document.createElement("b"); n.textContent = String(f.orders);
      // 件数が増えたときだけ、そっと大きくして戻す
      n.style.transform = `scale(${1 + 0.12 * (f.pulse || 0)})`; n.style.color = f.pulse ? "#2e7d4f" : "";
      o.appendChild(n); o.appendChild(document.createTextNode(post));
    }, { f, text });
    await p.screenshot({ path: `${out}/b${String(i).padStart(5, "0")}.png`, omitBackground: true });
  }
  await b.close();
  process.exit(0);
})();
