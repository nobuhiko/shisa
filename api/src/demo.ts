// SPDX-License-Identifier: GPL-2.0-or-later
// 動画用: 記録した点検を、重みを付けて流し直す画面。場面(scene)ごとに URL で選ぶ。
// SH_DEMO=1 のときだけ開く(手元の API は 127.0.0.1 にしか開いていない)。Claude は呼ばない。
// 見せるのは実際に動いた点検の記録だけ。行を作ったり足したりしない。字幕は行に書かれていることだけから作る
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
<title>self-harden 記録の再生</title>
<style>
  :root { --bg: #f5f6f8; --card: #fff; --ink: #1f2933; --muted: #8592a3; --ok: #2e7d32; --err: #c62828; --key: #fff3c4; --accent: #3949ab; --band: #1f2933; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 17px/1.55 "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif; display: flex; flex-direction: column; }
  header { display: flex; align-items: center; gap: 12px; padding: 12px 20px; background: #1f2933; color: #fff; }
  header h1 { font-size: 20px; margin: 0; font-weight: 600; }
  header .badge { font-size: 13px; padding: 2px 10px; border-radius: 10px; background: #e8eaf6; color: var(--accent); }
  header .adv { margin-left: auto; font-size: 14px; color: #cbd2d9; }
  .controls { padding: 6px 20px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; font-size: 13px; color: var(--muted); }
  .controls select, .controls button { font: inherit; padding: 2px 6px; }
  body.clean .controls { display: none; }
  main { flex: 1; min-height: 0; display: grid; gap: 16px; padding: 8px 20px; }
  main.two { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  main.one { grid-template-columns: minmax(0, 1fr); }
  .col { background: var(--card); border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.08); display: flex; flex-direction: column; min-height: 0; }
  .col h2 { margin: 0; padding: 12px 16px; font-size: 20px; border-bottom: 1px solid #eef0f3; }
  .phases { display: flex; gap: 4px; padding: 8px 16px; border-bottom: 1px solid #eef0f3; }
  .phases span { flex: 1; text-align: center; font-size: 14px; padding: 4px 0; border-radius: 4px; background: #f0f2f5; color: var(--muted); transition: all .3s; }
  .phases span.on { background: var(--accent); color: #fff; font-weight: 700; }
  .phases span.done { background: #c5cae9; color: #283593; }
  ul.log { list-style: none; margin: 0; padding: 0 16px; flex: 1; min-height: 0; overflow-y: auto; }
  ul.log li { padding: 8px 0; border-bottom: 1px solid #f0f2f5; display: flex; gap: 12px; font-size: 17px; }
  ul.log li time { color: var(--muted); flex: none; font-variant-numeric: tabular-nums; font-size: 14px; padding-top: 2px; }
  ul.log li > span { min-width: 0; overflow-wrap: anywhere; }
  ul.log li .tool { color: var(--muted); font-size: 13px; margin-left: 8px; }
  ul.log li .res { color: var(--ok); margin-left: 8px; }
  ul.log li.k-error, ul.log li.k-error .res { color: var(--err); }
  ul.log li.research { color: var(--muted); font-size: 15px; }
  ul.log li.key { animation: flash 2.6s ease-out; } ul.log li.key .res { font-weight: 700; }
  @keyframes flash { 0% { background: var(--key); } 100% { background: transparent; } }
  .band { display: grid; gap: 16px; padding: 10px 20px 16px; }
  .band.two { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .band div { min-height: 64px; background: var(--band); color: #fff; border-radius: 10px; padding: 14px 20px; font-size: 26px; font-weight: 700; line-height: 1.3;
              opacity: .15; transition: opacity .25s; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .band div.show { opacity: 1; } .band div.warn { color: #ffcc80; } .band div.good { color: #a5d6a7; }
  .band div.fixed { opacity: 1; text-align: center; }
  /* 場面 D: 見せ場を 1 つずつ大きく */
  .spot { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px; padding: 20px 60px; text-align: center; }
  .spot .cap { font-size: 40px; font-weight: 800; line-height: 1.3; }
  .spot .cap.warn { color: #b26a00; } .spot .cap.good { color: var(--ok); }
  .spot .line { font-size: 20px; color: #52606d; max-width: 1100px; }
  .spot .from { font-size: 15px; color: var(--muted); }
  /* 場面 E: 報告のカード */
  .card { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 24px; padding: 24px 32px; min-height: 0; }
  .card section { background: var(--card); border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,.08); padding: 22px 28px; overflow: hidden; }
  .card h3 { margin: 0 0 14px; font-size: 28px; }
  .card h3.fix { color: var(--ok); } .card h3.next { color: var(--accent); } .card h4 { margin: 22px 0 8px; font-size: 18px; color: #b26a00; }
  .card ul { list-style: none; padding: 0; margin: 0; }
  .card li { font-size: 22px; line-height: 1.45; padding: 6px 0; }
  .card li small { display: block; font-size: 15px; color: var(--muted); }
</style></head><body>
<header><h1 id="title">self-harden</h1><span class="badge">記録を早送りで再生</span><span class="adv" id="adv"></span></header>
<div class="controls" id="controls"></div>
<main id="main"></main>
<div class="band" id="band"></div>
<script>
(function () {
  var NAMES = {
    'server-a': 'サーバー A(Apache + mod_php)', 'server-b': 'サーバー B(Apache + PHP-FPM)'
  };
  var PHASES = ['調べる', '照らし合わせる', '試す', '入れる', '確かめる', '報告'];
  var RESEARCH_TOOL = /公開の情報|ファイルを読む|ファイルの一覧|サーバーを調べる|調べた結果の控え|調べた結果を控える|前回の点検|退避の一覧|隔離の一覧/;
  var T_RESEARCH = 500, T_KEY = 2500, T_WAIT = 1000, T_OTHER = 800;

  function el(t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; }
  function q(k) { return new URLSearchParams(location.search).get(k); }
  function load(id) { return fetch('/demo/run/' + encodeURIComponent(id)).then(function (r) { return r.json(); }); }
  function hostName(run) { var h = (run.shop || '').split(':')[0]; return NAMES[h] || h; }
  function waitSec(s) { var m = /^(\d+) 秒待つ/.exec(s.tool || ''); return m ? Number(m[1]) : 0; }
  function isResearch(s) { return (!s.tool && /^公開の情報を(探す|読む)/.test(s.title)) || RESEARCH_TOOL.test(s.tool || ''); }

  function phaseOf(s) {
    var t = s.tool || '';
    if (s.kind === 'report') return 5;
    if (/照らし合わせる|公式との違い|部品の弱点/.test(t)) return 1;
    if (/小部屋/.test(t) || waitSec(s)) return 2;
    if (/本番に入れる|公式の中身に戻す|公式の修正を当てる|隔離する|退避から戻す/.test(t)) return 3;
    if (/外から開く/.test(t)) return 4;
    return 0;
  }

  // 字幕。その行に書かれていること(道具・版・結果)だけから作る。台本は書かない
  function captionOf(s, ctx) {
    var t = s.tool || '', r = s.result || '', m;
    if (/照らし合わせる/.test(t) && (m = /違う (\d+) 件、公式に無い (\d+) 件/.exec(r)) && m[1] !== '0')
      return { cls: 'warn', text: '公式の配布物と照らし合わせ: 書き換え ' + m[1] + ' 件' };
    if (/公式の中身に戻す/.test(t) && /公式の中身に戻した/.test(r)) {
      var ref = (/ @ (\S+)$/.exec(t) || [])[1];
      if (ref && ctx.version && ref === ctx.version) return { cls: 'good', text: '書き換えられたファイルを、公式の中身に戻した' };
      return { cls: 'good', text: '公式の修正のファイルを置いた' };
    }
    if (/公式の修正を当てる/.test(t) && /そろえて当てた/.test(r)) return { cls: 'good', text: '公式の修正を、全部そろえて当てた' };
    if (/公式の修正を当てる/.test(t) && /何も置いていない/.test(r)) return { cls: 'warn', text: '公式の修正がそろわないので、1 つも置かない' };
    if (/隔離する/.test(t) && /隔離した/.test(r)) return { cls: 'good', text: '覚えのないファイルを隔離した(消さずに)' };
    if (s.kind === 'error' && /受け口からは書けません/.test(r)) return { cls: 'warn', text: '危ない書き方は、受け口が断った' };
    if (/小部屋で試す/.test(t) && /空に|片付け/.test(s.title)) return null;
    if (/小部屋で試す/.test(t)) {
      var f = (/(\.htaccess|\.user\.ini)/.exec(t) || [])[1] || '';
      if (/500|壊れる/.test(r)) return { cls: 'warn', text: '試験場で ' + f + ' を試す → 500 で壊れる' };
      if (/HTTP 200/.test(r)) return { cls: '', text: '試験場で ' + f + ' を試す' };
    }
    if (waitSec(s) >= 60) return { cls: '', text: Math.round(waitSec(s) / 60) + ' 分待つ(設定が効くまで)' };
    if (/本番に入れる|公式の中身に戻す|公式の修正を当てる/.test(t) && /戻した/.test(r) && /開けなく/.test(r)) return { cls: 'warn', text: '店が開けなくなったので、すぐに戻した' };
    if (/本番に入れる/.test(t) && /入れた/.test(r)) {
      var g = (/root\/(\.htaccess|\.user\.ini)/.exec(t) || [])[1] || '';
      return { cls: 'good', text: '本番の ' + g + ' に入れた → 店を開いて確かめた' };
    }
    if (s.kind === 'info' && /通知の URL/.test(s.title)) return { cls: '', text: '店主が通知の URL を貼った' };
    if (s.kind === 'report') return { cls: 'good', text: '報告を出した' };
    return null;
  }

  // 続けて並ぶ調べ物は 1 行にまとめる(行の中身は書き換えず、件数だけを数える)
  function compact(steps) {
    var out = [], buf = [];
    function flush() {
      if (!buf.length) return;
      if (buf.length === 1) out.push(buf[0]);
      else out.push({ at: buf[0].at, kind: 'tool', title: '調べ物 ' + buf.length + ' 件', research: true });
      buf = [];
    }
    steps.forEach(function (s) { if (isResearch(s) && !captionOf(s, {})) buf.push(s); else { flush(); out.push(s); } });
    flush();
    return out;
  }

  function versionOf(steps) {
    for (var i = 0; i < steps.length; i++) { var m = /EC-CUBE ([0-9][0-9.]*[0-9](-p[0-9]+)?)/.exec(steps[i].result || ''); if (m) return m[1]; }
    return null;
  }

  function stepEl(s) {
    var li = el('li', 'k-' + s.kind + (s.research ? ' research' : ''));
    li.appendChild(el('time', null, new Date(s.at).toLocaleTimeString('ja-JP')));
    var b = el('span');
    var w = waitSec(s);
    b.appendChild(el('span', null, w ? '⏩ ' + Math.round(w / 60) + ' 分待つ(設定が効くまで)' : s.title));
    if (s.tool && !w) b.appendChild(el('span', 'tool', s.tool));
    if (s.result && !w) b.appendChild(el('span', 'res', '→ ' + s.result));
    li.appendChild(b);
    return li;
  }

  function delayOf(s, ctx) { return s.research ? T_RESEARCH : waitSec(s) ? T_WAIT : captionOf(s, ctx) ? T_KEY : T_OTHER; }

  function makeColumn(main, run) {
    var col = el('section', 'col');
    col.appendChild(el('h2', null, hostName(run)));
    var ph = el('div', 'phases'); PHASES.forEach(function (p) { ph.appendChild(el('span', null, p)); }); col.appendChild(ph);
    var log = el('ul', 'log'); col.appendChild(log);
    main.appendChild(col);
    return { col: col, ph: ph, log: log };
  }
  function setPhase(ph, i) { var xs = ph.children; for (var j = 0; j < xs.length; j++) xs[j].className = j < i ? 'done' : j === i ? 'on' : ''; }
  function showBand(cell, c) { cell.className = c ? 'show ' + (c.cls || '') : ''; cell.textContent = c ? c.text : ''; }

  // 1 列を重み付きで流す
  function play(run, steps, view, bandCell, done) {
    var ctx = { version: versionOf(run.steps) };
    var list = compact(steps), i = 0, hide = null;
    (function next() {
      if (i >= list.length) { if (done) setTimeout(done, 1200); return; }
      var s = list[i++], li = stepEl(s), c = captionOf(s, ctx);
      if (c) li.classList.add('key');
      view.log.appendChild(li); view.log.scrollTop = view.log.scrollHeight;
      var p = phaseOf(s); if (p) setPhase(view.ph, p);
      if (c) { clearTimeout(hide); showBand(bandCell, c); hide = setTimeout(function () { bandCell.className = ''; }, T_KEY); }
      setTimeout(next, delayOf(s, ctx));
    })();
  }

  function setAdv(runs) {
    for (var k = 0; k < runs.length; k++) {
      var r = runs[k], u = r.advisory_url;
      if (!u) for (var i = 0; i < r.steps.length; i++) { var m = /通知の URL を受け取った: (\S+)/.exec(r.steps[i].title); if (m) { u = m[1]; break; } }
      if (u) { document.getElementById('adv').textContent = '貼った通知: ' + u; return; }
    }
  }

  var main = document.getElementById('main'), band = document.getElementById('band');
  function layout(n) { main.className = n === 2 ? 'two' : 'one'; band.className = 'band' + (n === 2 ? ' two' : ''); main.textContent = ''; band.textContent = ''; }

  // ---- 場面 ----
  var scenes = {
    // A: 1 台を全幅で、最初から最後まで
    A: function (ids) {
      return load(ids[0]).then(function (run) {
        layout(1); setAdv([run]);
        var v = makeColumn(main, run), cell = el('div'); band.appendChild(cell);
        play(run, run.steps, v, cell);
      });
    },
    // B: 2 台を並べて「試す」の段階だけ。並べた下の帯に一言
    B: function (ids) {
      return Promise.all([load(ids[0]), load(ids[1])]).then(function (rs) {
        layout(2); setAdv(rs);
        var left = 2;
        rs.forEach(function (run) {
          var v = makeColumn(main, run), cell = el('div'); band.appendChild(cell);
          var trial = run.steps.filter(function (s) {
            if (/空に|片付け/.test(s.title)) return false;
            return /小部屋で試す|秒待つ/.test(s.tool || '') || /本番に入れる: root\/\.(htaccess|user\.ini)/.test(s.tool || '') || (s.kind === 'error' && /受け口からは書けません/.test(s.result || ''));
          });
          play(run, trial, v, cell, function () {
            if (--left) return;
            band.className = 'band'; band.textContent = '';
            band.appendChild(el('div', 'fixed show', '同じ点検、逆の手'));
          });
        });
      });
    },
    // C: 1 台。照らし合わせ → 書き換えと覚えのないファイル → 戻す・隔離 → 入口を閉じる
    C: function (ids) {
      return load(ids[0]).then(function (run) {
        layout(1); setAdv([run]);
        var v = makeColumn(main, run), cell = el('div'); band.appendChild(cell);
        var start = run.steps.findIndex(function (s) { return /照らし合わせる/.test(s.tool || ''); });
        var picked = run.steps.slice(Math.max(0, start)).filter(function (s) {
          return /照らし合わせる|公式との違い|公式の中身に戻す|隔離する|本番に入れる: root\/\.htaccess|外から開く/.test(s.tool || '');
        });
        play(run, picked, v, cell);
      });
    },
    // D: 複数の記録から見せ場の行だけを 1 つずつ
    D: function (ids) {
      return Promise.all(ids.map(load)).then(function (rs) {
        layout(1);
        var items = [];
        rs.forEach(function (run) {
          var ctx = { version: versionOf(run.steps) };
          run.steps.forEach(function (s) { var c = captionOf(s, ctx); if (c && s.kind !== 'report' && s.kind !== 'info') items.push({ run: run, s: s, c: c }); });
        });
        var box = el('div', 'spot'); main.appendChild(box);
        var i = 0;
        (function next() {
          if (i >= items.length) return;
          var it = items[i++];
          box.textContent = '';
          box.appendChild(el('div', 'cap ' + (it.c.cls || ''), it.c.text));
          box.appendChild(el('div', 'line', it.s.title + (it.s.result ? ' → ' + it.s.result : '')));
          box.appendChild(el('div', 'from', hostName(it.run) + '・' + new Date(it.s.at).toLocaleString('ja-JP')));
          setTimeout(next, 2800);
        })();
      });
    },
    // E: 報告を大きなカードで
    E: function (ids) {
      return load(ids[0]).then(function (run) {
        layout(1); setAdv([run]);
        var r = run.report || {};
        var card = el('div', 'card'); main.appendChild(card);
        var a = el('section'), b = el('section'); card.appendChild(a); card.appendChild(b);
        a.appendChild(el('h3', 'fix', '直したこと'));
        var fixed = (r.findings || []).filter(function (f) { return f.status === 'fixed' || f.status === 'mitigated'; });
        var ul = el('ul'); (fixed.length ? fixed : (r.actions || [])).slice(0, 5).forEach(function (x) { ul.appendChild(el('li', null, '✓ ' + x.title)); }); a.appendChild(ul);
        b.appendChild(el('h3', 'next', 'これから自分でやること'));
        var ul2 = el('ul'); (r.next_by_self_harden || []).slice(0, 4).forEach(function (x) { ul2.appendChild(el('li', null, '↻ ' + x.title)); }); b.appendChild(ul2);
        var asks = r.requests || r.remaining || [];
        if (asks.length) {
          b.appendChild(el('h4', null, 'お願い ' + asks.length + ' 件(依頼文つき)'));
          var ul3 = el('ul'); asks.slice(0, 2).forEach(function (x) { var li = el('li', null, '→ ' + x.title); li.style.fontSize = '18px'; li.appendChild(el('small', null, x.to || x.who || '')); ul3.appendChild(li); }); b.appendChild(ul3);
        }
      });
    }
  };

  // ---- 撮影の操作(clean=1 で隠す) ----
  function controls(runs) {
    var c = document.getElementById('controls');
    var scene = el('select'); ['A', 'B', 'C', 'D', 'E'].forEach(function (k) { var o = el('option', null, '場面 ' + k); o.value = k; scene.appendChild(o); });
    scene.value = q('scene') || 'A';
    var sels = [0, 1].map(function () {
      var s = el('select');
      runs.forEach(function (r) { var o = el('option', null, (NAMES[r.shop.split(':')[0]] || r.shop) + ' ' + new Date(r.created_at).toLocaleString('ja-JP') + '(' + r.steps + ' 行)' + (r.advisory_url ? ' 通知' : '')); o.value = r.run_id; s.appendChild(o); });
      return s;
    });
    var ids = (q('runs') || q('run') || '').split(',').concat([q('a'), q('b')]).filter(Boolean);
    if (ids[0]) sels[0].value = ids[0];
    if (ids[1]) sels[1].value = ids[1];
    var go = el('button', null, '再生');
    go.addEventListener('click', function () {
      var k = scene.value;
      location.search = '?scene=' + k + (k === 'B' ? '&a=' + sels[0].value + '&b=' + sels[1].value : k === 'D' ? '&runs=' + (q('runs') || sels[0].value + ',' + sels[1].value) : '&run=' + sels[0].value);
    });
    c.appendChild(scene); c.appendChild(sels[0]); c.appendChild(sels[1]); c.appendChild(go);
    c.appendChild(el('span', null, '撮るときは URL に &clean=1 を足すと、この行が消えます'));
  }

  if (q('clean') === '1') document.body.classList.add('clean');
  fetch('/demo/runs').then(function (r) { return r.json(); }).then(function (runs) {
    controls(runs);
    var k = q('scene');
    var ids = (k === 'B' ? [q('a'), q('b')] : (q('runs') || q('run') || '').split(',')).filter(Boolean);
    if (k && scenes[k] && ids.length) scenes[k](ids);
    else if (!runs.length) main.appendChild(el('p', null, '記録がまだありません'));
  });
})();
</script></body></html>`;
