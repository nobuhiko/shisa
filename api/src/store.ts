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
  kind: "think" | "tool" | "result" | "error" | "report" | "info" | "decision";
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
  usage: { input: number; output: number; cache_read: number; cache_write?: number; web_searches?: number; web_fetches?: number; haiku_input?: number; haiku_output?: number; usd?: number };
  budget_hit?: boolean;
  first?: boolean; // その店の初回の点検(費用の上限が高い)
}

export interface AppliedFix {
  path: string;
  sha256: string;
  ref: string;
  source: string;
  reason: string;
  run_id: string;
  at: number;
  from_version?: string; // 当てる前の版(修正で版が変わったときの照らし合わせの基準)
  via?: "fix" | "release" | "manual"; // manual: 公式の直しが手で入っていたのを見つけて数えたもの(Shisa は書いていない)
  package_complete?: boolean; // 部品の修正を、公式の差分で全部のファイルをそろえて当てたもの
}

// 店主の承認で直す提案(カスタマイズしたファイルの直し)。書くのは、店主がお店の管理画面で承認したあとだけ
export interface Proposal {
  proposal_id: string;
  shop_id: string;
  run_id: string;
  path: string; // お店の中の相対パス
  title: string;
  owner_text: string; // 店主向け: 何が危ないか・何を変えるか・失うもの
  developer_text: string; // 制作会社向け: 自分で直すのが不安なときに渡す説明
  sha256_before: string;
  sha256_new: string;
  new_content: string;
  diff: string;
  verify_paths: string[]; // 書いたあとに開いて確かめる、お店の中のページ
  status: "pending" | "running" | "applied" | "rolled_back" | "failed" | "superseded";
  // kind が upgrade のときは、同じ系列の公式の修正版への版上げ(データベースの作り変えを含む)。path・new_content は使わない
  kind?: "fix" | "upgrade";
  from_version?: string;
  to_version?: string;
  upgrade?: unknown; // 窓口が返した作業の様子(段・記録)
  created_at: number;
  decided_at?: number;
  result?: unknown;
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
  // Agent が当てた公式の修正(店ごと)。次の照らし合わせで「意図した違い」として扱う
  getApplied(shopId: string): Promise<AppliedFix[]>;
  addApplied(shopId: string, fixes: AppliedFix[]): Promise<void>;
  // 調べた結果の控え(版・部品・通知ごと。この API につながる店で使い回す)
  getResearch(key: string): Promise<any | null>;
  putResearch(key: string, rec: any): Promise<void>;
  getProposal(id: string): Promise<Proposal | null>;
  putProposal(p: Proposal): Promise<void>;
  listProposals(shopId: string): Promise<Proposal[]>;
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

  async getApplied(shopId: string) { return (await this.read<AppliedFix[]>("applied", shopId)) ?? []; }
  async addApplied(shopId: string, fixes: AppliedFix[]) {
    const cur = await this.getApplied(shopId);
    const byPath = new Map(cur.map((f) => [f.path, f]));
    for (const f of fixes) byPath.set(f.path, f);
    await this.write("applied", shopId, [...byPath.values()]);
  }
  getProposal(id: string) { return this.read<Proposal>("proposals", id); }
  putProposal(p: Proposal) { return this.write("proposals", p.proposal_id, p); }
  async listProposals(shopId: string) {
    return (await this.all<Proposal>("proposals")).filter((p) => p.shop_id === shopId).sort((a, b) => b.created_at - a.created_at);
  }
  getResearch(key: string) { return this.read<any>("intel", key); }
  putResearch(key: string, rec: any) { return this.write("intel", key, rec); }

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
