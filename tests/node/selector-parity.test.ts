/**
 * 不变量：TS 入口守卫 isSupportedSelector 与确定性层 report_tools.py 的 parse_selector
 * 必须接受完全相同的 selector 集合。任何一侧放宽/收紧都会让"入口放行、Dry-Run 拒绝"或
 * "入口拒绝、Dry-Run 本可通过"这种难查的偏差重新出现。
 *
 * 依赖本地 python3（与运行时同一个解释器）。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { PROJECT_ROOT } from "../../src/config.ts";
import { isSupportedSelector } from "../../src/schemas.ts";

const CASES = [
  ".//task",
  ".//a/b/c",
  "./task",
  "task/item",
  "//task",
  "./@name",
  "item/@name",
  "a/b/@c",
  "@name",
  "@a.b-c",
  "./item",
  ".//task/text()",
  "./item/text()",
  "a/b/text()",
  "text()",
  ".//text()",
  "//text()",
  ".//task[@name]",
  ".//item[@name='x']",
  "//task[1]",
  "*/item",
  "task/item|other",
  "./item/@na me",
  "@",
  "@1bad",
  "@name/x",
  "@name/",
  ".",
  "..",
  "/",
  "///",
  ".//",
  "a[1]",
  "ns:tag",
  "a/b-c_d",
  "a/.",
  "a/./b",
  "a/@",
  "..//a",
  "a//b",
  "task//item",
  "",
  "   ",
];

/** 在 Python 侧逐个跑 parse_selector，返回与 CASES 等长的布尔数组。 */
function pythonAcceptance(): boolean[] {
  const script = [
    "import json, sys, importlib.util",
    `spec = importlib.util.spec_from_file_location("rt", ${JSON.stringify(path.join(PROJECT_ROOT, "tools", "report_tools.py"))})`,
    "rt = importlib.util.module_from_spec(spec); spec.loader.exec_module(rt)",
    "cases = json.loads(sys.stdin.read())",
    "out = []",
    "for c in cases:",
    "    try:",
    "        rt.parse_selector(c); out.append(True)",
    "    except Exception:",
    "        out.append(False)",
    "print(json.dumps(out))",
  ].join("\n");
  const stdout = execFileSync(process.env.REPORT_PYTHON ?? "python3", ["-c", script], {
    input: JSON.stringify(CASES),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout) as boolean[];
}

test("selector 子集与 Python 层逐例一致", () => {
  const python = pythonAcceptance();
  assert.equal(python.length, CASES.length);
  const mismatches = CASES.map((selector, index) => ({ selector, ts: isSupportedSelector(selector), py: python[index] })).filter(
    (row) => row.ts !== row.py,
  );
  assert.deepEqual(mismatches, [], `两侧判定不一致: ${JSON.stringify(mismatches)}`);
});
