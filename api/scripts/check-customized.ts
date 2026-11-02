// 開発用: 公式の修正を当てる道具が、お店の改造を上書きせずに断るかを確かめる(Claude は呼ばない)
import { FileStore } from "../src/store.js";
import { runTool } from "../src/tools.js";
const store = new FileStore(process.env.SH_DATA_DIR ?? "./data");
const shops = (await store.listShops()).filter((s) => s.shop_url === "http://server-c").sort((a, b) => b.created_at - a.created_at);
const shop = shops[0];
const paths = ["src/Eccube/Common/Constant.php", "src/Eccube/Service/TwoFactorAuthService.php", "src/Eccube/EventListener/TwoFactorAuthListener.php", "src/Eccube/Controller/Admin/Setting/System/TwoFactorAuthController.php", "src/Eccube/Controller/Admin/Store/OwnerStoreController.php"];
const out = await runTool(shop, "apply_official_fix", { note: "確認", ref: "4.2.3-p2", paths, reason: "check" }, { store, runId: "run_check0000" });
console.log(out.content);
