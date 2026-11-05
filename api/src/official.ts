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
// 3 系の修正版(3.0.18-p1〜)は EC-CUBE/ec-cube3 にある。3.0.18 などのもとのタグもここにある
const V3_ARCHIVE = "https://github.com/EC-CUBE/ec-cube3/archive/refs/tags/";
// 2 系(2.x)は EC-CUBE/ec-cube2 のリリース。タグは eccube-<版>。配布物に data/vendor/ は入っていない
const V2_RE = /^(eccube-)?2\.[0-9]+\.[0-9]+(-p[0-9]+)?$/;
const V2_RELEASE = "https://github.com/EC-CUBE/ec-cube2/releases/download/";
// 2 系の修正版(eccube-2.17.2-p2 など)には、リリースの配布物が無いことがある。そのときはタグのソース一式を使う(チェックサムは無い)
const V2_ARCHIVE = "https://github.com/EC-CUBE/ec-cube2/archive/refs/tags/";
export const v2tag = (v: string) => (v.startsWith("eccube-") ? v : `eccube-${v}`);
export const plainVersion = (v: string) => v.replace(/^eccube-/, "");
// 部品のフォルダ(配布物に入っていない系統では比べない)
export const vendorDirOf = (v: string) => (V2_RE.test(v) ? "data/vendor/" : "vendor/");

export interface Manifest {
  version: string;
  source: string;
  tarball_sha256: string;
  files: Record<string, string>; // path -> sha256
  source_only?: boolean; // 部品のフォルダを含まない一覧(3 系はタグのソース、2 系は配布物に data/vendor/ が無い)
  vendor_dir?: string;
}

const dir = () => join(process.env.SH_DATA_DIR ?? "./data", "official");

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`公式の配布物を取れませんでした: HTTP ${res.status} ${url}`);
  // GitHub のリリースは objects.githubusercontent.com などへ転送される。最初の URL が公式の場所であることは上で決めている
  return Buffer.from(await res.arrayBuffer());
}

async function tarball(version: string): Promise<{ buf: Buffer; sha: string; source: string }> {
  if (V2_RE.test(version)) {
    const tag = v2tag(version);
    await mkdir(dir(), { recursive: true });
    const path = join(dir(), `${tag}.tar.gz`);
    const release = `${V2_RELEASE}${tag}/${tag}.tar.gz`;
    const srcPath = join(dir(), `eccube-src-${tag}.tar.gz`);
    const archive = `${V2_ARCHIVE}${tag}.tar.gz`;
    let buf: Buffer;
    let source = release;
    try {
      buf = await readFile(path);
    } catch {
      try {
        buf = await readFile(srcPath);
        source = archive;
      } catch {
        try {
          buf = await download(release);
          const expect = (await download(`${release}.checksum.sha256`)).toString("utf8").trim().split(/\s+/)[0];
          const got = createHash("sha256").update(buf).digest("hex");
          if (expect !== got) throw new Error(`公式の配布物の SHA-256 が公式の値と合いません(${got} != ${expect})`);
          await writeFile(path, buf);
        } catch (e) {
          if (!/HTTP 404/.test((e as Error).message)) throw e;
          // リリースの配布物が無い版は、公式リポジトリのタグのソース一式(https の github.com だけ)
          buf = await download(archive);
          source = archive;
          await writeFile(srcPath, buf);
        }
      }
    }
    return { buf, sha: createHash("sha256").update(buf).digest("hex"), source };
  }
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
  version = V2_RE.test(version) ? plainVersion(version) : version;
  const cache = join(dir(), `manifest-${version}.json`);
  try {
    return JSON.parse(await readFile(cache, "utf8"));
  } catch {
    /* 作る */
  }
  const { buf, sha, source } = await tarball(version);
  const files: Record<string, string> = {};
  for (const e of entries(gunzipSync(buf))) files[e.path] = createHash("sha256").update(e.data).digest("hex");
  const m: Manifest = { version, source, tarball_sha256: sha, files, ...(V3_RE.test(version) || V2_RE.test(version) ? { source_only: true, vendor_dir: vendorDirOf(version) } : {}) };
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
  patches?: Record<string, string>; // ファイルごとの公式の差分(手で当て済みかを見分けるのに使う。大きいファイルは GitHub が省くので無いこともある)
}

