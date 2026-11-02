// SPDX-License-Identifier: GPL-2.0-or-later
// 保存先。いまは手元のファイル。Workers に載せるときは Durable Objects / KV で同じ形を作る
import { mkdir, readFile, writeFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";

export interface Shop {
  shop_id: string;
  secret: string;
  receiver_url: string;
  shop_url: string;
  platform: string;
  status: "registered" | "connected" | "error";
  created_at: number;
}

export interface Step {
  at: number;
  kind: "think" | "tool" | "result" | "error" | "report" | "info";
  title: string;
  tool?: string; // 道具の名前(画面では小さく出す)
  result?: string; // 結果の 1 行(店の人向け)
  detail?: string;
}

export interface Run {
  run_id: string;
  shop_id: string;
  status: "running" | "done" | "failed";
  trigger: "connect" | "schedule" | "manual" | "advisory";
  advisory_url: string | null;
  created_at: number;
  updated_at: number;
  wake_at: number;
  turns: number;
  messages: unknown[];
  steps: Step[];
  report?: unknown;
  usage: { input: number; output: number; cache_read: number; cache_write?: number };
}

export interface Store {
  getShop(id: string): Promise<Shop | null>;
  putShop(shop: Shop): Promise<void>;
  listShops(): Promise<Shop[]>;
  listRunning(): Promise<Run[]>;
  getRun(id: string): Promise<Run | null>;
  putRun(run: Run): Promise<void>;
  listRuns(shopId: string): Promise<Run[]>;
  // 点検の途中で貼られた通知の受け箱。点検の記録と分けて持つ(1 歩が古い記録で上書きして消さないように)
  addInbox(runId: string, url: string): Promise<void>;
  takeInbox(runId: string): Promise<string[]>;
  // 使った nonce を記録する。既にあれば false
  useNonce(key: string, ttlSec: number): Promise<boolean>;
}

export class FileStore implements Store {
  private nonces = new Map<string, number>();
  constructor(private dir: string) {}

  private async read<T>(kind: string, id: string): Promise<T | null> {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
    try {
      return JSON.parse(await readFile(join(this.dir, kind, id + ".json"), "utf8")) as T;
    } catch {
      return null;
    }
  }

  private async write(kind: string, id: string, v: unknown) {
    await mkdir(join(this.dir, kind), { recursive: true });
    const p = join(this.dir, kind, id + ".json");
    await writeFile(p + ".tmp", JSON.stringify(v), { mode: 0o600 });
    await rename(p + ".tmp", p);
  }

  getShop(id: string) { return this.read<Shop>("shops", id); }
  putShop(s: Shop) { return this.write("shops", s.shop_id, s); }
  getRun(id: string) { return this.read<Run>("runs", id); }
  putRun(r: Run) { return this.write("runs", r.run_id, r); }

  private async all<T>(kind: string): Promise<T[]> {
    let files: string[] = [];
    try { files = await readdir(join(this.dir, kind)); } catch { return []; }
    const out: T[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const v = await this.read<T>(kind, f.slice(0, -5));
      if (v) out.push(v);
    }
    return out;
  }

  listShops() { return this.all<Shop>("shops"); }

  async listRunning() { return (await this.all<Run>("runs")).filter((r) => r.status === "running"); }

  async listRuns(shopId: string) {
    return (await this.all<Run>("runs")).filter((r) => r.shop_id === shopId).sort((a, b) => b.created_at - a.created_at);
  }

  private inbox = new Map<string, string[]>();

  async addInbox(runId: string, url: string) {
    const list = [...(this.inbox.get(runId) ?? (await this.read<string[]>("inbox", runId)) ?? []), url];
    this.inbox.set(runId, list);
    await this.write("inbox", runId, list);
  }

  async takeInbox(runId: string) {
    const list = this.inbox.get(runId) ?? (await this.read<string[]>("inbox", runId)) ?? [];
    this.inbox.set(runId, []);
    if (list.length) await this.write("inbox", runId, []);
    return list;
  }

  async useNonce(key: string, ttlSec: number) {
    const now = Date.now();
    for (const [k, exp] of this.nonces) if (exp < now) this.nonces.delete(k);
    if (this.nonces.has(key)) return false;
    this.nonces.set(key, now + ttlSec * 1000);
    return true;
  }
}
