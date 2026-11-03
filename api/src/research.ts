// SPDX-License-Identifier: GPL-2.0-or-later
// 調べ方の道具: 部品の弱点の照らし合わせ(Packagist の公式 API)、調べた結果の使い回し、前回との違い
import { callReceiver } from "./receiver.js";
import { sha256Hex } from "./sign.js";
import type { Shop, Store } from "./store.js";

const PACKAGIST_ADVISORIES = "https://packagist.org/api/security-advisories/";
export const RESEARCH_TTL_MS = 7 * 24 * 3600_000;

// ---- composer の版の条件(">=2.0,<2.16.1|>=3.0,<3.14") に当たるか ----

function norm(v: string): number[] {
  const m = v.trim().replace(/^v/i, "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return [];
  return [m[1], m[2], m[3], m[4]].map((x) => Number(x ?? 0));
}

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < 4; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

export function satisfies(version: string, constraint: string): boolean {
  const v = norm(version);
  if (!v.length) return false;
  return constraint.split("|").some((group) =>
    group
      .trim()
      .split(/\s*,\s*|\s+/)
      .filter(Boolean)
      .every((c) => {
        const m = c.match(/^(>=|<=|>|<|==|=|!=)?\s*(.+)$/);
        if (!m) return false;
        const op = m[1] ?? "=";
        const r = cmp(v, norm(m[2]));
        return op === ">=" ? r >= 0 : op === "<=" ? r <= 0 : op === ">" ? r > 0 : op === "<" ? r < 0 : op === "!=" ? r !== 0 : r === 0;
      }),
  );
}

// ---- 部品の弱点 ----

export async function checkPackages(shop: Shop, applied: { path: string; ref: string; at: number }[] = []) {
  // composer.lock は大きい(EC-CUBE 4.2 で 256KB を超える)ので、受け口の inspect が抜き出した名前と版を使う
  const r = await callReceiver(shop, "inspect", { sections: ["app"] });
  if (!r.ok) throw new Error("composer.lock の部品の一覧を読めませんでした");
  const pkgs: { name: string; version: string; locked: string; replaced_by_self_harden: boolean }[] = ((r.result.app?.packages ?? []) as any[])
    .filter((p) => p?.name && p?.version)
    .map((p) => {
      // self-harden が部品を公式の修正版に差し替えたもの(全部のファイルをそろえて当てたもの)は、その版で照らし合わせる
      const fx = applied.filter((a) => a.path.startsWith(`vendor/${p.name}/`) && /^v?[0-9]+\.[0-9]+\.[0-9]+$/.test(a.ref)).sort((a, b) => b.at - a.at)[0];
      return { name: p.name, version: fx ? fx.ref : p.version, locked: p.version, replaced_by_self_harden: !!fx };
    });
  if (!pkgs.length) throw new Error("composer.lock に部品が見つかりませんでした");
  const body = new URLSearchParams();
  for (const p of pkgs) body.append("packages[]", p.name);
  const res = await fetch(PACKAGIST_ADVISORIES, { method: "POST", body, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Packagist の security-advisories API に失敗しました: HTTP ${res.status}`);
  const data = (await res.json()) as { advisories: Record<string, any[]> };
  const hits = [];
  for (const p of pkgs) {
    for (const a of data.advisories?.[p.name] ?? []) {
      if (typeof a.affectedVersions === "string" && satisfies(p.version, a.affectedVersions)) {
        hits.push({
          package: p.name, installed: p.version, locked: p.locked, replaced_by_self_harden: p.replaced_by_self_harden, advisory: a.advisoryId, cve: a.cve ?? null, title: a.title, severity: a.severity ?? null,
          affected: a.affectedVersions, reported_at: a.reportedAt, link: a.link,
        });
      }
    }
  }
  const order = { critical: 0, high: 1, medium: 2, low: 3 } as Record<string, number>;
  hits.sort((x, y) => (order[x.severity ?? ""] ?? 4) - (order[y.severity ?? ""] ?? 4) || String(y.reported_at).localeCompare(String(x.reported_at)));
  return { source: PACKAGIST_ADVISORIES, checked_packages: pkgs.length, affected_count: hits.length, affected: hits };
}

// ---- 調べた結果の使い回し(版・部品ごと、日付と出典つき。この API の中だけの控え) ----

const subjectKey = (s: string) => "r_" + s.toLowerCase().replace(/[^a-z0-9.]+/g, "_").slice(0, 120);

export async function loadResearch(store: Store, subjects: string[]) {
  const out: Record<string, unknown> = {};
  for (const s of subjects.slice(0, 20)) {
    const r = await store.getResearch(subjectKey(s));
    out[s] = r ? { ...r, fresh: Date.now() - r.saved_at < RESEARCH_TTL_MS, age_days: Math.floor((Date.now() - r.saved_at) / 86400_000) } : null;
  }
  return out;
}

export async function saveResearch(store: Store, subject: string, input: { findings: unknown; sources: unknown; summary?: string }) {
  const rec = { subject, saved_at: Date.now(), checked_on: new Date().toISOString().slice(0, 10), summary: input.summary ?? "", findings: input.findings, sources: input.sources };
  await store.putResearch(subjectKey(subject), rec);
  return { saved: subject, checked_on: rec.checked_on };
}

// ---- 前回の点検との違い(版・設定・ファイルの一覧の指紋) ----

export async function fingerprint(shop: Shop) {
  const ins = await callReceiver(shop, "inspect", { sections: ["php", "ini", "app", "extensions"] });
  if (!ins.ok) throw new Error("inspect に失敗しました");
  const r = ins.result;
  let cursor = "";
  const files: string[] = [];
  for (let i = 0; i < 100; i++) {
    const h = await callReceiver(shop, "hash_tree", { limit: 5000, cursor });
    if (!h.ok) throw new Error("hash_tree に失敗しました");
    for (const [p, sha] of h.result.files) files.push(`${p}:${sha}`);
    if (!h.result.next_cursor) break;
    cursor = h.result.next_cursor;
  }
  const conf: string[] = [];
  for (const p of [".htaccess", ".user.ini"]) {
    const f = await callReceiver(shop, "read_file", { path: p });
    conf.push(f.ok && f.result.exists ? f.result.sha256 : "-");
  }
  return {
    php: `${r.php.version} ${r.php.sapi}`,
    eccube: r.app.eccube_version,
    packages: await sha256Hex(JSON.stringify((r.app.packages ?? []).map((p: any) => `${p.name}@${p.version}`))),
    ini: await sha256Hex(JSON.stringify(r.ini)),
    extensions: await sha256Hex(JSON.stringify(r.extensions)),
    files: await sha256Hex(files.join("\n")),
    file_count: files.length,
    config_files: conf.join(","),
  };
}

export async function compareWithPrevious(store: Store, shop: Shop, currentRunId: string) {
  const now = await fingerprint(shop);
  const prev = (await store.listRuns(shop.shop_id)).find((r) => r.run_id !== currentRunId && r.status === "done" && (r as any).fingerprint);
  if (!prev) return { previous: null, current: now };
  const pf = (prev as any).fingerprint as Record<string, unknown>;
  const changed = Object.keys(now).filter((k) => (now as any)[k] !== pf[k]);
  return {
    previous: {
      run_id: prev.run_id, at: new Date(prev.created_at).toISOString(), summary: (prev.report as any)?.summary ?? null,
      // 前回「これから self-harden がやること」と書いた約束。次の点検で手を付ける
      promised_next: ((prev.report as any)?.next_by_self_harden ?? []).map((x: any) => ({ title: x.title, when: x.when })),
    },
    changed,
    unchanged: changed.length === 0,
  };
}