function inShopCode(p: string) {
  return /^(src|app|html)\//.test(p) || (!p.includes("/") && /\.php$/.test(p));
}

export async function officialFixScope(installed: string, ref: string): Promise<FixScope> {
  let url: string;
  const v2 = V2_RE.test(installed);
  const v3 = V3_RE.test(installed);
  const api = v2 ? "https://api.github.com/repos/EC-CUBE/ec-cube2" : v3 ? "https://api.github.com/repos/EC-CUBE/ec-cube3" : GH_API;
  if (SHA_RE.test(ref)) url = `${api}/commits/${ref}`;
  else if (TAG_RE.test(ref) && TAG_RE.test(installed)) url = `${GH_API}/compare/${installed}...${ref}`;
  else if (v2 && V2_RE.test(ref)) url = `${api}/compare/${v2tag(installed)}...${v2tag(ref)}`;
  else if (v3 && V3_RE.test(ref)) url = `${api}/compare/${installed}...${ref}`;
  else throw new Error(`公式の修正の範囲を出せない版の指定です: ${ref}`);
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "self-harden" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`公式の修正の範囲を取れませんでした: HTTP ${res.status}`);
  const data = (await res.json()) as { files?: { filename: string; status: string; patch?: string }[] };
  const all = (data.files ?? []).map((f) => f.filename);
  const blockers = all.filter((p) => /^app\/DoctrineMigrations\//.test(p) || /^src\/Eccube\/Entity\//.test(p) || p === "composer.lock" || p === "composer.json" || (v2 && /^html\/install\/sql\//.test(p)));
  const inCode = v3 ? (p: string) => /^(src|app|html)\//.test(p) && !/^app\/config\//.test(p) : v2 ? (p: string) => /^(data|html)\//.test(p) && !/^data\/vendor\//.test(p) && !/^html\/install\//.test(p) : inShopCode;
  const files = all.filter((p) => inCode(p) && !blockers.includes(p) && (data.files ?? []).find((f) => f.filename === p)?.status !== "removed");
  const patches: Record<string, string> = {};
  for (const f of data.files ?? []) if (files.includes(f.filename) && typeof f.patch === "string") patches[f.filename] = f.patch;
  return { files, blockers, source: url.replace("https://api.github.com/repos/", "https://github.com/"), patches };
}

// ---- 部品(vendor/)の修正の「全部のファイル」を、その部品の公式リポジトリ(composer.lock の置き場)の差分から出す ----
export interface VendorScope { files: string[]; source: string }
const TEST_LIKE = /(^|\/)(tests?|Tests?|docs?|\.github|\.git[a-z]*)(\/|$)|^\./;

export async function vendorFixScope(pkg: { name: string; source: string | null; reference: string | null }, toTag: string, shopFiles: Set<string>, vendorDir = "vendor"): Promise<VendorScope> {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(\.git)?$/.exec(pkg.source ?? "");
  if (!m || !pkg.reference || !/^[0-9a-f]{40}$/.test(pkg.reference)) throw new Error(`composer.lock に GitHub の公式の置き場が書かれていない部品です: ${pkg.name}`);
  if (!/^v?[0-9]+\.[0-9]+\.[0-9]+$/.test(toTag)) throw new Error(`部品の版の形が正しくありません: ${toTag}`);
  const url = `https://api.github.com/repos/${m[1]}/${m[2]}/compare/${pkg.reference}...${toTag}`;
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "self-harden" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`部品の修正の範囲を取れませんでした: HTTP ${res.status}`);
  const data = (await res.json()) as { files?: { filename: string; status: string }[] };
  const base = `${vendorDir}/${pkg.name}/`;
  // 店に置かれている部品の中身だけ(テストや文書など、配布物から外されるものは除く)。消されたファイルは置かない
  const files = (data.files ?? [])
    .filter((f) => f.status !== "removed")
    .map((f) => base + f.filename)
    .filter((p) => shopFiles.has(p) || !TEST_LIKE.test(p.slice(base.length)));
  return { files, source: url.replace("https://api.github.com/repos/", "https://github.com/") };
}
