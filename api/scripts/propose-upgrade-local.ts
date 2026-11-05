// 開発用(手元のデモのお店だけ): Claude を呼ばずに、版上げの提案を作る(承認の流れや、途中で止めたときの回復を試すため)
// 使い方(API の箱の中で): npx tsx scripts/propose-upgrade-local.ts <shop_id> <上げ先の版>
import { FileStore } from "../src/store.js";
import { proposeUpgrade } from "../src/tools.js";

const [shopId, to] = process.argv.slice(2);
const store = new FileStore(process.env.SH_DATA_DIR ?? "./data");
const shop = await store.getShop(shopId);
if (!shop) throw new Error("お店がありません: " + shopId);
const p = await proposeUpgrade(shop, { store, runId: "run_local" }, { to, title: `EC-CUBE を ${to} に上げる`, owner_text: "(手元の確かめ用の提案)" });
console.log(JSON.stringify({ proposal_id: p.proposal_id, keep: p.keep, fingerprint: p.fingerprint }));
