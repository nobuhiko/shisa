// SPDX-License-Identifier: GPL-2.0-or-later
// Agent が使える道具。受け口の操作に薄くつなぐだけで、何をするかは Agent が決める。
// 道具は手段だけを渡す。特定の弱点や回避策の答えはここに書かない
import type Anthropic from "@anthropic-ai/sdk";
import { createPatch } from "diff";
import { callReceiver } from "./receiver.js";
import { vendorFixScope, manifest, officialContent, officialFixScope } from "./official.js";
import type { Shop, Store, Proposal } from "./store.js";
import { checkPackages, loadResearch, saveResearch, compareWithPrevious } from "./research.js";
import { fixAlreadyIn } from "./manualfix.js";
import { sha256Hex, randomHex } from "./sign.js";

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
      "Read a text file (up to 256KB) under the shop root: configuration files (.htaccess, .user.ini, composer.json, composer.lock, robots.txt), files of the application under src/, app/, html/, vendor/ and files directly under the root, and backups under var/self-harden/backups/. .env and other files under var/ cannot be read. With from/to, only those lines are returned (at most 80 lines per call): use this to read just the surroundings of a scan_custom hit instead of the whole file.",
    input_schema: obj(
      {
        path: { type: "string" },
        from: { type: "integer", minimum: 1, description: "First line to return (1-based)" },
        to: { type: "integer", minimum: 1, description: "Last line to return (at most from + 79)" },
      },
      ["path"],
    ),
  },
  {
    name: "http_get",
    description:
      "Fetch a path of this shop from the outside, like a visitor would (GET, no redirects followed). Returns status, headers and the first 4KB of the body. The path is relative to the shop's URL (if the shop lives in a subdirectory, / is that subdirectory); paths outside the shop are refused. extra_verify_paths of the writing tools use the same form.",
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
      "Compare every file of the shop (root files, app/, html/, src/, vendor/) with the official EC-CUBE release of the installed version, by SHA-256. Returns files that differ from the official release, files that are not in the official release, and files of the official release that are missing. Files that self-harden itself changed by applying official fixes (and that still have the content it wrote) are listed separately as intended; do not revert them to the release. Takes some time on large installations. In an EC-CUBE 2 shop whose data/ folder sits inside the public folder (inspect paths.flat = true), the official html/x is the shop's x: this comparison reports official names (html/x, data/...), and the restore/fix/diff/quarantine tools accept either form.",
    input_schema: obj({
      only_php: { type: "boolean", description: "List only PHP-like files among the added files (default true)" },
    }),
  },
  {
    name: "scan_custom",
    description:
      "Check the shop's own custom code locally on the receiver for common risky shapes, without sending whole files: values from the outside (request parameters, cookies, uploaded files, some request headers) flowing into SQL strings, page output without escaping, file operations, or command/code execution; dynamic code; obfuscation; and PHP files placed where only images or uploads belong (misplaced lists them even when the hit limit is reached). Returns only file, line number, kind and that one line (long strings are masked), plus each scanned file's mtime and size, and files much newer than most (newer_than_most). Pass the custom files from compare_with_official (files that differ from the official release and PHP-like files not in it; official names like html/x are accepted). Without paths, the receiver walks the application folders (excluding the vendor folder). At most 400 files and 300 hits per call. A hit is a lead, not a verdict: read the surrounding lines with read_file from/to and check whether it is reachable from the outside.",
    input_schema: obj({
      paths: { type: "array", items: { type: "string" }, maxItems: 400, description: "Custom files to check (shop paths or official names)" },
    }),
  },
  {
    name: "propose_fix",
    description:
      "Propose a fix to one existing file of the shop's own custom code (only inside the shop's customization folders, for example app/Customize and app/template on EC-CUBE 4; never official files, components, settings or new files). Nothing is written now: the proposal (the whole new content, a diff, and your explanations) is shown on the shop's admin screen, and only when the owner reads it and presses the approve button does the receiver back up the file, write it, open the shop to check, and roll back if the shop breaks. Use it after you have confirmed a weakness in custom code is reachable from the outside and you can make a small fix that does not change what the page does (for example escaping a value that is printed, or passing a value to SQL as a parameter). Keep the change minimal and keep everything else of the file exactly as it is. Then report the weakness as needs_approval with the returned proposal_id, and also add a request for the developer as the alternative if the owner prefers not to approve.",
    input_schema: obj(
      {
        path: { type: "string", description: "The custom file to fix (shop path, it must exist)" },
        new_content: { type: "string", description: "The complete new content of the file (not a diff)" },
        title: { type: "string", description: "Short title in Japanese for the owner (what gets fixed)" },
        owner_text: { type: "string", description: "In Japanese for the owner, plain words: what is dangerous now, what this change does, and what could be lost or change for the shop" },
        developer_text: { type: "string", description: "In Japanese for the developer: file, line, where it is reachable from, why it is dangerous, and what the proposed change does" },
        extra_verify_paths: { type: "array", items: { type: "string" }, maxItems: 2, description: "Pages of the shop (relative to the shop URL, starting with /) to open after writing, for example the page that uses this file" },
      },
      ["path", "new_content", "title", "owner_text", "developer_text"],
    ),
  },
  {
    name: "propose_upgrade",
    description:
      "Propose updating EC-CUBE (4 series only) to a newer official release on the same line when that update needs database changes (schema differences and official migrations), which you must not do on your own. Nothing is changed now: the proposal is shown on the shop's admin screen, and only when the owner approves it does the receiver do the official procedure under maintenance (take a backup of the files and the database, apply the database changes, replace the files with the official release verified by checksum, clear the cache, open the shop to check) and roll everything back if something fails. The tool refuses when files that the update would replace are customized, when the database type is not supported, or when the shop has no approval key; then report as before (needs_human / needs_approval). After it succeeds, report the update as needs_approval with the returned proposal_id, and explain in plain words what the update fixes.",
    input_schema: obj(
      {
        to: { type: "string", description: "Target official release tag on the same line, normally the newest (e.g. 4.2.3-p2)" },
        title: { type: "string", description: "Short title in Japanese for the owner" },
        owner_text: { type: "string", description: "In Japanese for the owner, plain words: why update, what it fixes, what changes for the shop" },
      },
      ["to", "title", "owner_text"],
    ),
  },
  {
    name: "find_misplaced_php",
    description:
      "Walk, to the end, the folders where PHP should never be (image and upload folders, user files, logs; generated caches are excluded) and list every PHP-like file there: PHP extensions in any case (.php, .phtml, .phar, .php5, .php7, .pht, .phps, .inc) and files with another extension whose first bytes are PHP code. Unlike file listings, it is not cut off by the listing limit. Returns path, reason, size and mtime only (never contents); complete=false means it stopped at its own walk/time limit and the rest was not checked. Each file found is a possible trace of intrusion: read it (read_file) to judge, and quarantine it under the usual tamper rules.",
    input_schema: obj({}),
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
        paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100, description: "Up to 30 files for EC-CUBE itself, up to 100 for one package under vendor/" },
        reason: { type: "string", description: "Which official fix this is (advisory id and source URL)" },
        extra_verify_paths: { type: "array", items: { type: "string" } },
      },
      ["ref", "paths", "reason"],
    ),
  },
  {
    name: "apply_official_release",
    description:
      "Update EC-CUBE to a newer official release of the same line (for example a patch release such as 4.0.6 -> 4.0.6-p5) as one unit, including the Composer packages under vendor/ and composer.lock, without running Composer. You only give the release tag; the API compares the official release archives of the installed version and of that tag and computes every file that changed. The receiver downloads the official release archive itself from the EC-CUBE GitHub releases, checks it against the release's official checksum and each file against the expected hash, backs up and writes all files, opens the shop pages, and rolls back everything if the shop breaks. Refused when the release changes the database schema (migrations or entities), or when a file to be replaced differs from the official release of the installed version (the shop's own customization). Use this for official patch releases, including ones that apply_official_fix refuses because of Composer package changes.",
    input_schema: obj(
      {
        ref: { type: "string", description: "Release tag of the same line, newer than the installed version" },
        reason: { type: "string", description: "Why (which official fixes this release contains, with source URL)" },
        extra_verify_paths: { type: "array", items: { type: "string" } },
      },
      ["ref", "reason"],
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
              category: {
                type: "string",
                enum: ["php", "eccube", "packages", "tamper", "custom", "exposure", "config", "other"],
                description: "php: the PHP runtime / eccube: EC-CUBE itself / packages: Composer packages / tamper: modified or unknown files (signs of intrusion) / custom: weaknesses in the shop's own custom code / exposure: information visible from outside / config: weak settings / other",
              },
              severity: { type: "string", enum: ["high", "medium", "low", "info"] },
              evidence: { type: "string" },
              status: { type: "string", enum: ["fixed", "mitigated", "scheduled", "needs_approval", "needs_human", "not_affected"], description: "fixed / mitigated (workaround in place) / scheduled (Shisa itself will handle it in a later inspection; also list it in next_by_self_harden) / needs_approval (the owner has to decide: work that needs maintenance mode or stops the shop, database migrations, large component or major version upgrades, settings that change how the owner works) / needs_human (work Shisa must not do itself: on the hosting side, the language runtime build, the web server, TLS certificates, server settings; or changes to the shop's own custom code, which only its developer may make) / not_affected" },
              proposal_id: { type: "string", description: "Only with needs_approval for a fix you proposed with propose_fix: its proposal_id, so the admin screen can show the approve button next to this finding" },
              to: { type: "string", enum: ["server_company", "developer"], description: "Only with needs_human: who does the work. server_company: the hosting company / developer: the shop's developer (the company that built or customizes the shop)" },
            },
            required: ["title", "category", "severity", "evidence", "status"],
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
            properties: { to: { type: "string", description: "Who receives it, in Japanese (サーバー会社 / 制作会社)" }, title: { type: "string" }, why: { type: "string" }, message: { type: "string", description: "Ready-to-send message in Japanese. For the developer: file, line, the page or entry it is reachable from, why it is dangerous, and the direction of the fix" } },
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

// 店の公開の場所(本体の一番上からの相対)。4 系は ""、3 系・2 系は "html"。窓口が自分の居場所から決めたものを聞く
const layoutCache = new Map<string, { pub: string; map: string; flat: boolean }>();
async function layoutOf(shop: Shop): Promise<{ pub: string; map: string; flat: boolean }> {
  const hit = layoutCache.get(shop.shop_id);
  if (hit) return hit;
  const r = await callReceiver(shop, "inspect", { sections: ["paths"] });
  const l = { pub: r.ok && typeof r.result.paths?.public === "string" ? r.result.paths.public : "", map: (r.ok && r.result.paths?.map) || "eccube4", flat: !!(r.ok && r.result.paths?.flat) };
  if (r.ok) layoutCache.set(shop.shop_id, l);
  return l;
}
async function pubDir(shop: Shop): Promise<string> {
  return (await layoutOf(shop)).pub;
}
// data/ を公開の場所の中に置いた 2 系(flat): 公式の配布物の html/x は、お店の x。data/ と composer.* はそのまま。
// 公式との照らし合わせ・差分・公式の中身を置く操作は、公式の名前(html/x)で考え、窓口には店の名前(x)で渡す。どちらの形で渡されても受ける
async function shopPathOf(shop: Shop, p: string): Promise<string> {
  return (await layoutOf(shop)).flat && p.startsWith("html/") ? p.slice(5) : p;
}
async function officialPathOf(shop: Shop, p: string): Promise<string> {
  const shopPath = await shopPathOf(shop, p);
  if (!(await layoutOf(shop)).flat || shopPath.startsWith("data/") || shopPath === "composer.json" || shopPath === "composer.lock") return shopPath;
  return `html/${shopPath}`;
}
// お店の URL(サブディレクトリでもよい)を起点に、お店の中のパス(/ で始まる)を URL にする。お店の外へは出さない
function shopPrefix(shop: Shop): string {
  return new URL(shop.shop_url).pathname.replace(/\/+$/, "");
}
function urlInShop(shop: Shop, path: string): URL {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) throw new Error("path must start with a single /");
  const base = new URL(shop.shop_url);
  const prefix = shopPrefix(shop);
  const url = new URL(prefix + path, base.origin);
  if (url.origin !== base.origin || (prefix !== "" && url.pathname !== prefix && !url.pathname.startsWith(prefix + "/"))) throw new Error("only paths inside this shop are allowed");
  return url;
}
// 窓口のページの、お店の URL からのパス
function receiverPathOf(shop: Shop): string {
  const p = new URL(shop.receiver_url).pathname;
  const prefix = shopPrefix(shop);
  return prefix !== "" && p.startsWith(prefix + "/") ? p.slice(prefix.length) : p;
}

