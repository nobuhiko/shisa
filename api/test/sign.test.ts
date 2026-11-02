import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { hmacHex, stringToSign, responseSignature, verifyRequest, signRequest } from "../src/sign.js";

const v = JSON.parse(readFileSync(new URL("../../docs/signature-test-vector.json", import.meta.url), "utf8"));

describe("署名", () => {
  it("リクエストの署名が見本と一致する", async () => {
    const q = v.request;
    const s = await stringToSign(q.method, q.path, q.shop, q.timestamp, q.nonce, q.body);
    expect(s).toBe(q.string_to_sign);
    expect(await hmacHex(v.secret, s)).toBe(q.signature);
  });
  it("返事の署名が見本と一致する", async () => {
    expect(await responseSignature(v.secret, v.request.nonce, v.response.body)).toBe(v.response.signature);
  });
  it("自分で署名したものは通り、書き換え・古い時刻・違う鍵は通らない", async () => {
    const h = await signRequest(v.secret, "GET", "/v1/shops/shp_test0001/runs", "shp_test0001", "");
    const get = (m: Record<string, string>) => ({ get: (k: string) => Object.entries(m).find(([a]) => a.toLowerCase() === k)?.[1] });
    expect(await verifyRequest(v.secret, "shp_test0001", "GET", "/v1/shops/shp_test0001/runs", get(h), "")).toBe(h["X-SH-Nonce"]);
    expect(await verifyRequest(v.secret, "shp_test0001", "GET", "/v1/shops/shp_test0001/runs", get(h), "x")).toBeNull();
    expect(await verifyRequest("0".repeat(64), "shp_test0001", "GET", "/v1/shops/shp_test0001/runs", get(h), "")).toBeNull();
    const old = await signRequest(v.secret, "GET", "/p", "shp_test0001", "", Date.now() - 301_000);
    expect(await verifyRequest(v.secret, "shp_test0001", "GET", "/p", get(old), "")).toBeNull();
  });
});
