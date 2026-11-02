// SPDX-License-Identifier: GPL-2.0-or-later
// 動画用: 記録した 2 つの点検を左右に並べて、時間を縮めて同時に流す画面。
// SH_DEMO=1 のときだけ開く(手元の API は 127.0.0.1 にしか開いていない)。Claude は呼ばない
import type { Hono } from "hono";
import type { Store } from "./store.js";

export function mountDemo(app: Hono, store: Store) {
  if (process.env.SH_DEMO !== "1") return;

  app.get("/demo/runs", async (c) => {
    const shops = await store.listShops();
    const out = [];
    for (const s of shops) for (const r of await store.listRuns(s.shop_id)) {
      if (r.status !== "running") out.push({ run_id: r.run_id, shop: new URL(s.shop_url).host, created_at: r.created_at, status: r.status, advisory_url: r.advisory_url, steps: r.steps.length });
    }
    return c.json(out.sort((a, b) => b.created_at - a.created_at));
  });

  app.get("/demo/run/:id", async (c) => {
    const r = await store.getRun(c.req.param("id"));
    if (!r) return c.json({ error: "not_found" }, 404);
    const shop = await store.getShop(r.shop_id);
    return c.json({ run_id: r.run_id, shop: shop ? new URL(shop.shop_url).host : "", steps: r.steps, report: r.report ?? null, advisory_url: r.advisory_url });
  });

  app.get("/demo", (c) => c.html(PAGE));
}

