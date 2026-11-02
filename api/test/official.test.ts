import { describe, it, expect } from "vitest";
import { manifest, officialContent } from "../src/official.js";

describe("公式の一覧", () => {
  it("EC-CUBE 4.2.0 の公式リリースからファイルごとの SHA-256 を作る", async () => {
    const m = await manifest("4.2.0");
    expect(m.tarball_sha256).toBe("dc0ab44a2c26e69f6adc1f4755acab39f653d5218edaaad84777bde4f1f7129d");
    expect(Object.keys(m.files).length).toBeGreaterThan(10000);
    expect(m.files["src/Eccube/Common/Constant.php"]).toMatch(/^[0-9a-f]{64}$/);
    expect(m.files["index.php"]).toBeDefined();
    const c = await officialContent("4.2.0", "src/Eccube/Common/Constant.php");
    expect(c?.toString()).toContain("4.2.0");
  }, 120_000);
  it("決まりの外の版は取りに行かない", async () => {
    await expect(manifest("../../evil")).rejects.toThrow();
    await expect(manifest("main")).rejects.toThrow();
  });
});
