// SPDX-License-Identifier: GPL-2.0-or-later
// Agent が使える道具。受け口の操作に薄くつなぐだけで、何をするかは Agent が決める。
// 道具は手段だけを渡す。特定の弱点や回避策の答えはここに書かない
import type Anthropic from "@anthropic-ai/sdk";
import { createPatch } from "diff";
import { callReceiver } from "./receiver.js";
import { manifest, officialContent, officialFixScope } from "./official.js";
import type { Shop, Store } from "./store.js";
import { checkPackages, loadResearch, saveResearch, compareWithPrevious } from "./research.js";

type Tool = Anthropic.Beta.BetaToolUnion;

// どの道具にも「店の人向けの一言」を必須で付ける。画面にはこれを出す
const NOTE = {
  type: "string",
  description: "One short sentence in Japanese for the shop owner: what you are doing with this call and why. Shown live on the admin screen.",
};

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object" as const,
  properties: { note: NOTE, ...properties },
  required: ["note", ...required],
  additionalProperties: false,
});

export const CLIENT_TOOLS: Tool[] = [
  {
    name: "inspect",
    description:
      "Read facts about the server the shop runs on: PHP version and SAPI, all effective ini values (as seen by the receiver at the shop root), loaded extensions with versions, server variables, the EC-CUBE version, composer.lock packages, .env keys (values redacted), and writable paths.",
    input_schema: obj({
      sections: { type: "array", items: { type: "string", enum: ["php", "ini", "extensions", "server", "app", "paths"] } },
    }),
  },
  {
    name: "list_dir",
    description: "List entries of a directory under the shop root (relative path, '' for the root). depth 0-2. Symlinks are listed but not followed.",
    input_schema: obj({ path: { type: "string" }, depth: { type: "integer", minimum: 0, maximum: 2 } }, ["path"]),
  },
  {
    name: "read_file",
    description:
      "Read a text file (up to 256KB) under the shop root: configuration files (.htaccess, .user.ini, composer.json, composer.lock, robots.txt), files of the application under src/, app/, html/, vendor/ and files directly under the root, and backups under var/self-harden/backups/. .env and other files under var/ cannot be read.",
    input_schema: obj({ path: { type: "string" } }, ["path"]),
  },
  {
    name: "http_get",
    description:
      "Fetch a path of this shop from the outside, like a visitor would (GET, no redirects followed). Returns status, headers and the first 4KB of the body. Only this shop's origin is allowed.",
    input_schema: obj({ path: { type: "string", description: "Must start with /" } }, ["path"]),
  },
  {
    name: "compare_with_previous",
    description:
      "Compare a fingerprint of this shop (PHP version and SAPI, ini values, extensions, EC-CUBE version, packages, all file hashes, .htaccess/.user.ini) with the last completed inspection. Returns which parts changed and the previous summary.",
    input_schema: obj({}),
  },
  {
    name: "load_research",
    description:
      "Load research results saved earlier on this API for the given subjects (e.g. \"php 8.1.10\", \"ec-cube 4.2.0\", \"apache 2.4.54\", \"advisory <url>\"). Each result has its date, sources and whether it is still fresh (saved within 7 days).",
    input_schema: obj({ subjects: { type: "array", items: { type: "string" } } }, ["subjects"]),
  },
  {
    name: "save_research",
    description:
      "Save what you found about one subject (a product and version, or an advisory URL) so later inspections can reuse it for 7 days. Include for each issue whether it is exploited in the wild, whether it is reachable without authentication, official fixes and official workarounds, each with primary sources.",
    input_schema: obj(
      {
        subject: { type: "string" },
        summary: { type: "string" },
        findings: { type: "array", items: { type: "object" } },
        sources: { type: "array", items: { type: "object", properties: { title: { type: "string" }, url: { type: "string" } }, required: ["url"] } },
      },
      ["subject", "findings", "sources"],
    ),
  },
  {
    name: "check_packages",
    description:
      "Check every package in the shop's composer.lock against the Packagist security-advisories API (official advisories for Composer packages). Returns the advisories whose affected versions include the installed version, most severe first.",
    input_schema: obj({}),
  },
  {
    name: "compare_with_official",
    description:
      "Compare every file of the shop (root files, app/, html/, src/, vendor/) with the official EC-CUBE release of the installed version, by SHA-256. Returns files that differ from the official release, files that are not in the official release, and files of the official release that are missing. Files that self-harden itself changed by applying official fixes (and that still have the content it wrote) are listed separately as intended; do not revert them to the release. Takes some time on large installations.",
    input_schema: obj({
      only_php: { type: "boolean", description: "List only PHP-like files among the added files (default true)" },
    }),
  },
  {
    name: "diff_with_official",
    description: "Show a unified diff between the shop's file and the same file in the official release of the installed version.",
    input_schema: obj({ path: { type: "string" } }, ["path"]),
  },
  {
    name: "restore_official",
    description:
      "Use this to undo tampering: replace one existing file of the shop (whose folder exists) (under src/, app/, html/, vendor/ or directly under the root) with its official content. You only name the file and the official version (ref); the receiver itself fetches the content from fixed official sources (the EC-CUBE GitHub repository, or for vendor/ files the GitHub repository written in composer.lock). For EC-CUBE files, ref is a release tag not older than the installed version, or a commit hash of the official repository. For vendor/ files, ref is the locked reference or a newer tag of the same major version. A backup is taken first; after writing, the receiver opens the shop pages and rolls back on a server error.",
    input_schema: obj(
      {
        path: { type: "string" },
        ref: { type: "string" },
        extra_verify_paths: { type: "array", items: { type: "string" }, description: "More shop paths to open after writing (e.g. the admin login page)" },
      },
      ["path", "ref"],
    ),
  },
  {
    name: "apply_official_fix",
    description:
      "Apply an official fix as one unit: every file of the fix at the given official ref. For EC-CUBE itself, the API checks the official repository (the commit's files, or the difference between the installed release and the given release tag) and refuses unless you list all of those files; a release tag of the same line (for example a patch release) therefore updates the installed version as a whole. Changes that need database migrations or Composer package changes are refused. Ref (an EC-CUBE release tag not older than the installed version or a full 40-character commit hash of the official repository; for vendor/ files, a newer tag of the same major version of that package's official repository). The receiver first fetches all files from the official sources; if any file cannot be fetched, nothing is written. Then it backs up and writes all files (creating missing folders inside src/, app/, html/, vendor/ only), opens the shop pages, and rolls back everything if the shop breaks. List every file the official fix changes or adds.",
    input_schema: obj(
      {
        ref: { type: "string" },
        paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 30 },
        reason: { type: "string", description: "Which official fix this is (advisory id and source URL)" },
        extra_verify_paths: { type: "array", items: { type: "string" } },
      },
      ["ref", "paths", "reason"],
    ),
  },
  {
    name: "quarantine",
    description:
      "Move a suspicious file out of the web-reachable tree into the receiver's quarantine (not deleted; it can be released back). After moving, the receiver opens the shop pages and moves the file back if the shop breaks.",
    input_schema: obj({ path: { type: "string" } }, ["path"]),
  },
  {
    name: "release_quarantine",
    description: "Move a quarantined file back to its original place.",
    input_schema: obj({ quarantine_id: { type: "string" } }, ["quarantine_id"]),
  },
  {
    name: "clear_cache",
    description: "Clear the application's compiled cache (var/cache/prod), as the official instructions often require after replacing program files. The receiver moves the cache aside and deletes it, then opens the shop pages.",
    input_schema: obj({}),
  },
  {
    name: "list_quarantine",
    description: "List quarantined files.",
    input_schema: obj({}),
  },
  {
    name: "lab_test",
    description:
      "Try a configuration in the lab directory (/self-harden-lab/) without touching the shop. Writes the given full content to the lab's .htaccess or .user.ini (empty string removes the content), then requests the lab's probe from the outside and returns the HTTP status and the effective ini values seen by PHP inside the lab. Pass ini_keys to get only those values.",
    input_schema: obj(
      {
        file: { type: "string", enum: [".htaccess", ".user.ini"] },
        content: { type: "string" },
        ini_keys: { type: "array", items: { type: "string" } },
      },
      ["file", "content"],
    ),
  },
  {
    name: "probe_lab",
    description: "Request the lab's probe again without changing anything, and return the status and ini values (optionally only ini_keys).",
    input_schema: obj({ ini_keys: { type: "array", items: { type: "string" } } }),
  },
  {
    name: "write_file",
    description:
      "Write the full content of a configuration file of the shop. target is one of root/.htaccess, root/.user.ini, or dir:<existing directory relative to root>/.htaccess. A backup is always taken first. Right after writing, the receiver opens the shop's top page and itself; on a server error it rolls back in the same request. If the new content drops lines that are in the current file, the write is refused unless allow_removing_lines is true and you say why in removing_reason. Returns the added and removed lines.",
    input_schema: obj(
      {
        target: { type: "string" },
        content: { type: "string" },
        allow_removing_lines: { type: "boolean" },
        removing_reason: { type: "string" },
      },
      ["target", "content"],
    ),
  },
  {
    name: "restore",
    description: "Restore a file from a backup taken by write_file or restore_official (use the backup_id). The current content is backed up again before restoring.",
    input_schema: obj({ backup_id: { type: "string" } }, ["backup_id"]),
  },
  {
    name: "list_backups",
    description: "List backups taken so far (newest first).",
    input_schema: obj({}),
  },
  {
    name: "decide",
    description:
      "Record a decision the shop owner should see, as one short plain Japanese sentence in note (about 40 characters; the reason can be short too) (for example whether a pasted advisory applies to this shop, whether to keep the shop open, or which mechanism you chose and why). It changes nothing on the shop; it is shown on the admin screen as a decision.",
    input_schema: obj({ topic: { type: "string", enum: ["advisory_applies", "advisory_not_applicable", "keep_shop_open", "mechanism", "other"] } }, ["topic"]),
  },
  {
    name: "wait",
    description: "Pause for the given number of seconds (max 360). The pause happens between this turn and the next one, so call wait alone (or as the last call of a turn) and do the checks in the next turn; calls placed after wait in the same turn are not run.",
    input_schema: obj({ seconds: { type: "integer", minimum: 1, maximum: 360 } }, ["seconds"]),
  },
  {
    name: "report",
    description: "Finish the session with the final report for the shop owner. All text in Japanese. Call exactly once, at the end.",
    input_schema: obj(
      {
        summary: { type: "string", description: "3 lines for the shop owner" },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              severity: { type: "string", enum: ["high", "medium", "low", "info"] },
              evidence: { type: "string" },
              status: { type: "string", enum: ["fixed", "mitigated", "needs_human", "not_affected"] },
            },
            required: ["title", "severity", "evidence", "status"],
            additionalProperties: false,
          },
        },
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: { title: { type: "string" }, target: { type: "string" }, backup_id: { type: "string" }, verified: { type: "string" } },
            required: ["title", "target", "verified"],
            additionalProperties: false,
          },
        },
        status: { type: "string", description: "Where the shop's defense stands now, in 2-3 plain sentences" },
        next_by_self_harden: {
          type: "array",
          description: "What self-harden itself will keep doing (for example re-checking, applying an official fix when it is published)",
          items: { type: "object", properties: { title: { type: "string" }, when: { type: "string" } }, required: ["title"], additionalProperties: false },
        },
        requests: {
          type: "array",
          description: "Only what truly cannot be done from the shop side. Each with a ready-to-send message",
          items: {
            type: "object",
            properties: { to: { type: "string" }, title: { type: "string" }, why: { type: "string" }, message: { type: "string", description: "Ready-to-send message in Japanese" } },
            required: ["to", "title", "why", "message"],
            additionalProperties: false,
          },
        },
        long_term: {
          type: "array",
          description: "Version upgrades and other long-term improvements, for later",
          items: { type: "object", properties: { title: { type: "string" }, why: { type: "string" } }, required: ["title", "why"], additionalProperties: false },
        },
        sources: {
          type: "array",
          items: { type: "object", properties: { title: { type: "string" }, url: { type: "string" } }, required: ["title", "url"], additionalProperties: false },
        },
      },
      ["summary", "findings", "actions", "status", "next_by_self_harden", "requests", "long_term", "sources"],
    ),
  },
];