const PAGE = String.raw`<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>self-harden 2 台を並べて再生</title>
<style>
  :root { --bg: #f5f6f8; --card: #fff; --ink: #1f2933; --muted: #8592a3; --ok: #2e7d32; --err: #c62828; --key: #fff3c4; --accent: #3949ab; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif; }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 20px; background: #1f2933; color: #fff; }
  header h1 { font-size: 18px; margin: 0; font-weight: 600; }
  header .badge { font-size: 12px; padding: 2px 10px; border-radius: 10px; background: #e8eaf6; color: var(--accent); }
  header .adv { margin-left: auto; font-size: 13px; color: #cbd2d9; }
  .controls { padding: 10px 20px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .controls select, .controls input, .controls button { font: inherit; padding: 4px 8px; }
  main { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; padding: 0 20px 20px; }
  li > span { min-width: 0; overflow-wrap: anywhere; }
  .col { background: var(--card); border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.08); display: flex; flex-direction: column; min-height: 0; }
  .col h2 { margin: 0; padding: 12px 16px; font-size: 17px; border-bottom: 1px solid #eef0f3; }
  .col h2 small { color: var(--muted); font-weight: normal; margin-left: 8px; font-size: 13px; }
  ul { list-style: none; margin: 0; padding: 0 16px; height: 62vh; overflow-y: auto; }
  li { padding: 7px 0; border-bottom: 1px solid #f0f2f5; display: flex; gap: 10px; font-size: 14px; }
  li time { color: var(--muted); flex: none; font-variant-numeric: tabular-nums; }
  li .tool { color: var(--muted); font-size: 12px; margin-left: 6px; }
  li .res { color: var(--ok); margin-left: 6px; }
  li.k-error .res, li.k-error { color: var(--err); }
  li.key { animation: flash 2.4s ease-out; } li.key .res { font-weight: 700; }
  @keyframes flash { 0% { background: var(--key); } 100% { background: transparent; } }
  .ff { color: #8a6d00; margin-left: 6px; font-variant-numeric: tabular-nums; }
  .report { padding: 12px 16px; border-top: 1px solid #eef0f3; font-size: 14px; display: none; }
  .report h3 { font-size: 14px; margin: 8px 0 4px; }
  .report p { margin: 0; white-space: pre-wrap; }
  .report li { display: block; border: 0; padding: 2px 0; }
  .col { position: relative; }
  .phases { display: flex; gap: 4px; padding: 8px 16px; border-bottom: 1px solid #eef0f3; }
  .phases span { flex: 1; text-align: center; font-size: 12px; padding: 3px 0; border-radius: 4px; background: #f0f2f5; color: var(--muted); transition: all .3s; }
  .phases span.on { background: var(--accent); color: #fff; font-weight: 700; }
  .phases span.done { background: #c5cae9; color: #283593; }
  .cap { position: absolute; left: 16px; right: 16px; bottom: 16px; background: rgba(31,41,51,.94); color: #fff; border-radius: 10px; padding: 14px 18px;
         opacity: 0; transform: translateY(10px); transition: opacity .3s, transform .3s; pointer-events: none; }
  .cap.show { opacity: 1; transform: none; }
  .cap b { display: block; font-size: 22px; line-height: 1.35; }
  .cap small { display: block; margin-top: 4px; font-size: 13px; color: #cbd2d9; }
  .cap.warn b { color: #ffcc80; } .cap.good b { color: #a5d6a7; }
  .compare { margin: 0 20px 24px; background: #1f2933; color: #fff; border-radius: 10px; padding: 18px 22px; display: none; }
  .compare h3 { margin: 0 0 10px; font-size: 18px; }
  .compare .row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; font-size: 17px; }
  .compare .row div b { color: #a5d6a7; }
  @media (max-width: 800px) { main, .compare .row { grid-template-columns: 1fr; } }
</style></head><body>
<header><h1>self-harden — 同じ店のソフト、違うサーバー</h1><span class="badge">記録を早送りで再生</span><span class="adv" id="adv"></span></header>
<div class="controls">
  左 <select id="a"></select> 右 <select id="b"></select>
  全体 <input id="sec" type="number" value="75" min="20" max="600" style="width:5em"> 秒
  <button id="go">再生</button>
</div>
<main>
  <section class="col"><h2 id="ha">左</h2><div class="phases" id="pa"></div><ul id="la"></ul><div class="report" id="ra"></div><div class="cap" id="ca"></div></section>
  <section class="col"><h2 id="hb">右</h2><div class="phases" id="pb"></div><ul id="lb"></ul><div class="report" id="rb"></div><div class="cap" id="cb"></div></section>
</main>
<section class="compare" id="cmp"><h3>同じ弱点に、それぞれのサーバーで効く手を選んだ</h3><div class="row"><div id="xa"></div><div id="xb"></div></div></section>
<script>
(function () {
  var NAMES = { kagoya: 'KAGOYA 風(Apache + mod_php)', lolipop: 'ロリポップ風(Apache + PHP-FPM)' };
  var KEY_TOOL = /本番に入れる|公式の中身に戻す|公式の修正を当てる|隔離する|照らし合わせる|小部屋で試す|部品の弱点/;
  var KEY_RES = /戻した|500|壊れる|隔離した|当てた|入れた|違う [1-9]/;
  function el(t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; }
  function isKey(s) { return s.kind === 'report' || s.kind === 'error' || KEY_TOOL.test(s.tool || '') || KEY_RES.test(s.result || ''); }
  function waitSec(s) { var m = /^(\d+) 秒待つ/.exec(s.tool || ''); return m ? Number(m[1]) : 0; }
  function mmss(n) { return Math.floor(n / 60) + ':' + ('0' + (n % 60)).slice(-2); }
  function q(k) { return new URLSearchParams(location.search).get(k); }

  var PHASES = ['調べる', '照らし合わせる', '試す', '入れる', '確かめる', '報告'];
  function phaseOf(s) {
    var t = s.tool || '';
    if (s.kind === 'report') return 5;
    if (/照らし合わせる|公式との違い|部品の弱点|前回の点検/.test(t)) return 1;
    if (/小部屋/.test(t) || /秒待つ/.test(t)) return 2;
    if (/本番に入れる|公式の中身に戻す|公式の修正を当てる|隔離する|退避から戻す/.test(t)) return 3;
    if (/外から開く/.test(t)) return 4;
    return 0;
  }
  function renderPhases(box) { box.textContent = ''; PHASES.forEach(function (p) { box.appendChild(el('span', null, p)); }); }
  function setPhase(box, i) { var xs = box.children; for (var j = 0; j < xs.length; j++) xs[j].className = j < i ? 'done' : j === i ? 'on' : ''; }

  // 見せ場の字幕。記録の中身(道具・結果)から作る。台本は書かない
  function captionOf(s) {
    var t = s.tool || '', r = s.result || '', m;
    if (/照らし合わせる/.test(t) && (m = /違う (\d+) 件、公式に無い (\d+) 件/.exec(r)) && (m[1] !== '0' || m[2] !== '0'))
      return { cls: 'warn', text: '公式の配布物と照らし合わせ: 書き換え ' + m[1] + ' 件・覚えのないファイル ' + m[2] + ' 件' };
    if (/公式の中身に戻す/.test(t) && /公式の中身に戻した/.test(r)) return { cls: 'good', text: '書き換えられたファイルを、公式の中身に戻した' };
    if (/公式の修正を当てる/.test(t) && /そろえて当てた/.test(r)) return { cls: 'good', text: '公式の修正を、全部そろえて当てた' };
    if (/隔離する/.test(t) && /隔離した/.test(r)) return { cls: 'good', text: '覚えのないファイルを隔離した(消さずに)' };
    if (/部品の弱点/.test(t) && (m = /(\d+) 件/.exec(r))) return { cls: 'warn', text: '部品の弱点を公式の一覧で照らし合わせ' };
    if (/小部屋/.test(t) && /500|壊れる/.test(r)) return { cls: 'warn', text: '試験場では 500 で壊れる → この方法は本番に入れない' };
    if (/小部屋で試す/.test(t)) return { cls: '', text: '本番に入れる前に、試験場で効くか試す' };
    if ((m = /^(\d+) 秒待つ/.exec(t)) && Number(m[1]) >= 60) return { cls: '', text: '⏩ ' + Math.round(Number(m[1]) / 60) + ' 分待って、効いたかを確かめる' };
    if (/本番に入れる|公式の中身に戻す|公式の修正を当てる/.test(t) && /戻した/.test(r) && /開けなく/.test(r)) return { cls: 'warn', text: '店が開けなくなったので、同じリクエストの中で戻した' };
    if (/本番に入れる/.test(t) && /入れた/.test(r)) return { cls: 'good', text: '本番に入れた → 店を開いて確かめた' };
    if (s.kind === 'info' && /通知の URL/.test(s.title)) return { cls: '', text: '店の人が通知の URL を貼った' };
    if (s.kind === 'report') return { cls: 'good', text: '報告を出した' };
    return null;
  }
  function showCap(box, c, sub, ms) {
    box.className = 'cap ' + (c.cls || '');
    box.innerHTML = ''; box.appendChild(el('b', null, c.text)); if (sub) box.appendChild(el('small', null, sub));
    void box.offsetWidth; box.classList.add('show');
    clearTimeout(box._t); box._t = setTimeout(function () { box.classList.remove('show'); }, ms);
  }

  // どの仕組みで本番に入れたか(記録から数える)
  function mechanisms(steps) {
    var out = {};
    steps.forEach(function (s) {
      if (!/本番に入れる/.test(s.tool || '') || !/入れた/.test(s.result || '')) return;
      var m = /root\/(\.htaccess|\.user\.ini)/.exec(s.tool); if (m) out[m[1]] = true;
    });
    return Object.keys(out);
  }

  function stepEl(s) {
    var li = el('li', 'k-' + s.kind);
    li.appendChild(el('time', null, new Date(s.at).toLocaleTimeString('ja-JP')));
    var b = el('span'); b.appendChild(el('span', null, s.title));
    if (s.tool) b.appendChild(el('span', 'tool', s.tool));
    if (s.result) b.appendChild(el('span', 'res', '→ ' + s.result));
    li.appendChild(b); return li;
  }

  function report(box, r) {
    if (!r) return; box.textContent = ''; box.style.display = 'block';
    box.appendChild(el('h3', null, 'まとめ')); box.appendChild(el('p', null, r.summary));
    if (r.actions && r.actions.length) {
      box.appendChild(el('h3', null, 'したこと')); var ul = el('ul');
      ul.style.height = 'auto'; ul.style.padding = '0';
      r.actions.forEach(function (a) { ul.appendChild(el('li', null, '・' + a.title + ' — ' + a.target)); }); box.appendChild(ul);
    }
  }

  // 続けて並ぶ「公開の情報を探す・読む」は、動画では 1 行にまとめる
  function compact(steps) {
    var out = [], buf = [];
    function flush() {
      if (!buf.length) return;
      if (buf.length === 1) { out.push(buf[0]); buf = []; return; }
      var hosts = [];
      buf.forEach(function (b) { var m = /https?:\/\/([^\/\s]+)/.exec(b.title); var h = m ? m[1] : '検索'; if (hosts.indexOf(h) < 0) hosts.push(h); });
      out.push({ at: buf[0].at, kind: 'tool', title: '公開の情報を調べた(' + buf.length + ' 件: ' + hosts.slice(0, 4).join(', ') + (hosts.length > 4 ? ' ほか' : '') + ')', tool: '公開の情報' });
      buf = [];
    }
    steps.forEach(function (s) { if (!s.tool && /^公開の情報を(探す|読む)/.test(s.title)) buf.push(s); else { flush(); out.push(s); } });
    flush();
    return out;
  }

  function play(run, list, box, head, target, phases, cap, done) {
    list.textContent = ''; box.style.display = 'none'; renderPhases(phases); setPhase(phases, 0);
    var host = run.shop.split(':')[0];
    head.textContent = NAMES[host] || run.shop;
    var steps = compact(run.steps), gaps = [], sum = 0;
    for (var i = 0; i < steps.length; i++) {
      var real = i === 0 ? 0 : Math.max(0, (steps[i].at - steps[i - 1].at) / 1000);
      var g = i === 0 ? 0.6 : 0.35 + 1.6 * (1 - Math.exp(-real / 25));
      if (i > 0 && isKey(steps[i - 1])) g += 1.0;
      if (i > 0 && waitSec(steps[i - 1])) g += 2.4;
      if (i > 0 && captionOf(steps[i - 1])) g += 1.2;
      gaps.push(g); sum += g;
    }
    var k = target / Math.max(sum, 1), idx = 0;
    (function next() {
      if (idx >= steps.length) { setTimeout(function () { report(box, run.report); setPhase(phases, 6); if (done) done(); }, 800); return; }
      var s = steps[idx++], li = stepEl(s);
      if (isKey(s)) li.classList.add('key');
      var ph = phaseOf(s); if (ph) setPhase(phases, ph);
      var c = captionOf(s);
      if (c) showCap(cap, c, s.title, Math.max(1800, 2600 * k));
      list.appendChild(li); list.scrollTop = list.scrollHeight;
      var w = waitSec(s);
      if (w) {
        var ff = el('span', 'ff', '⏩ ' + mmss(w)); li.lastChild.appendChild(ff);
        var t0 = Date.now(), dur = 2200 * k;
        (function tick() { var p = Math.min(1, (Date.now() - t0) / dur); ff.textContent = '⏩ ' + mmss(Math.round(w * (1 - p))); if (p < 1) requestAnimationFrame(tick); })();
      }
      setTimeout(next, (gaps[idx] || 0.6) * k * 1000);
    })();
  }

  function load(id) { return fetch('/demo/run/' + encodeURIComponent(id)).then(function (r) { return r.json(); }); }

  function go() {
    var a = document.getElementById('a').value, b = document.getElementById('b').value, sec = Number(document.getElementById('sec').value) || 75;
    history.replaceState(null, '', '?a=' + a + '&b=' + b + '&seconds=' + sec);
    Promise.all([load(a), load(b)]).then(function (rs) {
      function advOf(r) {
        if (r.advisory_url) return r.advisory_url;
        for (var i = 0; i < r.steps.length; i++) { var m = /通知の URL を受け取った: (\S+)/.exec(r.steps[i].title); if (m) return m[1]; }
        return null;
      }
      var adv = advOf(rs[0]) || advOf(rs[1]);
      document.getElementById('adv').textContent = adv ? '貼った通知: ' + adv : '';
      var left = 2, cmp = document.getElementById('cmp'); cmp.style.display = 'none';
      function bothDone() {
        if (--left) return;
        var names = [document.getElementById('ha').textContent, document.getElementById('hb').textContent];
        [0, 1].forEach(function (i) {
          var ms = mechanisms(rs[i].steps), box = document.getElementById(i ? 'xb' : 'xa');
          box.textContent = ''; box.appendChild(document.createTextNode(names[i] + ': '));
          box.appendChild(el('b', null, ms.length ? ms.join(' と ') + ' で守りを入れた' : '設定ファイルは書かなかった'));
        });
        cmp.style.display = 'block'; cmp.scrollIntoView({ behavior: 'smooth' });
      }
      play(rs[0], document.getElementById('la'), document.getElementById('ra'), document.getElementById('ha'), sec, document.getElementById('pa'), document.getElementById('ca'), bothDone);
      play(rs[1], document.getElementById('lb'), document.getElementById('rb'), document.getElementById('hb'), sec, document.getElementById('pb'), document.getElementById('cb'), bothDone);
    });
  }

  fetch('/demo/runs').then(function (r) { return r.json(); }).then(function (runs) {
    ['a', 'b'].forEach(function (k) {
      var sel = document.getElementById(k);
      runs.forEach(function (r) { var o = el('option', null, r.shop + ' ' + new Date(r.created_at).toLocaleString('ja-JP') + '(' + r.steps + ' 行)'); o.value = r.run_id; sel.appendChild(o); });
    });
    if (q('a')) document.getElementById('a').value = q('a');
    if (q('b')) document.getElementById('b').value = q('b');
    if (q('seconds')) document.getElementById('sec').value = q('seconds');
    document.getElementById('go').addEventListener('click', go);
    if (q('a') && q('b')) go();
  });
})();
</script></body></html>`;
