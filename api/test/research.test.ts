import { describe, it, expect } from "vitest";
import { satisfies } from "../src/research.js";

describe("composer の版の条件", () => {
  it("範囲と OR を読む", () => {
    expect(satisfies("v2.15.2", ">=2.0.0,<2.16.1|>=3.0.0,<3.14.0")).toBe(true);
    expect(satisfies("v2.16.1", ">=2.0.0,<2.16.1|>=3.0.0,<3.14.0")).toBe(false);
    expect(satisfies("3.13.9", ">=2.0.0,<2.16.1|>=3.0.0,<3.14.0")).toBe(true);
    expect(satisfies("v2.15.2", "<=3.26.0")).toBe(true);
    expect(satisfies("v5.4.20", ">=5.4.0 <5.4.31")).toBe(true);
    expect(satisfies("v5.4.31", ">=5.4.0 <5.4.31")).toBe(false);
    expect(satisfies("1.0.0", "=1.0.0")).toBe(true);
    expect(satisfies("dev-main", "<1.0")).toBe(false);
  });
});