export const SERVER_TOOLS: Tool[] = [
  { type: "web_search_20260209", name: "web_search", max_uses: 10 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 10 },
];

export interface ToolOutcome {
  content: string;
  isError?: boolean;
  waitSec?: number;
  report?: unknown;
  decision?: boolean;
  title: string; // 道具の名前(画面では一言の横に小さく出す)
}

const LAB_PATH = { ".htaccess": "self-harden-lab/.htaccess", ".user.ini": "self-harden-lab/.user.ini" } as const;
const PHP_LIKE = /\.(php[0-9]?|phtml|phar|inc)$/i;

function targetToPath(target: string): string | null {
  if (target === "root/.htaccess") return ".htaccess";
  if (target === "root/.user.ini") return ".user.ini";
  if (target.startsWith("dir:")) return target.slice(4);
  return null;
}

async function currentFile(shop: Shop, path: string): Promise<{ sha: string | null; content: string }> {
  const r = await callReceiver(shop, "read_file", { path });
  if (r.ok && r.result.exists) return { sha: r.result.sha256 as string, content: r.result.content as string };
  return { sha: null, content: "" };
}

const lines = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));

function lineDiff(before: string, after: string) {
  const a = lines(before);
  const b = lines(after);
  const bs = new Set(b);
  const as = new Set(a);
  return { removed: a.filter((l) => !bs.has(l)), added: b.filter((l) => !as.has(l)) };
}

