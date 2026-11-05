import { describe, it, expect } from "vitest";
import { fixAlreadyIn } from "../src/manualfix.js";

// 例は架空の差分(特定の弱点の直しではない)
const patch = [
  "@@ -10,7 +10,8 @@ class SampleController",
  "     public function index(Request $request)",
  "     {",
  "-        $name = $request->get('name');",
  "+        $name = (string) $request->get('name');",
  "+        $name = mb_substr($name, 0, 100);",
  "         return $this->render($name);",
  "     }",
].join("\n");

const official = ["<?php", "class SampleController", "{", "    public function index(Request $request)", "    {", "        $name = $request->get('name');", "        return $this->render($name);", "    }", "}"].join("\n");

describe("公式の直しが手で入っているか", () => {
  it("カスタマイズがあっても、足した行がそろい消した行が無ければ入っている", () => {
    const shop = official
      .replace("        $name = $request->get('name');", "        $name = (string) $request->get('name');\n        $name = mb_substr($name, 0, 100);")
      .replace("}\n", "}\n// 店のカスタマイズ: 独自の処理\nfunction shop_custom_helper() { return 1; }\n");
    const r = fixAlreadyIn(patch, shop);
    expect(r.applied).toBe(true);
    expect(r.added_lines).toBe(2);
  });
  it("字下げや空白が違っても入っているとみなす", () => {
    const shop = official.replace("        $name = $request->get('name');", "\t$name = (string)  $request->get('name');\n\t$name = mb_substr($name, 0, 100);");
    expect(fixAlreadyIn(patch, shop).applied).toBe(true);
  });
  it("直していないカスタマイズファイルは入っていない", () => {
    const shop = official + "\n// 店のカスタマイズ\n";
    const r = fixAlreadyIn(patch, shop);
    expect(r.applied).toBe(false);
    expect(r.missing_added).toBe(2);
    expect(r.remaining_removed).toBe(1);
  });
  it("一部だけ入っているときは入っていないとみなす(上書きしない側)", () => {
    const shop = official.replace("        $name = $request->get('name');", "        $name = (string) $request->get('name');");
    expect(fixAlreadyIn(patch, shop).applied).toBe(false);
  });
  it("足した行はあるが消すはずの行が残っているときは入っていない", () => {
    const shop = official.replace("        return", "        $name = (string) $request->get('name');\n        $name = mb_substr($name, 0, 100);\n        return");
    expect(fixAlreadyIn(patch, shop).applied).toBe(false);
  });
  it("差分が無い(GitHub が省いた)ときは入っていないとみなす", () => {
    expect(fixAlreadyIn(undefined, official).applied).toBe(false);
    expect(fixAlreadyIn("@@ -1 +1 @@\n-}\n+}", official).applied).toBe(false);
  });
});
