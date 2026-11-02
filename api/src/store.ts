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
  usage: { input: number; output: number; cache_read: number };
}

export interface Store {
  getShop(id: string): Promise<Shop | null>;
  putShop(shop: Shop): Promise<void>;
  listShops(): Promise<Shop[]>;
  listRunning(): Promise<Run[]>;
  getRun(id: string): Promise<Run | null>;
  putRun(run: Run): Promise<void>;
  listRuns(shopId: string): Promise<Run[]>;
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

  async useNonce(key: string, ttlSec: number) {
    const now = Date.now();
    for (const [k, exp] of this.nonces) if (exp < now) this.nonces.delete(k);
    if (this.nonces.has(key)) return false;
    this.nonces.set(key, now + ttlSec * 1000);
    return true;
  }
}
