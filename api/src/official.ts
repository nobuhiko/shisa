// SPDX-License-Identifier: GPL-2.0-or-later
// 公式の配布物(EC-CUBE の GitHub 公式リリース)を取ってきて、ファイルごとの SHA-256 の一覧を作る。
// 取りに行くのは決まった公式の場所だけ。版の形も決まりで確かめる
import { gunzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

const RELEASE_BASE = "https://github.com/EC-CUBE/ec-cube/releases/download/";
const VERSION_RE = /^4\.[0-9]+\.[0-9]+(-p[0-9]+)?$/;
// 3 系(3.0.x)は GitHub のリリースに配布物が添付されていない。公式リポジトリのタグのソース一式を正本にする(vendor/ は含まれない)
const V3_RE = /^3\.0\.[0-9]+(-p[0-9]+)?$/;
const V3_ARCHIVE = "https://github.com/EC-CUBE/ec-cube/archive/refs/tags/";

export interface Manifest {
  version: string;
  source: string;
  tarball_sha256: string;
  files: Record<string, string>; // path -> sha256
  source_only?: boolean; // タグのソース一式から作った一覧(vendor/ を含まない。3 系)
}

const dir = () => join(process.env.SH_DATA_DIR ?? "./data", "official");

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`公式の配布物を取れませんでした: HTTP ${res.status} ${url}`);
  // GitHub のリリースは objects.githubusercontent.com などへ転送される。最初の URL が公式の場所であることは上で決めている
  return Buffer.from(await res.arrayBuffer());
}

async function tarball(version: string): Promise<{ buf: Buffer; sha: string; source: string }> {
  if (V3_RE.test(version)) {
    await mkdir(dir(), { recursive: true });
    const path = join(dir(), `eccube-src-${version}.tar.gz`);
    const source = `${V3_ARCHIVE}${version}.tar.gz`;
    let buf: Buffer;
    try {
      buf = await readFile(path);
    } catch {
      // タグのソース一式にはチェックサムが無い。取るのは公式リポジトリ(https の github.com)だけ
      buf = await download(source);
      await writeFile(path, buf);
    }
    return { buf, sha: createHash("sha256").update(buf).digest("hex"), source };
  }
  if (!VERSION_RE.test(version)) throw new Error(`版の形が正しくありません: ${version}`);
  await mkdir(dir(), { recursive: true });
  const path = join(dir(), `eccube-${version}.tar.gz`);
  const source = `${RELEASE_BASE}${version}/eccube-${version}.tar.gz`;
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch {
    buf = await download(source);
    const expect = (await download(`${source}.checksum.sha256`)).toString("utf8").trim().split(/\s+/)[0];
    const got = createHash("sha256").update(buf).digest("hex");
    if (expect !== got) throw new Error(`公式の配布物の SHA-256 が公式の値と合いません(${got} != ${expect})`);
    await writeFile(path, buf);
  }
  return { buf, sha: createHash("sha256").update(buf).digest("hex"), source };
}

// 小さな tar の読み取り(ustar と pax の長い名前)
function* entries(tar: Buffer): Generator<{ path: string; data: Buffer }> {
  let off = 0;
  let paxPath: string | null = null;
  let longName: string | null = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a: number, b: number) => h.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(str(124, 136).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(345, 500);
    let name = (prefix ? prefix + "/" : "") + str(0, 100);
    const data = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const m = /\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
      paxPath = m ? m[1] : null;
      continue;
    }
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (paxPath) name = paxPath;
    if (longName) name = longName;
    paxPath = longName = null;
    if (type === "0" || type === "\0") yield { path: name.replace(/^[^/]+\//, ""), data };
  }
}

export async function manifest(version: string): Promise<Manifest> {
  const cache = join(dir(), `manifest-${version}.json`);
  try {
    return JSON.parse(await readFile(cache, "utf8"));
  } catch {
    /* 作る */
  }
  const { buf, sha, source } = await tarball(version);
  const files: Record<string, string> = {};
  for (const e of entries(gunzipSync(buf))) files[e.path] = createHash("sha256").update(e.data).digest("hex");
  const m: Manifest = { version, source, tarball_sha256: sha, files, ...(V3_RE.test(version) ? { source_only: true } : {}) };
  await writeFile(cache, JSON.stringify(m));
  return m;
}