export async function httpGet(shop: Shop, path: string) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) throw new Error("path must start with a single /");
  const origin = new URL(shop.shop_url).origin;
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new Error("only this shop's origin is allowed");
  const t0 = Date.now();
  const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  const body = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (k !== "set-cookie") headers[k] = v;
  });
  return { status: res.status, ms: Date.now() - t0, headers, body: body.slice(0, 4096), body_length: body.length };
}

async function probe(shop: Shop, iniKeys?: string[]) {
  const arm = await callReceiver(shop, "lab_arm", {});
  if (!arm.ok) return { error: arm };
  const url = new URL(`${arm.result.probe_path}?t=${arm.result.token}`, new URL(shop.shop_url).origin);
  const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  const out: Record<string, unknown> = { status: res.status };
  try {
    const parsed = JSON.parse(text);
    out.sapi = parsed.sapi;
    out.php_version = parsed.php_version;
    out.ini = iniKeys && iniKeys.length ? Object.fromEntries(iniKeys.map((k) => [k, parsed.ini?.[k] ?? null])) : parsed.ini;
  } catch {
    out.body = text.slice(0, 1000);
  }
  return out;
}

async function installedVersion(shop: Shop): Promise<string> {
  const r = await callReceiver(shop, "inspect", { sections: ["app"] });
  const v = r.ok ? r.result.app?.eccube_version : null;
  if (!v) throw new Error("EC-CUBE の版を読めませんでした");
  return v;
}

