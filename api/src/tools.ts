// SPDX-License-Identifier: GPL-2.0-or-later
// Agent が使える道具。受け口の操作に薄くつなぐだけで、何をするかは Agent が決める
import type Anthropic from "@anthropic-ai/sdk";
import { callReceiver } from "./receiver.js";
import type { Shop } from "./store.js";

type Tool = Anthropic.Beta.BetaToolUnion;

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object" as const,
  properties,
  required,
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
      "Read a small text file under the shop root. Only .htaccess, .user.ini, composer.json, composer.lock, web.config, robots.txt and backups under var/self-harden/backups/ are readable.",
    input_schema: obj({ path: { type: "string" } }, ["path"]),
  },
  {
    name: "http_get",
    description:
      "Fetch a path of this shop from the outside, like a visitor would (GET, no redirects followed). Returns status, headers and the first 4KB of the body. Only this shop's origin is allowed.",
    input_schema: obj({ path: { type: "string", description: "Must start with /" } }, ["path"]),
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
      "Write the full content of a configuration file of the shop. target is one of root/.htaccess, root/.user.ini, or dir:<existing directory relative to root>/.htaccess. A backup is always taken first. Right after writing, the receiver opens the shop's top page and itself; on a server error it rolls back in the same request. Returns backup_id, verify results and rolled_back. Some directives that would let PHP run other files are refused by the receiver.",
    input_schema: obj(
      {
        target: { type: "string" },
        content: { type: "string" },
        reason: { type: "string", description: "One Japanese sentence: why this change" },
      },
      ["target", "content", "reason"],
    ),
  },
  {
    name: "restore",
    description: "Restore a file from a backup taken by write_file (use the backup_id). The current content is backed up again before restoring.",
    input_schema: obj({ backup_id: { type: "string" } }, ["backup_id"]),
  },
  {
    name: "list_backups",
    description: "List backups taken so far (newest first).",
    input_schema: obj({}),
  },
  {
    name: "wait",
    description: "Pause the session for the given number of seconds (max 360) before continuing.",
    input_schema: obj({ seconds: { type: "integer", minimum: 1, maximum: 360 }, reason: { type: "string" } }, ["seconds", "reason"]),
  },
  {
    name: "report",
    description: "Finish the session with the final report for the shop owner. All text in Japanese. Call exactly once, at the end.",
    input_schema: obj(
      {
        summary: { type: "string", description: "3 lines for the shop owner" },
        findings: {
          type: "array",
          items: obj(
            {
              title: { type: "string" },
              severity: { type: "string", enum: ["high", "medium", "low", "info"] },
              evidence: { type: "string" },
              status: { type: "string", enum: ["fixed", "mitigated", "needs_human", "not_affected"] },
            },
            ["title", "severity", "evidence", "status"],
          ),
        },
        actions: {
          type: "array",
          items: obj(
            { title: { type: "string" }, target: { type: "string" }, backup_id: { type: "string" }, verified: { type: "string" } },
            ["title", "target", "verified"],
          ),
        },
        remaining: {
          type: "array",
          items: obj({ title: { type: "string" }, why: { type: "string" }, who: { type: "string" } }, ["title", "why", "who"]),
        },
        sources: { type: "array", items: obj({ title: { type: "string" }, url: { type: "string" } }, ["title", "url"]) },
      },
      ["summary", "findings", "actions", "remaining", "sources"],
    ),
  },
];

export const SERVER_TOOLS: Tool[] = [
  { type: "web_search_20260209", name: "web_search", max_uses: 15 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 15 },
];

export interface ToolOutcome {
  content: string;
  isError?: boolean;
  waitSec?: number;
  report?: unknown;
  title: string; // 経過の表示に出す一言
}

const LAB_PATH = { ".htaccess": "self-harden-lab/.htaccess", ".user.ini": "self-harden-lab/.user.ini" } as const;

function targetToPath(target: string): string | null {
  if (target === "root/.htaccess") return ".htaccess";
  if (target === "root/.user.ini") return ".user.ini";
  if (target.startsWith("dir:")) return target.slice(4);
  return null;
}

async function currentSha(shop: Shop, path: string): Promise<string | null> {
  const r = await callReceiver(shop, "read_file", { path });
  if (r.ok && r.result.exists) return r.result.sha256 as string;
  return null;
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

const j = (v: unknown) => JSON.stringify(v);

export async function runTool(shop: Shop, name: string, input: any): Promise<ToolOutcome> {
  switch (name) {
    case "inspect": {
      const r = await callReceiver(shop, "inspect", input?.sections ? { sections: input.sections } : {});
      return { content: j(r), isError: !r.ok, title: "サーバーを調べる" };
    }
    case "list_dir": {
      const r = await callReceiver(shop, "list_dir", { path: input.path ?? "", depth: input.depth ?? 0 });
      return { content: j(r), isError: !r.ok, title: `ファイルの一覧を見る: /${input.path ?? ""}` };
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
    case "lab_test": {
      const file = input.file as keyof typeof LAB_PATH;
      if (!(file in LAB_PATH)) return { content: j({ error: "file must be .htaccess or .user.ini" }), isError: true, title: "小部屋で試す" };
      const arm = await callReceiver(shop, "lab_arm", {}); // 小部屋が無ければ作る
      if (!arm.ok) return { content: j(arm), isError: true, title: "小部屋で試す" };
      const sha = await currentSha(shop, LAB_PATH[file]);
      const w = await callReceiver(shop, "write_file", { target: `lab/${file}`, content: input.content, expected_sha256: sha });
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
      const sha = await currentSha(shop, path);
      const receiverPath = new URL(shop.receiver_url).pathname;
      const r = await callReceiver(shop, "write_file", {
        target: input.target,
        content: input.content,
        expected_sha256: sha,
        verify: { paths: ["/", receiverPath], timeout_sec: 8 },
      });
      return { content: j(r), isError: !r.ok, title: `本番に入れる: ${input.target}(${input.reason ?? ""})` };
    }
    case "restore": {
      const r = await callReceiver(shop, "restore", { backup_id: input.backup_id });
      return { content: j(r), isError: !r.ok, title: `退避から戻す: ${input.backup_id}` };
    }
    case "list_backups": {
      const r = await callReceiver(shop, "list_backups", {});
      return { content: j(r), isError: !r.ok, title: "退避の一覧を見る" };
    }
    case "wait": {
      const sec = Math.max(1, Math.min(360, Number(input.seconds) || 1));
      return { content: j({ waited_seconds: sec }), waitSec: sec, title: `${sec} 秒待つ(${input.reason ?? ""})` };
    }
    case "report": {
      return { content: j({ ok: true }), report: input, title: "報告をまとめる" };
    }
    default:
      return { content: j({ error: `unknown tool ${name}` }), isError: true, title: name };
  }
}
