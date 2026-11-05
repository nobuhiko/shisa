// SPDX-License-Identifier: GPL-2.0-or-later
// 店主の承認での版上げの、提案のときの決めごと(計算だけ。窓口やストアは呼ばない)
// - 残す部品: 点検で当てた部品の修正版のほうが、上げ先の配布物の版より新しい部品は、版上げで上書きしない(新しいほうを残す)
// - 指紋: 版上げが触る場所(vendor/ の全部と、置き換える本体のファイル)の今の中身。窓口が承認のあとに取り直し、違えば何も書かずに止める
import { createHash } from "node:crypto";
import type { AppliedFix } from "./store.js";

export interface KeepPackage {
  name: string;
  version: string; // 点検で当てた修正版(お店に今ある版)
  release_version: string; // 上げ先の配布物の composer.lock の版
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

// 部品の版の比べ(v1.2.3 と 1.2.3 は同じ)。形が違うものは比べられない(null)
export function semverCmp(a: string, b: string): number | null {
  const x = SEMVER.exec(a), y = SEMVER.exec(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// 点検で当てた部品の修正(全部のファイルをそろえて当てたもの)のうち、部品ごとに一番新しい記録の版
export function appliedPackageVersions(applied: AppliedFix[], vendorDir = "vendor"): Map<string, string> {
  const out = new Map<string, { ref: string; at: number }>();
  for (const a of applied) {
    if (a.via !== "fix" || !a.package_complete || !SEMVER.test(a.ref)) continue;
    const m = new RegExp(`^${vendorDir}/([a-z0-9][a-z0-9_.\\-]*/[a-z0-9][a-z0-9_.\\-]*)/`).exec(a.path);
    if (!m || m[1].includes("..")) continue;
    const cur = out.get(m[1]);
    if (!cur || a.at > cur.at) out.set(m[1], { ref: a.ref, at: a.at });
  }
  return new Map([...out].map(([k, v]) => [k, v.ref]));
}

// 上げ先の配布物の部品の一覧と比べて、残す部品を決める。当てた版のほうが新しいものだけ(同じか古ければ配布物で置き換える)
export function keepList(applied: AppliedFix[], releasePackages: { name: string; version: string }[]): KeepPackage[] {
  const mine = appliedPackageVersions(applied);
  const out: KeepPackage[] = [];
  for (const p of releasePackages) {
    const v = mine.get(p.name);
    if (!v) continue;
    const c = semverCmp(v, p.version);
    if (c !== null && c > 0) out.push({ name: p.name, version: v, release_version: p.version });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// 印に入れる形(プラグインと窓口と同じ): "vendor/package@版" を名前の順にカンマでつなぐ
export function keepString(keep: KeepPackage[]): string {
  return [...keep].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((k) => `${k.name}@${k.version}`).join(",");
}

// composer.lock の部品の名前と版
export function lockPackages(lockJson: string): { name: string; version: string }[] {
  const lock = JSON.parse(lockJson) as { packages?: { name?: string; version?: string }[]; "packages-dev"?: { name?: string; version?: string }[] };
  return [...(lock.packages ?? []), ...(lock["packages-dev"] ?? [])].filter((p) => p?.name && p?.version).map((p) => ({ name: String(p.name), version: String(p.version) }));
}

// 指紋(窓口の sh_upgrade_fingerprint と同じ作り): vendor/ の全部のファイルと fpPaths の「場所<TAB>sha256」を場所の順に並べたもののハッシュ。無いファイルは "-"
export function fingerprint(mine: Record<string, string>, fpPaths: string[]): string {
  const set = new Set<string>(Object.keys(mine).filter((p) => p.startsWith("vendor/")));
  for (const p of fpPaths) set.add(p);
  const all = [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const h = createHash("sha256");
  for (const p of all) h.update(`${p}\t${mine[p] ?? "-"}\n`);
  return h.digest("hex");
}

// 版上げの提案の「新しい中身」のハッシュ(プラグインが画面で見せたものと承認を結びつける。プラグインの upgradeNewHash と同じ)
export function upgradeNewHash(to: string, fp: string, keep: string): string {
  return createHash("sha256").update(`SH-UPGRADE|${to}|${fp}|${keep}`).digest("hex");
}