// 部品のフォルダ(2 系は data/vendor)
async function vendorDir(shop: Shop): Promise<string> {
  return (await layoutOf(shop)).map === "eccube2" ? "data/vendor" : "vendor";
}
// 書いたあとに開いて確かめるページ(版の系統ごと)
async function verifyPathsFor(shop: Shop, extra: unknown): Promise<string[]> {
  // パスはお店の URL からの相対(お店がサブディレクトリなら、その下)。窓口がお店の URL の下を開く
  const receiverPath = receiverPathOf(shop);
  const ex = Array.isArray(extra) ? extra.filter((p): p is string => typeof p === "string" && p.startsWith("/")).slice(0, 2) : [];
  const pages = (await layoutOf(shop)).map === "eccube2" ? ["/", "/products/list.php", "/cart/"] : ["/", "/products/list", "/cart"];
  return [...pages, receiverPath, ...ex].slice(0, 6);
}
const underPub = (pub: string, rel: string) => (pub === "" ? rel : `${pub}/${rel}`);

async function targetToPath(shop: Shop, target: string): Promise<string | null> {
  if (target === "root/.htaccess") return underPub(await pubDir(shop), ".htaccess");
  if (target === "root/.user.ini") return underPub(await pubDir(shop), ".user.ini");
  if (target.startsWith("dir:")) return target.slice(4);
  return null;
}

