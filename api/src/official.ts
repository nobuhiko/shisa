// SPDX-License-Identifier: GPL-2.0-or-later
// 公式の配布物(EC-CUBE の GitHub 公式リリース)を取ってきて、ファイルごとの SHA-256 の一覧を作る。
// 取りに行くのは決まった公式の場所だけ。版の形も決まりで確かめる
import { gunzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

const RELEASE_BASE = "https://github.com/EC-CUBE/ec-cube/releases/download/";
const VERSION_RE = /^4\.[0-9]+\.[0-9]+(-p[0-9]+)?$/;

export interface Manifest {
  version: string;
  source: string;
  tarball_sha256: string;
  files: Record<string, string>; // path -> sha256
}

const dir = () => join(process.env.SH_DATA_DIR ?? "./data", "official");

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`公式の配布物を取れませんでした: HTTP ${res.status} ${url}`);
  // GitHub のリリースは objects.githubusercontent.com などへ転送される。最初の URL が公式の場所であることは上で決めている
  return Buffer.from(await res.arrayBuffer());
}

async function tarball(version: string): Promise<{ buf: Buffer; sha: string; source: string }> {
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
  const m: Manifest = { version, source, tarball_sha256: sha, files };
  await writeFile(cache, JSON.stringify(m));
  return m;
}

export async function officialContent(version: string, path: string): Promise<Buffer | null> {
  const { buf } = await tarball(version);
  for (const e of entries(gunzipSync(buf))) if (e.path === path) return Buffer.from(e.data);
  return null;
}