export async function officialContent(version: string, path: string): Promise<Buffer | null> {
  const { buf } = await tarball(version);
  for (const e of entries(gunzipSync(buf))) if (e.path === path) return Buffer.from(e.data);
  return null;
}

// ---- 公式の修正の「全部のファイル」を、公式のデータ(GitHub の EC-CUBE 公式リポジトリ)から出す ----
const GH_API = "https://api.github.com/repos/EC-CUBE/ec-cube";
const SHA_RE = /^[0-9a-f]{40}$/;
const TAG_RE = /^4\.[0-9]+\.[0-9]+(-p[0-9]+)?$/;

export interface FixScope {
  files: string[]; // 店に置く対象(src/ app/ html/ と root 直下のファイル)
  blockers: string[]; // この手ではやりきれない変更(DB の作り変え、部品の入れ替え)
  source: string;
}

function inShopCode(p: string) {
  return /^(src|app|html)\//.test(p) || (!p.includes("/") && /\.php$/.test(p));
}

export async function officialFixScope(installed: string, ref: string): Promise<FixScope> {
  let url: string;
  if (SHA_RE.test(ref)) url = `${GH_API}/commits/${ref}`;
  else if (TAG_RE.test(ref) && TAG_RE.test(installed)) url = `${GH_API}/compare/${installed}...${ref}`;
  else throw new Error(`公式の修正の範囲を出せない版の指定です: ${ref}`);
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "self-harden" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`公式の修正の範囲を取れませんでした: HTTP ${res.status}`);
  const data = (await res.json()) as { files?: { filename: string; status: string }[] };
  const all = (data.files ?? []).map((f) => f.filename);
  const blockers = all.filter((p) => /^app\/DoctrineMigrations\//.test(p) || /^src\/Eccube\/Entity\//.test(p) || p === "composer.lock" || p === "composer.json");
  const files = all.filter((p) => inShopCode(p) && !blockers.includes(p) && (data.files ?? []).find((f) => f.filename === p)?.status !== "removed");
  return { files, blockers, source: url.replace("https://api.github.com/repos/", "https://github.com/") };
}

// ---- 部品(vendor/)の修正の「全部のファイル」を、その部品の公式リポジトリ(composer.lock の置き場)の差分から出す ----
export interface VendorScope { files: string[]; source: string }
const TEST_LIKE = /(^|\/)(tests?|Tests?|docs?|\.github|\.git[a-z]*)(\/|$)|^\./;

export async function vendorFixScope(pkg: { name: string; source: string | null; reference: string | null }, toTag: string, shopFiles: Set<string>): Promise<VendorScope> {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(\.git)?$/.exec(pkg.source ?? "");
  if (!m || !pkg.reference || !/^[0-9a-f]{40}$/.test(pkg.reference)) throw new Error(`composer.lock に GitHub の公式の置き場が書かれていない部品です: ${pkg.name}`);
  if (!/^v?[0-9]+\.[0-9]+\.[0-9]+$/.test(toTag)) throw new Error(`部品の版の形が正しくありません: ${toTag}`);
  const url = `https://api.github.com/repos/${m[1]}/${m[2]}/compare/${pkg.reference}...${toTag}`;
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "self-harden" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`部品の修正の範囲を取れませんでした: HTTP ${res.status}`);
  const data = (await res.json()) as { files?: { filename: string; status: string }[] };
  const base = `vendor/${pkg.name}/`;
  // 店に置かれている部品の中身だけ(テストや文書など、配布物から外されるものは除く)。消されたファイルは置かない
  const files = (data.files ?? [])
    .filter((f) => f.status !== "removed")
    .map((f) => base + f.filename)
    .filter((p) => shopFiles.has(p) || !TEST_LIKE.test(p.slice(base.length)));
  return { files, source: url.replace("https://api.github.com/repos/", "https://github.com/") };
}