async function currentFile(shop: Shop, path: string): Promise<{ sha: string | null; content: string }> {
  const r = await callReceiver(shop, "read_file", { path: await shopPathOf(shop, path) });
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
  const url = urlInShop(shop, path);
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
  const url = urlInShop(shop, `${arm.result.probe_path}?t=${arm.result.token}`);
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
    for (const [p, sha] of r.result.files as [string, string, number][]) out[await officialPathOf(shop, p)] = sha;
    if (!r.result.next_cursor) return out;
    cursor = r.result.next_cursor;
  }
  throw new Error("ファイルが多すぎて一覧を取り切れませんでした");
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
        return { content: j(await checkPackages(shop, ctx ? await ctx.store.getApplied(shop.shop_id) : [], await vendorDir(shop))), title: "部品の弱点を Packagist で照らし合わせる" };
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
      const args: Record<string, unknown> = { path: input.path };
      if (Number.isInteger(input.from)) args.from = input.from;
      if (Number.isInteger(input.to)) args.to = input.to;
      const r = await callReceiver(shop, "read_file", args);
      const range = args.from || args.to ? ` ${args.from ?? 1}〜${args.to ?? ""} 行目` : "";
      return { content: j(r), isError: !r.ok, title: `ファイルを読む: ${input.path}${range}` };
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
        const applied = ctx ? await ctx.store.getApplied(shop.shop_id) : [];
        // 公式の修正(ソースの差だけ)を当てて版が変わった店は、元の版の配布物を基準にする(配布物の作り直しで部品が全部違って見えるのを避ける)。
        // 配布物ごと上げた店は、上げた先の版が基準。前の版の残りのファイルは分けて出す
        const lastRelease = applied.filter((a) => a.via === "release").sort((a, b) => b.at - a.at)[0];
        const fixBase = applied.filter((a) => a.via === "fix" && a.from_version && (!lastRelease || a.at > lastRelease.at)).sort((a, b) => a.at - b.at)[0]?.from_version;
        const baseVersion = fixBase && fixBase !== version ? fixBase : version;
        const m = await manifest(baseVersion);
        const prev = lastRelease?.from_version ? await manifest(lastRelease.from_version) : null;
        const mine = await shopHashes(shop);
        const intendedBy = new Map(applied.map((f) => [f.path, f]));
        const leftover: string[] = [];
        const onlyPhp = input?.only_php !== false;
        const modified: string[] = [];
        const added: string[] = [];
        const intended: unknown[] = [];
        let addedOther = 0;
        // タグのソースから作った一覧(3 系)には vendor/ が無い。部品は check_packages で見る
        let vendorNotCompared = 0;
        for (const [p, sha] of Object.entries(mine)) {
          if (m.source_only && p.startsWith(m.vendor_dir ?? "vendor/")) { vendorNotCompared++; continue; }
          const fx = intendedBy.get(p);
          if (fx && fx.sha256 === sha) {
            intended.push({ path: p, ref: fx.ref, reason: fx.reason, via: fx.via ?? "fix", applied_at: new Date(fx.at).toISOString() });
            continue;
          }
          if (p in m.files) {
            if (m.files[p] !== sha) modified.push(p);
          } else if (prev && prev.files[p] === sha) leftover.push(p);
          else if (!onlyPhp || PHP_LIKE.test(p)) added.push(p);
          else addedOther++;
        }
        const missing = Object.keys(m.files).filter((p) => !(p in mine));
        const byTop = (ps: string[]) => ps.reduce<Record<string, number>>((a, p) => ((a[p.split("/")[0]] = (a[p.split("/")[0]] ?? 0) + 1), a), {});
        return {
          content: j({
            official: { version, compared_with: baseVersion, note: baseVersion !== version ? `The shop was moved to ${version} by official fixes applied by self-harden; compared with the ${baseVersion} release plus those fixes.` : undefined, source: m.source, tarball_sha256: m.tarball_sha256, files: Object.keys(m.files).length },
            vendor_not_compared: m.source_only ? { count: vendorNotCompared, note: "the official source for this version has no vendor/; check Composer packages with check_packages" } : undefined,
            left_from_previous_release: leftover.length ? { count: leftover.length, from: lastRelease?.from_version, note: "unchanged files of the previous official release that the update did not remove; not traces of intrusion", by_top: byTop(leftover) } : undefined,
            shop_files: Object.keys(mine).length,
            intended: { count: intended.length, note: "official fixes applied by self-harden (via fix/release), or official fixes found already applied by hand in a customized file (via manual), still as recorded", items: intended },
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
    case "find_misplaced_php": {
      const r = await callReceiver(shop, "find_misplaced_php", {}, 30_000);
      return { content: j(r), isError: !r.ok, title: `置き場所違いの PHP を探す: ${r.ok ? `${r.result.walked} 件を歩いて ${(r.result.found as unknown[]).length} 件${r.result.complete ? "" : "(最後までは調べられなかった)"}` : "できなかった"}` };
    }
    case "propose_upgrade": {
      try {
        const p = await proposeUpgrade(shop, ctx as ToolContext, input);
        return { content: j({ proposal_id: p.proposal_id, from: p.from_version, to: p.to_version, summary: p.diff, note: "Not changed yet. The owner approves it on the admin screen." }), title: `版上げを提案する(店主の承認待ち): ${p.from_version} → ${p.to_version}` };
      } catch (e) {
        return { content: j({ error: (e as Error).message }), isError: true, title: "版上げを提案できなかった" };
      }
    }
    case "propose_fix": {
      if (!ctx) return { content: j({ error: "no context" }), isError: true, title: "直し方を提案する" };
      try {
        const p = await proposeFix(shop, ctx, input);
        return { content: j({ ok: true, proposal_id: p.proposal_id, path: p.path, diff: p.diff.length > 6000 ? p.diff.slice(0, 6000) + "\n…(truncated)" : p.diff, note: "Nothing is written yet. The owner decides on the admin screen." }), title: `直し方を提案する(店主の承認待ち): ${p.path}` };
      } catch (e) {
        return { content: j({ error: (e as Error).message }), isError: true, title: `直し方を提案する: ${input.path}` };
      }
    }
    case "scan_custom": {
      const raw: unknown[] = Array.isArray(input.paths) ? input.paths.slice(0, 400) : [];
      const paths = await Promise.all(raw.filter((p): p is string => typeof p === "string").map((p) => shopPathOf(shop, p)));
      const r = await callReceiver(shop, "scan_custom", paths.length ? { paths } : {}, 60_000);
      const n = r.ok ? (r.result.hits as unknown[]).length : 0;
      return { content: j(r), isError: !r.ok, title: `カスタマイズしたコードの点検: ${r.ok ? `${r.result.scanned} 件を調べ、気になる行 ${n} 件` : "できなかった"}` };
    }
    case "diff_with_official": {
      try {
        const installed = await installedVersion(shop);
        // 公式の修正で版が変わった店は、元の版の配布物と比べる(照らし合わせと同じ基準)
        const applied = ctx ? await ctx.store.getApplied(shop.shop_id) : [];
        const lastRelease = applied.filter((a) => a.via === "release").sort((a, b) => b.at - a.at)[0];
        const fixBase = applied.filter((a) => a.via === "fix" && a.from_version && (!lastRelease || a.at > lastRelease.at)).sort((a, b) => a.at - b.at)[0]?.from_version;
        const op = await officialPathOf(shop, String(input.path));
        const version = fixBase && fixBase !== installed && !applied.some((a) => a.path === op && a.via === "fix") ? fixBase : installed;
        const r = await callReceiver(shop, "read_file", { path: await shopPathOf(shop, String(input.path)) });
        if (!r.ok) return { content: j(r), isError: true, title: `公式との違いを見る: ${input.path}` };
        const off = await officialContent(version, op);
        if (!off) return { content: j({ official: null, note: "not in the official release" }), title: `公式との違いを見る: ${input.path}` };
        const mineText = r.result.exists ? (r.result.content as string) : "";
        const patch = createPatch(op, off.toString("utf8"), mineText, `official ${version}`, "shop");
        return { content: j({ version, diff: patch.length > 12000 ? patch.slice(0, 12000) + "\n…(truncated)" : patch }), title: `公式との違いを見る: ${input.path}` };
      } catch (e) {
        return { content: j({ error: (e as Error).message }), isError: true, title: `公式との違いを見る: ${input.path}` };
      }
    }
    case "restore_official": {
      const op = await officialPathOf(shop, String(input.path));
      const args: Record<string, unknown> = { path: await shopPathOf(shop, String(input.path)), ref: input.ref, verify: { paths: await verifyPathsFor(shop, input.extra_verify_paths), timeout_sec: 8 } };
      try {
        // 入っている版と同じタグに戻すときは、公式リリースの SHA-256 と一致することも受け口に確かめさせる
        const version = await installedVersion(shop);
        if (input.ref === version) {
          const m = await manifest(version);
          if (m.files[op]) args.expected_sha256 = m.files[op];
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
          await ctx.store.addApplied(shop.shop_id, [{ path: op, sha256: r.result.sha256_after, ref: String(input.ref), source: r.result.source, reason: "restore_official", run_id: ctx.runId, at: Date.now() }]);
        }
      }
      return { content: j(r), isError: !r.ok, title: `公式の中身に戻す: ${input.path} @ ${input.ref}` };
    }
    case "apply_official_fix": {
      const paths: string[] = [];
      for (const p of Array.isArray(input.paths) ? input.paths.map(String) : []) paths.push(await officialPathOf(shop, p));
      // 部品の修正も、その部品の公式リポジトリの差分で「全部のファイル」がそろっているかを確かめてから当てる
      const vd = await vendorDir(shop);
      const vpkg = (new RegExp(`^${vd.replace("/", "\\/")}\\/([^/]+\\/[^/]+)\\/`).exec(paths[0] ?? "") ?? [])[1];
      if (vpkg) {
        try {
          if (!paths.every((p) => p.startsWith(`${vd}/${vpkg}/`))) return { content: j({ ok: false, error: "mixed_packages", detail: "Apply one package per call." }), isError: true, title: `公式の修正を当てる: ${input.ref}` };
          const ins = await callReceiver(shop, "inspect", { sections: ["app"] });
          const pkg = ((ins.ok ? ins.result.app?.packages : []) as any[]).find((p) => p.name === vpkg);
          if (!pkg) return { content: j({ ok: false, error: "unknown_package", detail: `${vpkg} is not in composer.lock` }), isError: true, title: `公式の修正を当てる: ${input.ref}` };
          const mine = new Set(Object.keys(await shopHashes(shop)));
          const scope = await vendorFixScope(pkg, String(input.ref), mine, vd);
          const missing = scope.files.filter((f) => !paths.includes(f));
          if (scope.files.length > 100) return { content: j({ ok: false, error: "too_many_files", detail: `This update changes ${scope.files.length} files of ${vpkg}; too many for one unit. Report it.`, source: scope.source }), isError: true, title: `公式の修正を当てる: ${input.ref}` };
          if (missing.length) return { content: j({ ok: false, error: "incomplete_fix", detail: "Nothing was written. The official change of this package includes more files; list all of them together.", required_files: scope.files, missing, source: scope.source }), isError: true, title: `公式の修正を当てる: ${input.ref}` };
        } catch (e) {
          return { content: j({ ok: false, error: "scope_unknown", detail: `Could not confirm the full set of files of this package update: ${(e as Error).message}. Nothing was written.` }), isError: true, title: `公式の修正を当てる: ${input.ref}` };
        }
      }
      // EC-CUBE 本体の修正は、公式のデータで「全部のファイル」がそろっているかを確かめてから当てる(半端に置かない)
      // カスタマイズされたファイルのうち、公式の直しがすでに手で入っているものは「手で当て済み」として触らずに数え、残りだけ当てる
      const manual: { path: string; sha: string; check: ReturnType<typeof fixAlreadyIn> }[] = [];
      let fixScopeFiles: string[] = [];
      if (!vpkg) {
        try {
          const scope = await officialFixScope(await installedVersion(shop), String(input.ref));
          fixScopeFiles = scope.files;
          const missing = scope.files.filter((f) => !paths.includes(f));
          if (scope.blockers.length) {
            return { content: j({ ok: false, error: "needs_db_or_vendor_change", detail: "This official change also alters the database schema/migrations or Composer packages. If it is an official release of the same line, use apply_official_release (it handles Composer packages; it refuses database changes). Otherwise apply nothing and report it.", blockers: scope.blockers, source: scope.source }), isError: true, title: `公式の修正を当てる: ${input.ref}` };
          }
          // お店のカスタマイズを上書きしない: 当てる先が、今の版の公式の中身と違えば(self-harden が当てたものを除く)断る
          const version = await installedVersion(shop);
          const m = await manifest(version);
          const applied = ctx ? await ctx.store.getApplied(shop.shop_id) : [];
          const customized: { path: string; added_lines: number; missing_added: number; remaining_removed: number }[] = [];
          for (const p of paths) {
            if (!m.files[p]) continue; // 公式に無い新しいファイル
            const cur = await currentFile(shop, p);
            if (cur.sha && cur.sha !== m.files[p] && !applied.some((a) => a.path === p && a.sha256 === cur.sha)) {
              const check = fixAlreadyIn(scope.patches?.[p], cur.content);
              if (check.applied) manual.push({ path: p, sha: cur.sha, check });
              else customized.push({ path: p, added_lines: check.added_lines, missing_added: check.missing_added, remaining_removed: check.remaining_removed });
            }
          }
          if (customized.length) {
            return { content: j({ ok: false, error: "customized_files", detail: "Nothing was written. These files differ from the official release of the installed version (likely the shop's own customization), and the official change is not (fully) in them; applying official files would erase the customization. Report it to a person instead.", customized, already_applied_by_hand: manual.map((x) => x.path), source: scope.source }), isError: true, title: `公式の修正を当てる: ${input.ref}` };
          }
          if (missing.length) {
            return { content: j({ ok: false, error: "incomplete_fix", detail: "Nothing was written. The official change includes more files; list all of them together.", required_files: scope.files, missing, source: scope.source }), isError: true, title: `公式の修正を当てる: ${input.ref}` };
          }
        } catch (e) {
          return { content: j({ ok: false, error: "scope_unknown", detail: `Could not confirm the full set of files of this official change: ${(e as Error).message}. Nothing was written.` }), isError: true, title: `公式の修正を当てる: ${input.ref}` };
        }
      }
      let fromVersion: string | undefined;
      try { fromVersion = await installedVersion(shop); } catch { /* 分からなければ記録しない */ }
      const manualPaths = new Set(manual.map((x) => x.path));
      const toWrite = paths.filter((p) => !manualPaths.has(p));
      // 手で当て済みの記録: Shisa は書いていない。今の中身(ハッシュ)を「直しが入った形」として覚え、照らし合わせでカスタマイズと見ないようにする
      const recordManual = async () => {
        if (!ctx || !manual.length) return;
        await ctx.store.addApplied(shop.shop_id, manual.map((x) => ({ path: x.path, sha256: x.sha, ref: String(input.ref), source: "already in the shop (applied by hand)", reason: String(input.reason ?? ""), run_id: ctx.runId, at: Date.now(), from_version: fromVersion, via: "manual" as const })));
      };
      const manualOut = manual.map((x) => ({ path: x.path, added_lines: x.check.added_lines }));
      // 全部の対象ファイルが、今回当てたもの・手で当て済みのものでそろったか(そろわなければ、版が上がったとはみなさない)
      const complete = !vpkg && fixScopeFiles.length > 0 && fixScopeFiles.every((f) => paths.includes(f));
      if (!toWrite.length) {
        await recordManual();
        return { content: j({ ok: true, result: { applied: [], already_applied_by_hand: manualOut, not_applied_customized: [], complete, note: "Every target file already contains the official change (applied by hand). Nothing was written." } }), title: `公式の修正を当てる: 手で当て済み ${manual.length} ファイル @ ${input.ref}` };
      }
      const shopPaths: string[] = [];
      for (const p of toWrite) shopPaths.push(await shopPathOf(shop, p));
      const r = await callReceiver(shop, "apply_official_fix", {
        ref: input.ref,
        paths: shopPaths,
        verify: { paths: await verifyPathsFor(shop, input.extra_verify_paths), timeout_sec: 8 },
      }, vpkg ? 100_000 : 28_000);
      if (r.ok && !r.result.rolled_back && ctx) {
        await ctx.store.addApplied(
          shop.shop_id,
          await Promise.all((r.result.applied as any[]).map(async (a) => ({ path: await officialPathOf(shop, a.path), sha256: a.sha256_after, ref: String(input.ref), source: a.source, reason: String(input.reason ?? ""), run_id: ctx.runId, at: Date.now(), from_version: fromVersion, via: "fix" as const, package_complete: vpkg ? true : undefined }))),
        );
        await recordManual();
      }
      const out = r.ok && manual.length ? { ...r, result: { ...r.result, already_applied_by_hand: manualOut, not_applied_customized: [], complete } } : r;
      return { content: j(out), isError: !r.ok, title: `公式の修正を当てる: ${toWrite.length} ファイル${manual.length ? `(手で当て済み ${manual.length})` : ""} @ ${input.ref}` };
    }
    case "apply_official_release": {
      const ref = String(input.ref ?? "");
      const title = `公式のリリースに上げる: ${ref}`;
      try {
        const installed = await installedVersion(shop);
        const line = (v: string) => (/^([2-4]\.\d+)\./.exec(v.replace(/^eccube-/, "")) ?? [])[1];
        if (!line(ref) || line(ref) !== line(installed)) {
          return { content: j({ ok: false, error: "bad_ref", detail: `Only a newer release tag of the same line as the installed version (${installed}).` }), isError: true, title };
        }
        const from = await manifest(installed);
        const to = await manifest(ref);
        const mine = await shopHashes(shop);
        const applied = ctx ? await ctx.store.getApplied(shop.shop_id) : [];
        const writable = (p: string) =>
          p === "composer.json" || p === "composer.lock" ||
          ((/^(src|app|html|vendor)\//.test(p) || !p.includes("/")) && !/(^|\/)\.env/.test(p) && p !== "self-harden.php");
        const changed = Object.keys(to.files).filter((p) => to.files[p] !== from.files[p]);
        const blockers = changed.filter((p) => /^app\/DoctrineMigrations\//.test(p) || /^src\/Eccube\/Entity\//.test(p));
        if (blockers.length) {
          return { content: j({ ok: false, error: "needs_db_change", detail: "This release changes the database schema; it cannot be applied with this tool. On EC-CUBE 4 use propose_upgrade so the owner can approve the official procedure; otherwise apply nothing and report it.", blockers: blockers.slice(0, 20) }), isError: true, title };
        }
        // 店から消されているファイル(公式の前の版にあったもの)は置き直さない。書けない場所は外す
        const skippedRemoved = changed.filter((p) => p in from.files && !(p in mine));
        const notWritable = changed.filter((p) => !writable(p));
        const paths = changed.filter((p) => writable(p) && !skippedRemoved.includes(p));
        // お店のカスタマイズを上書きしない
        const customized = paths.filter((p) => p in mine && p in from.files && mine[p] !== from.files[p] && mine[p] !== to.files[p] && !applied.some((a) => a.path === p && a.sha256 === mine[p]));
        if (customized.length) {
          return { content: j({ ok: false, error: "customized_files", detail: "Nothing was written. These files differ from the official release of the installed version (likely the shop's own customization); applying the release would erase it. Report it to a person instead.", customized: customized.slice(0, 50), count: customized.length }), isError: true, title };
        }
        const todo = paths.filter((p) => mine[p] !== to.files[p]);
        if (!todo.length) return { content: j({ ok: true, detail: "Already identical to the release." }), title };
        const expected: Record<string, string> = {};
        const todoShop: string[] = [];
        for (const p of todo) {
          const sp = await shopPathOf(shop, p);
          todoShop.push(sp);
          expected[sp] = to.files[p];
        }
        const r = await callReceiver(shop, "apply_official_release", {
          ref, paths: todoShop, expected_sha256: expected,
          verify: { paths: await verifyPathsFor(shop, input.extra_verify_paths ?? ["/admin/login"]), timeout_sec: 8 },
        }, 170_000);
        if (r.ok && !r.result.rolled_back && ctx) {
          await ctx.store.addApplied(shop.shop_id, await Promise.all((r.result.applied as any[]).map(async (a) => ({ path: await officialPathOf(shop, a.path), sha256: a.sha256_after, ref, source: to.source, reason: String(input.reason ?? ""), run_id: ctx.runId, at: Date.now(), from_version: installed, via: "release" as const }))));
        }
        const by = (ps: string[]) => ps.reduce<Record<string, number>>((a, p) => ((a[p.split("/")[0]] = (a[p.split("/")[0]] ?? 0) + 1), a), {});
        const summary = r.ok
          ? { ok: true, result: { ref, from: installed, written: r.result.applied.length, by_top: by(todo), composer_lock: todo.includes("composer.lock"), rolled_back: r.result.rolled_back, verify: r.result.verify, rollback_verify: r.result.rollback_verify, skipped_removed_in_shop: skippedRemoved.length, not_writable: notWritable.slice(0, 20), source: to.source } }
          : r;
        return { content: j(summary), isError: !r.ok, title };
      } catch (e) {
        return { content: j({ ok: false, error: "release_unknown", detail: `${(e as Error).message}. Nothing was written.` }), isError: true, title };
      }
    }
    case "quarantine": {
      const r = await callReceiver(shop, "quarantine", { path: await shopPathOf(shop, String(input.path)), verify: { paths: await verifyPathsFor(shop, null), timeout_sec: 8 } });
      return { content: j(r), isError: !r.ok, title: `隔離する: ${input.path}` };
    }
    case "release_quarantine": {
      const r = await callReceiver(shop, "release_quarantine", { quarantine_id: input.quarantine_id });
      return { content: j(r), isError: !r.ok, title: `隔離から戻す: ${input.quarantine_id}` };
    }
    case "clear_cache": {
      const r = await callReceiver(shop, "clear_cache", { verify: { paths: await verifyPathsFor(shop, ["/admin/login"]), timeout_sec: 8 } });
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
      const cur = await currentFile(shop, underPub(await pubDir(shop), LAB_PATH[file]));
      const w = await callReceiver(shop, "write_file", { target: `lab/${file}`, content: input.content, expected_sha256: cur.sha });
      if (!w.ok) return { content: j({ write: w }), isError: true, title: `小部屋で試す: ${file}` };
      const p = await probe(shop, input.ini_keys);
      return { content: j({ write: { backup_id: w.result.backup_id }, probe: p }), title: `小部屋で試す: ${file}` };
    }
    case "probe_lab": {
      return { content: j(await probe(shop, input?.ini_keys)), title: "小部屋をもう一度確かめる" };
    }
    case "write_file": {
      const path = await targetToPath(shop, String(input.target));
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
      const r = await callReceiver(shop, "write_file", {
        target: input.target,
        content: input.content,
        expected_sha256: cur.sha,
        verify: { paths: await verifyPathsFor(shop, input.extra_verify_paths), timeout_sec: 8 },
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

// ---- 店主の承認で直す ----
// 承認の鍵はお店の中にしかない。ここでは提案を作って控えるだけで、書くのは店主が承認したあと(applyApproved)
const PROPOSAL_MAX = 262144;
// 承認の直しは小さく: 先頭と末尾の同じ行を除いた「変わる範囲」の行数の上限(窓口と同じ数)
export const PROPOSAL_MAX_LINES = 200;
export function changedSpan(oldText: string, newText: string): number {
  const a = oldText.split(/\r\n|\n|\r/), b = newText.split(/\r\n|\n|\r/);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return Math.max(a.length - i - j, b.length - i - j);
}
async function approveInfo(shop: Shop): Promise<{ ready: boolean; dirs: string[] }> {
  const r = await callReceiver(shop, "inspect", { sections: ["paths"] });
  if (!r.ok) throw new Error(`inspect: ${r.error}`);
  return { ready: !!r.result.paths?.approve_ready, dirs: Array.isArray(r.result.paths?.approve_dirs) ? r.result.paths.approve_dirs : [] };
}

export async function proposeFix(shop: Shop, ctx: ToolContext, input: any): Promise<Proposal> {
  const path = await shopPathOf(shop, String(input.path ?? ""));
  if (!/^[A-Za-z0-9._\-/]+$/.test(path) || path.split("/").some((x) => x === "" || x === "." || x === "..")) throw new Error("path の形が正しくありません");
  const newContent = typeof input.new_content === "string" ? input.new_content : "";
  if (!newContent || newContent.length > PROPOSAL_MAX) throw new Error("new_content がないか、大きすぎます");
  const info = await approveInfo(shop);
  if (!info.ready) throw new Error("このお店には承認の鍵がありません(プラグインが古いか、有効にし直していない)。提案はできないので、制作会社への依頼にしてください");
  if (!info.dirs.some((d) => path.startsWith(d + "/"))) throw new Error(`承認の直しで書けるのは、カスタマイズの置き場(${info.dirs.join("・")})の中だけです`);
  const r = await callReceiver(shop, "read_file", { path });
  if (!r.ok) throw new Error(`今の中身を読めません: ${r.error} ${r.detail ?? ""}`);
  if (!r.result.exists) throw new Error("今あるファイルだけ直せます(新しいファイルは作りません)");
  const current = String(r.result.content);
  if (current === newContent) throw new Error("今の中身と同じです");
  if (changedSpan(current, newContent) > PROPOSAL_MAX_LINES) throw new Error(`変わる行が多すぎます(${PROPOSAL_MAX_LINES} 行まで)。承認の直しは小さな直しだけです。制作会社への依頼にしてください`);
  const extra = Array.isArray(input.extra_verify_paths) ? input.extra_verify_paths.filter((p: unknown): p is string => typeof p === "string" && /^\/[A-Za-z0-9._~\-/%?=&]*$/.test(p)).slice(0, 2) : [];
  const p: Proposal = {
    proposal_id: `prp_${randomHex(8)}`,
    shop_id: shop.shop_id,
    run_id: ctx.runId,
    path,
    title: String(input.title ?? "").slice(0, 200),
    owner_text: String(input.owner_text ?? "").slice(0, 2000),
    developer_text: String(input.developer_text ?? "").slice(0, 4000),
    sha256_before: await sha256Hex(current),
    sha256_new: await sha256Hex(newContent),
    new_content: newContent,
    diff: createPatch(path, current, newContent, "今", "直したあと"),
    verify_paths: await verifyPathsFor(shop, extra),
    status: "pending",
    created_at: Date.now(),
  };
  // 同じファイルへの前の提案は、新しい提案に置き換える(古い方は承認できなくする)
  for (const old of await ctx.store.listProposals(shop.shop_id)) {
    if (old.path === path && old.status === "pending") await ctx.store.putProposal({ ...old, status: "superseded" });
  }
  await ctx.store.putProposal(p);
  return p;
}

// ---- 版上げの提案(データベースの作り変えを含む)。上げるのは、店主がお店の管理画面で承認したあとだけ ----
const MIGRATION_DIR = "app/DoctrineMigrations/";
const UPGRADE_SKIP = ["var/", "app/Plugin/", "app/Customize/", "app/proxy/", "app/template/", "html/upload/", "html/user_data/", "html/plugin/"];

export async function proposeUpgrade(shop: Shop, ctx: ToolContext, input: any): Promise<Proposal> {
  const to = String(input.to ?? "");
  if (!/^4\.\d+\.\d+(-p\d+)?$/.test(to)) throw new Error("to は 4 系の公式の版(例 4.2.3-p2)にしてください");
  const from = await installedVersion(shop);
  const line = (v: string) => v.split(".").slice(0, 2).join(".");
  const num = (v: string) => v.replace(/-p(\d+)$/, ".$1").split(".").map(Number);
  const newer = (a: string, b: string) => { const x = num(a), y = num(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0); } return false; };
  if (!/^4\./.test(from) || line(from) !== line(to) || !newer(to, from)) throw new Error(`上げ先は、今の版(${from})と同じ系列の新しい公式の版だけです`);
  const info = await approveInfo(shop);
  if (!info.ready) throw new Error("このお店には承認の鍵がありません(プラグインが古いか、有効にし直していない)。版上げは店主の判断待ちとして報告してください");
  const [mf, mt] = [await manifest(from), await manifest(to)];
  const mine = await shopHashes(shop);
  const skip = (p: string) => UPGRADE_SKIP.some((d) => p.startsWith(d)) || p === ".env";
  const changed = Object.keys(mt.files).filter((p) => !skip(p) && mt.files[p] !== mf.files[p]);
  // 部品(vendor/)は公式の手順どおり上書きする(Shisa が部品ごとに当てた修正は、次の点検で当て直す)
  const blocked = changed.filter((p) => !p.startsWith("vendor/") && p in mine && mine[p] !== mf.files[p] && mine[p] !== mt.files[p]);
  if (blocked.length) throw new Error(`版上げで置き換えるファイルのうち ${blocked.length} 件がカスタマイズされているので、承認での版上げは提案しません(例: ${blocked.slice(0, 5).join("、")})。制作会社の作業か店主の判断として報告してください`);
  const migrations = Object.keys(mt.files).filter((p) => p.startsWith(MIGRATION_DIR) && !(p in mf.files)).map((p) => p.slice(MIGRATION_DIR.length).replace(/\.php$/, ""));
  const entities = changed.filter((p) => p.startsWith("src/Eccube/Entity/")).map((p) => p.replace("src/Eccube/Entity/", "").replace(/\.php$/, ""));
  const summary = `${from} → ${to}: 置き換えるファイル ${changed.length} 件(うち部品 ${changed.filter((p) => p.startsWith("vendor/")).length} 件)、公式のマイグレーション ${migrations.length} 件(${migrations.join("・") || "なし"})、データベースの作りが変わるもの ${entities.join("・") || "なし"}`;
  const p: Proposal = {
    proposal_id: `prp_${randomHex(8)}`,
    shop_id: shop.shop_id,
    run_id: ctx.runId,
    path: "",
    kind: "upgrade",
    from_version: from,
    to_version: to,
    title: String(input.title ?? `EC-CUBE を ${to} に上げる`).slice(0, 200),
    owner_text: String(input.owner_text ?? "").slice(0, 2000),
    developer_text: `公式の手順(doc4.ec-cube.net/update42x)に沿って、メンテナンス中に ${summary}。ファイルとデータベースの控えを取り、失敗したら戻します。`,
    sha256_before: await sha256Hex(`SH-UPGRADE|${from}`),
    sha256_new: await sha256Hex(`SH-UPGRADE|${to}`),
    new_content: "",
    diff: summary,
    verify_paths: [],
    status: "pending",
    created_at: Date.now(),
  };
  for (const old of await ctx.store.listProposals(shop.shop_id)) {
    if (old.kind === "upgrade" && old.status === "pending") await ctx.store.putProposal({ ...old, status: "superseded" });
  }
  await ctx.store.putProposal(p);
  return p;
}

const UPGRADE_REFUSALS = ["not_approved", "approval_expired", "approval_used", "conflict", "no_approval_key", "bad_ref", "not_supported"];

// 承認された版上げを始める。窓口が段ごとに進めるので、終わるまで裏で呼び続ける(管理画面は提案の様子を見て進み具合を出す)
export async function applyUpgrade(shop: Shop, store: Store, p: Proposal, approval: any) {
  const ok = approval && typeof approval === "object" && approval.proposal_id === p.proposal_id && approval.from === p.from_version
    && approval.to === p.to_version && approval.shop_id === shop.shop_id && typeof approval.sig === "string" && Number.isInteger(approval.expires_at);
  if (!ok) return { ok: false as const, error: "approval_mismatch", detail: "承認の印が提案と合いません" };
  const r = await callReceiver(shop, "upgrade", { approval }, 30_000);
  if (!r.ok && UPGRADE_REFUSALS.includes(String(r.error))) return { ok: false as const, status: p.status, error: r.error, detail: r.detail };
  const first: Proposal = { ...p, status: "running", decided_at: Date.now(), upgrade: r.ok ? r.result : { error: r.error, detail: r.detail } };
  await store.putProposal(first);
  void driveUpgrade(shop, store, first, approval, r.ok ? r.result : null);
  return { ok: true as const, status: "running", upgrade: first.upgrade };
}

async function driveUpgrade(shop: Shop, store: Store, p: Proposal, approval: any, state: any) {
  let st = state;
  let fails = 0;
  for (let i = 0; i < 200; i++) {
    if (st && ["done", "rolled_back", "stuck", "refused"].includes(st.status)) break;
    const r = await callReceiver(shop, "upgrade", { approval }, 180_000).catch((e) => ({ ok: false, error: "network", detail: String(e) }) as any);
    if (!r.ok) {
      if (++fails > 5) { st = { ...(st ?? {}), status: "stuck", error: { code: r.error, detail: r.detail } }; break; }
      await new Promise((res) => setTimeout(res, 3000));
      continue;
    }
    fails = 0;
    st = r.result;
    await store.putProposal({ ...p, status: "running", upgrade: st });
  }
  const status: Proposal["status"] = st?.status === "done" ? "applied" : st?.status === "rolled_back" ? "rolled_back" : "failed";
  await store.putProposal({ ...p, status, decided_at: Date.now(), upgrade: st, result: st });
  const run = await store.getRun(p.run_id);
  if (run) {
    const title = status === "applied" ? `店主の承認で ${p.to_version} に上げた(データベースの作り変えを含む)` : status === "rolled_back" ? `店主の承認で上げようとしたが、途中で失敗したので ${p.from_version} に戻した` : `店主の承認で上げようとしたが、できなかった`;
    const last = Array.isArray(st?.log) ? st.log.slice(-3).map((l: any) => l.text).join(" / ") : "";
    run.steps.push({ at: Date.now(), kind: "decision", title, tool: "承認して上げる", result: last });
    run.updated_at = Date.now();
    await store.putRun(run);
  }
}

// 店主の承認の印(お店の中で作られたもの)を受け取り、窓口に書かせる。印が提案と合わなければ窓口に渡さない
export async function applyApproved(shop: Shop, store: Store, p: Proposal, approval: any) {
  const ok = approval && typeof approval === "object" && approval.proposal_id === p.proposal_id && approval.path === p.path
    && approval.sha256_new === p.sha256_new && approval.sha256_before === p.sha256_before && approval.shop_id === shop.shop_id
    && typeof approval.sig === "string" && Number.isInteger(approval.expires_at);
  if (!ok) return { ok: false as const, error: "approval_mismatch", detail: "承認の印が提案と合いません" };
  const r = await callReceiver(shop, "apply_approved_fix", { approval, content: p.new_content, verify: { paths: p.verify_paths, timeout_sec: 8 } }, 45_000);
  // 提案の状態を変えるのは、窓口が実際に書いた(書いて戻した)ときだけ。印が合わない・期限切れ・使い回し・食い違いなどで断られたときは、
  // 提案はそのまま(偽の承認を送って、正しい提案を潰せないように)
  if (!r.ok && ["not_approved", "approval_expired", "approval_used", "conflict", "no_approval_key", "bad_content", "too_large_change", "php_syntax", "bad_target"].includes(String(r.error))) {
    return { ok: false as const, status: p.status, error: r.error, detail: r.detail };
  }
  const status: Proposal["status"] = !r.ok ? "failed" : r.result.rolled_back ? "rolled_back" : "applied";
  await store.putProposal({ ...p, status, decided_at: Date.now(), result: r.ok ? r.result : { error: r.error, detail: r.detail } });
  // 点検の経過にも残す(管理画面で、承認して直したことが流れるように)
  const run = await store.getRun(p.run_id);
  if (run) {
    const v = r.ok ? ((r.result.verify ?? []) as any[]).map((x) => `${x.path} ${x.status}`).join("、") : "";
    const title = status === "applied" ? `店主の承認で直した: ${p.path}` : status === "rolled_back" ? `店主の承認で直したが、お店が開けなくなったので戻した: ${p.path}` : `店主の承認で直そうとしたが、できなかった: ${p.path}`;
    run.steps.push({ at: Date.now(), kind: "decision", title, tool: "承認して直す", result: status === "applied" ? `控えを取って書き、お店を開いて確かめた(${v})` : r.ok ? `戻した(${v})` : `${r.error}: ${r.detail ?? ""}` });
    run.updated_at = Date.now();
    await store.putRun(run);
  }
  return r.ok ? { ok: true as const, status, result: r.result } : { ok: false as const, status, error: r.error, detail: r.detail };
}
