import { describe, it, expect } from "vitest";
import { reportGaps } from "../src/reportcheck.js";

describe("報告の見直し", () => {
  it("実行環境を暫定策で防いだだけで、サーバー会社への依頼の項目が無ければ書き直しを求める", () => {
    expect(reportGaps({ findings: [{ category: "php", status: "mitigated", title: "x" }] })).toHaveLength(1);
  });
  it("サーバー会社への依頼の項目があればよい", () => {
    expect(reportGaps({ findings: [{ category: "php", status: "mitigated" }, { category: "php", status: "needs_human", to: "server_company" }] })).toHaveLength(0);
  });
  it("制作会社への依頼は、実行環境の依頼とは数えない", () => {
    expect(reportGaps({ findings: [{ category: "php", status: "mitigated" }, { category: "custom", status: "needs_human", to: "developer" }] })).toHaveLength(1);
  });
  it("当てはまらない・直した報告は何も言わない", () => {
    expect(reportGaps({ findings: [{ category: "php", status: "not_affected" }, { category: "packages", status: "mitigated" }] })).toHaveLength(0);
    expect(reportGaps({})).toHaveLength(0);
  });
});
