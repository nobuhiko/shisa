import { describe, it, expect } from "vitest";
import { officialFixScope } from "../src/official.js";

describe("公式の修正の全部のファイル(GitHub の公式リポジトリから)", () => {
  it("4.2.3 → 4.2.3-p2 は、版の表示も含めて 4 ファイル(p1 の分も入る)", async () => {
    const s = await officialFixScope("4.2.3", "4.2.3-p2");
    expect(s.blockers).toEqual([]);
    expect(s.files).toEqual(expect.arrayContaining([
      "src/Eccube/Common/Constant.php",
      "src/Eccube/Service/TwoFactorAuthService.php",
      "src/Eccube/EventListener/TwoFactorAuthListener.php",
      "src/Eccube/Controller/Admin/Setting/System/TwoFactorAuthController.php",
      "src/Eccube/Controller/Admin/Store/OwnerStoreController.php",
    ]));
    expect(s.files.some((f) => f.startsWith("tests/"))).toBe(false);
  }, 30_000);
  it("4.2.0 → 4.2.3 は、DB の作り変えが要るので止める", async () => {
    const s = await officialFixScope("4.2.0", "4.2.3");
    expect(s.blockers.some((b) => b.startsWith("app/DoctrineMigrations/") || b.startsWith("src/Eccube/Entity/"))).toBe(true);
  }, 30_000);
  it("決まりの外の版の指定は断る", async () => {
    await expect(officialFixScope("4.2.3", "main")).rejects.toThrow();
  });
});