async function shopHashes(shop: Shop): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let cursor = "";
  for (let i = 0; i < 100; i++) {
    const r = await callReceiver(shop, "hash_tree", { limit: 5000, cursor });
    if (!r.ok) throw new Error(`hash_tree: ${r.error} ${r.detail ?? ""}`);
    for (const [p, sha] of r.result.files as [string, string, number][]) out[p] = sha;
    if (!r.result.next_cursor) return out;
    cursor = r.result.next_cursor;
  }
  throw new Error("ファイルが多すぎて一覧を取り切れませんでした");
}

function verifyPaths(shop: Shop, extra: unknown): string[] {
  const receiverPath = new URL(shop.receiver_url).pathname;
  const ex = Array.isArray(extra) ? extra.filter((p): p is string => typeof p === "string" && p.startsWith("/")).slice(0, 2) : [];
  return ["/", "/products/list", "/cart", receiverPath, ...ex].slice(0, 6);
}

const j = (v: unknown) => JSON.stringify(v);

export interface ToolContext {
  store: Store;
  runId: string;
}

export async function runTool(shop: Shop, name: string, input: any, ctx?: ToolContext): Promise<ToolOutcome> {
  switch (name) {
    case "compare_with_previous": {
      if (!ctx) return { content: j({ error: "no context" }), isError: true, title: "前回と比べる" };
      try {
        return { content: j(await compareWithPrevious(ctx.store, shop, ctx.runId)), title: "前回の点検と比べる" };
      } catch (e) {
        return { content: j({ error: (e as Error).message }), isError: true, title: "前回の点検と比べる" };
      }
    }
    case "load_research": {
      if (!ctx) return { content: j({ error: "no context" }), isError: true, title: "調べた結果の控えを見る" };
      return { content: j(await loadResearch(ctx.store, Array.isArray(input.subjects) ? input.subjects : [])), title: "調べた結果の控えを見る" };
    }
    case "save_research": {
      if (!ctx) return { content: j({ error: "no context" }), isError: true, title: "調べた結果を控える" };
      return { content: j(await saveResearch(ctx.store, String(input.subject), input)), title: `調べた結果を控える: ${input.subject}` };
    }
    case "check_packages": {
      try {
        return { content: j(await checkPackages(shop)), title: "部品の弱点を Packagist で照らし合わせる" };
      } catch (e) {
        return { content: j({ error: (e as Error).message }), isError: true, title: "部品の弱点を Packagist で照らし合わせる" };
      }
    }
    case "inspect": {
      const r = await callReceiver(shop, "inspect", input?.sections ? { sections: input.sections } : {});
      return { content: j(r), isError: !r.ok, title: "サーバーを調べる" };
    }
    case "list_dir": {
      const r = await callReceiver(shop, "list_dir", { path: input.path ?? "", depth: input.depth ?? 0 });
      return { content: j(r), isError: !r.ok, title: `ファイルの一覧: /${input.path ?? ""}` };
    }
    case "read_file": {
      const r = await callReceiver(shop, "read_file", { path: input.path });
      return { content: j(r), isError: !r.ok, title: `ファイルを読む: ${input.path}` };
    }
    case "http_get": {
      try {
        return { content: j(await httpGet(shop, input.path)), title: `外から開く: ${input.path}` };
      } catch (e) {
        return { content: j({ error: (e as Error).message }), isError: true, title: `外から開く: ${input.path}` };
      }
    }
    case "compare_with_official": {
      try {
        const version = await installedVersion(shop);
        const m = await manifest(version);
        const mine = await shopHashes(shop);
        const applied = ctx ? await ctx.store.getApplied(shop.shop_id) : [];
        const intendedBy = new Map(applied.map((f) => [f.path, f]));
        const onlyPhp = input?.only_php !== false;
        const modified: string[] = [];
        const added: string[] = [];
        const intended: unknown[] = [];
        let addedOther = 0;
        for (const [p, sha] of Object.entries(mine)) {
          const fx = intendedBy.get(p);
          if (fx && fx.sha256 === sha) {
            intended.push({ path: p, ref: fx.ref, reason: fx.reason, applied_at: new Date(fx.at).toISOString() });
            continue;
          }
          if (p in m.files) {
            if (m.files[p] !== sha) modified.push(p);
          } else if (!onlyPhp || PHP_LIKE.test(p)) added.push(p);
          else addedOther++;
        }
        const missing = Object.keys(m.files).filter((p) => !(p in mine));
        const byTop = (ps: string[]) => ps.reduce<Record<string, number>>((a, p) => ((a[p.split("/")[0]] = (a[p.split("/")[0]] ?? 0) + 1), a), {});
        return {
          content: j({
            official: { version, source: m.source, tarball_sha256: m.tarball_sha256, files: Object.keys(m.files).length },
            shop_files: Object.keys(mine).length,
            intended: { count: intended.length, note: "official fixes applied by self-harden, still as written", items: intended },
            modified: { count: modified.length, by_top: byTop(modified), paths: modified.sort().slice(0, 300) },
            added: { count: added.length, by_top: byTop(added), paths: added.sort().slice(0, 300), other_files_not_listed: addedOther },
            missing: { count: missing.length, by_top: byTop(missing), sample: missing.sort().slice(0, 30) },
          }),
          title: "公式の配布物と照らし合わせる",
        };
      } catch (e) {
        return { content: j({ error: (e as Error).message }), isError: true, title: "公式の配布物と照らし合わせる" };
      }
    }
    case "diff_with_official": {
      try {
        const version = await installedVersion(shop);
        const r = await callReceiver(shop, "read_file", { path: input.path });
        if (!r.ok) return { content: j(r), isError: true, title: `公式との違いを見る: ${input.path}` };
        const off = await officialContent(version, input.path);
        if (!off) return { content: j({ official: null, note: "not in the official release" }), title: `公式との違いを見る: ${input.path}` };
        const mineText = r.result.exists ? (r.result.content as string) : "";
        const patch = createPatch(input.path, off.toString("utf8"), mineText, `official ${version}`, "shop");
        return { content: j({ version, diff: patch.length > 12000 ? patch.slice(0, 12000) + "\n…(truncated)" : patch }), title: `公式との違いを見る: ${input.path}` };
      } catch (e) {
        return { content: j({ error: (e as Error).message }), isError: true, title: `公式との違いを見る: ${input.path}` };
      }
    }
    case "restore_official": {
      const args: Record<string, unknown> = { path: input.path, ref: input.ref, verify: { paths: verifyPaths(shop, input.extra_verify_paths), timeout_sec: 8 } };
      try {
        // 入っている版と同じタグに戻すときは、公式リリースの SHA-256 と一致することも受け口に確かめさせる
        const version = await installedVersion(shop);
        if (input.ref === version) {
          const m = await manifest(version);
          if (m.files[input.path]) args.expected_sha256 = m.files[input.path];
        }
      } catch {
        /* 一覧が無くても、受け口は公式の場所からしか取らない */
      }
      const r = await callReceiver(shop, "restore_official", args);
      // 入っている版とは別の版にしたもの(= 修正)は記録して、次の照らし合わせで戻さないようにする
      if (r.ok && !r.result.rolled_back && ctx) {
        let installed: string | null = null;
        try { installed = await installedVersion(shop); } catch { /* 分からなければ記録する */ }
        if (input.ref !== installed) {
          await ctx.store.addApplied(shop.shop_id, [{ path: input.path, sha256: r.result.sha256_after, ref: String(input.ref), source: r.result.source, reason: "restore_official", run_id: ctx.runId, at: Date.now() }]);
        }
      }
      return { content: j(r), isError: !r.ok, title: `公式の中身に戻す: ${input.path} @ ${input.ref}` };
    }
    case "apply_official_fix": {
      const paths: string[] = Array.isArray(input.paths) ? input.paths.map(String) : [];
      // EC-CUBE 本体の修正は、公式のデータで「全部のファイル」がそろっているかを確かめてから当てる(半端に置かない)
      if (!paths.some((p) => p.startsWith("vendor/"))) {
        try {
          const scope = await officialFixScope(await installedVersion(shop), String(input.ref));
          const missing = scope.files.filter((f) => !paths.includes(f));
          if (scope.blockers.length) {
            return { content: j({ ok: false, error: "needs_db_or_vendor_change", detail: "This official change also alters the database schema/migrations or Composer packages; it cannot be applied with these tools. Apply nothing and report it.", blockers: scope.blockers, source: scope.source }), isError: true, title: `公式の修正を当てる: ${input.ref}` };
          }
          // お店の改造を上書きしない: 当てる先が、今の版の公式の中身と違えば(self-harden が当てたものを除く)断る
          const version = await installedVersion(shop);
          const m = await manifest(version);
          const applied = ctx ? await ctx.store.getApplied(shop.shop_id) : [];
          const customized: string[] = [];
          for (const p of paths) {
            if (!m.files[p]) continue; // 公式に無い新しいファイル
            const cur = await currentFile(shop, p);
            if (cur.sha && cur.sha !== m.files[p] && !applied.some((a) => a.path === p && a.sha256 === cur.sha)) customized.push(p);
          }
          if (customized.length) {
            return { content: j({ ok: false, error: "customized_files", detail: "Nothing was written. These files differ from the official release of the installed version (likely the shop's own customization); applying official files would erase it. Report it to a person instead.", customized, source: scope.source }), isError: true, title: `公式の修正を当てる: ${input.ref}` };
          }
          if (missing.length) {
            return { content: j({ ok: false, error: "incomplete_fix", detail: "Nothing was written. The official change includes more files; list all of them together.", required_files: scope.files, missing, source: scope.source }), isError: true, title: `公式の修正を当てる: ${input.ref}` };
          }
        } catch (e) {
          return { content: j({ ok: false, error: "scope_unknown", detail: `Could not confirm the full set of files of this official change: ${(e as Error).message}. Nothing was written.` }), isError: true, title: `公式の修正を当てる: ${input.ref}` };
        }
      }
      const r = await callReceiver(shop, "apply_official_fix", {
        ref: input.ref,
        paths: input.paths,
        verify: { paths: verifyPaths(shop, input.extra_verify_paths), timeout_sec: 8 },
      });
      if (r.ok && !r.result.rolled_back && ctx) {
        await ctx.store.addApplied(
          shop.shop_id,
          (r.result.applied as any[]).map((a) => ({ path: a.path, sha256: a.sha256_after, ref: String(input.ref), source: a.source, reason: String(input.reason ?? ""), run_id: ctx.runId, at: Date.now() })),
        );
      }
      return { content: j(r), isError: !r.ok, title: `公式の修正を当てる: ${(input.paths ?? []).length} ファイル @ ${input.ref}` };
    }
    case "quarantine": {
      const r = await callReceiver(shop, "quarantine", { path: input.path, verify: { paths: verifyPaths(shop, null), timeout_sec: 8 } });
      return { content: j(r), isError: !r.ok, title: `隔離する: ${input.path}` };
    }
    case "release_quarantine": {
      const r = await callReceiver(shop, "release_quarantine", { quarantine_id: input.quarantine_id });
      return { content: j(r), isError: !r.ok, title: `隔離から戻す: ${input.quarantine_id}` };
    }
    case "clear_cache": {
      const r = await callReceiver(shop, "clear_cache", { verify: { paths: verifyPaths(shop, ["/admin/login"]), timeout_sec: 8 } });
      return { content: j(r), isError: !r.ok, title: "キャッシュを消す" };
    }
    case "list_quarantine": {
      const r = await callReceiver(shop, "list_quarantine", {});
      return { content: j(r), isError: !r.ok, title: "隔離の一覧を見る" };
    }
    case "lab_test": {
      const file = input.file as keyof typeof LAB_PATH;
      if (!(file in LAB_PATH)) return { content: j({ error: "file must be .htaccess or .user.ini" }), isError: true, title: "小部屋で試す" };
      const arm = await callReceiver(shop, "lab_arm", {}); // 小部屋が無ければ作る
      if (!arm.ok) return { content: j(arm), isError: true, title: "小部屋で試す" };
      const cur = await currentFile(shop, LAB_PATH[file]);
      const w = await callReceiver(shop, "write_file", { target: `lab/${file}`, content: input.content, expected_sha256: cur.sha });
      if (!w.ok) return { content: j({ write: w }), isError: true, title: `小部屋で試す: ${file}` };
      const p = await probe(shop, input.ini_keys);
      return { content: j({ write: { backup_id: w.result.backup_id }, probe: p }), title: `小部屋で試す: ${file}` };
    }
    case "probe_lab": {
      return { content: j(await probe(shop, input?.ini_keys)), title: "小部屋をもう一度確かめる" };
    }
    case "write_file": {
      const path = targetToPath(String(input.target));
      if (!path) return { content: j({ error: "target must be root/.htaccess, root/.user.ini or dir:<dir>/.htaccess" }), isError: true, title: "本番に入れる" };
      const cur = await currentFile(shop, path);
      const d = lineDiff(cur.content, String(input.content ?? ""));
      // 元の行を黙って消させない。消すなら理由を明示させる
      if (d.removed.length && !(input.allow_removing_lines && input.removing_reason)) {
        return {
          content: j({ ok: false, error: "would_remove_lines", detail: "The new content drops lines that are in the current file. Keep them, or set allow_removing_lines with removing_reason.", removed_lines: d.removed }),
          isError: true,
          title: `本番に入れる: ${input.target}`,
        };
      }
      const receiverPath = new URL(shop.receiver_url).pathname;
      const r = await callReceiver(shop, "write_file", {
        target: input.target,
        content: input.content,
        expected_sha256: cur.sha,
        verify: { paths: ["/", "/products/list", receiverPath], timeout_sec: 8 },
      });
      const content = r.ok ? { ...r, added_lines: d.added, removed_lines: d.removed, removing_reason: d.removed.length ? input.removing_reason : undefined } : r;
      return { content: j(content), isError: !r.ok, title: `本番に入れる: ${input.target}` };
    }
    case "restore": {
      const r = await callReceiver(shop, "restore", { backup_id: input.backup_id });
      return { content: j(r), isError: !r.ok, title: `退避から戻す: ${input.backup_id}` };
    }
    case "list_backups": {
      const r = await callReceiver(shop, "list_backups", {});
      return { content: j(r), isError: !r.ok, title: "退避の一覧を見る" };
    }
    case "decide": {
      return { content: j({ ok: true, recorded: input.topic }), title: "判断", decision: true };
    }
    case "wait": {
      const sec = Math.max(1, Math.min(360, Number(input.seconds) || 1));
      return { content: j({ will_wait_seconds: sec, detail: "The pause happens before your next turn. Tools called after wait in this same turn are not run." }), waitSec: sec, title: `${sec} 秒待つ` };
    }
    case "report": {
      return { content: j({ ok: true }), report: input, title: "報告をまとめる" };
    }
    default:
      return { content: j({ error: `unknown tool ${name}` }), isError: true, title: name };
  }
}
