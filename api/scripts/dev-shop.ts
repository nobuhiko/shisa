// SPDX-License-Identifier: GPL-2.0-or-later
// 開発用: プラグインの代わりに、デモの店に受け口を置き、鍵を作って API に登録し、点検を始めて経過を見る
//   npx tsx scripts/dev-shop.ts connect kagoya
//   npx tsx scripts/dev-shop.ts start kagoya [通知の URL]
//   npx tsx scripts/dev-shop.ts watch kagoya <run_id>
//   npx tsx scripts/dev-shop.ts break lolipop       わざと壊れる .htaccess を書かせ、同じリクエストの中で戻るかを確かめる
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomHex, signRequest } from "../src/sign.js";

const API = process.env.SH_API ?? "http://127.0.0.1:8787";
const HOSTS: Record<string, { container: string; public: string }> = {
  kagoya: { container: "self-harden-demo-kagoya-1", public: "http://127.0.0.1:8081" },
  lolipop: { container: "self-harden-demo-lolipop-php-1", public: "http://127.0.0.1:8082" },
};
const STATE = new URL("../data/dev-shops.json", import.meta.url);
const RECEIVER = new URL("../../plugin/SelfHarden/Resource/receiver/self-harden.php", import.meta.url);

const load = (): Record<string, { shop_id: string; secret: string }> => {
  try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return {}; }
};

function put(container: string, path: string, content: string, mode = "0644") {
  execFileSync("docker", ["exec", "-i", "-u", "www-data", container, "sh", "-c", `mkdir -p "$(dirname '${path}')" && cat > '${path}' && chmod ${mode} '${path}'`], { input: content });
}

async function signed(method: string, path: string, shop: { shop_id: string; secret: string }, body = "") {
  const h = await signRequest(shop.secret, method, path, shop.shop_id, body);
  const res = await fetch(API + path, { method, headers: { "Content-Type": "application/json", ...h }, body: method === "GET" ? undefined : body });
  return res.json() as Promise<any>;
}

const [cmd, host, arg] = process.argv.slice(2);
const h = HOSTS[host];
if (!h) throw new Error("host must be kagoya or lolipop");
const state = load();

if (cmd === "connect") {
  const shop = { shop_id: `shp_${host}${randomHex(4)}`, secret: randomHex(32) };
  put(h.container, "/var/www/html/self-harden.php", readFileSync(RECEIVER, "utf8"));
  const cfg = { shop_id: shop.shop_id, secret: shop.secret, api_base: "http://api:8787", self_base: `http://${host}`, public_base: h.public, created_at: Math.floor(Date.now() / 1000) };
  put(h.container, "/var/www/html/var/self-harden/config.php", "<?php exit; ?>\n" + JSON.stringify(cfg) + "\n", "0600");
  const res = await fetch(API + "/v1/shops", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shop_id: shop.shop_id, receiver_url: `http://${host}/self-harden.php`, shop_url: `http://${host}`, secret: shop.secret, platform: "eccube-4.2", plugin_version: "dev" }),
  }).then((r) => r.json() as Promise<any>);
  console.log({ ok: res.ok, shop_id: res.shop_id, status: res.status, ping: res.ping });
  state[host] = shop;
  mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 2), { mode: 0o600 });
} else if (cmd === "start") {
  const shop = state[host];
  const r = await signed("POST", `/v1/shops/${shop.shop_id}/runs`, shop, JSON.stringify(arg ? { advisory_url: arg } : {}));
  console.log(r);
} else if (cmd === "watch") {
  const shop = state[host];
  let seen = 0;
  for (;;) {
    const r = await signed("GET", `/v1/shops/${shop.shop_id}/runs/${arg}`, shop);
    for (const s of r.steps.slice(seen)) console.log(`${new Date(s.at).toLocaleTimeString("ja-JP")} [${s.kind}] ${s.title}`);
    seen = r.steps.length;
    if (r.status !== "running") {
      console.log("status:", r.status, "usage:", r.usage);
      console.log(JSON.stringify(r.report, null, 2));
      break;
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
} else if (cmd === "break") {
  // 店に置かれている鍵(プラグインが作ったもの)で受け口を直接呼ぶ
  const raw = execFileSync("docker", ["exec", h.container, "cat", "/var/www/html/var/self-harden/config.php"], { encoding: "utf8" });
  const cfg = JSON.parse(raw.slice(raw.indexOf("\n") + 1));
  const call = async (op: string, args: Record<string, unknown>) => {
    const body = JSON.stringify({ op, args });
    const hd = await signRequest(cfg.secret, "POST", "/self-harden.php", cfg.shop_id, body);
    return (await fetch(h.public + "/self-harden.php", { method: "POST", headers: { "Content-Type": "application/json", ...hd }, body })).json() as Promise<any>;
  };
  const before = await call("read_file", { path: ".htaccess" });
  const top0 = (await fetch(h.public + "/")).status;
  // 壊れる中身: 前の中身の先頭に、Apache が知らない命令を 1 行足す
  const broken = "ThisIsNotAnApacheDirective on\n" + (before.result.content ?? "");
  const w = await call("write_file", { target: "root/.htaccess", content: broken, expected_sha256: before.result.sha256 ?? null, verify: { paths: ["/", "/self-harden.php"], timeout_sec: 8 } });
  const after = await call("read_file", { path: ".htaccess" });
  const top1 = (await fetch(h.public + "/")).status;
  console.log({ top_before: top0, verify: w.result?.verify, rolled_back: w.result?.rolled_back, rollback_verify: w.result?.rollback_verify, same_as_before: after.result.sha256 === before.result.sha256, top_after: top1 });
} else {
  throw new Error("connect | start | watch | break");
}
