/**
 * 计划契约入口守卫单测：ResolvedPlan 形状 + selector 子集必须与 report_tools.py 一致。
 * 不依赖网络与模型。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { coercePlanObject, isSupportedSelector, validateResolvedPlanShape, type ResolvedPlan } from "../../src/schemas.ts";

function validPlan(): ResolvedPlan {
  return {
    plan_version: 2,
    output: { mode: "one_file_per_sn", sn_source: "parent_directory_name", filename_pattern: "{sn}.xlsx" },
    source_file: { pattern: "*_test_report*.xml", multiple_match_policy: "latest_mtime" },
    source_records: {
      record_selector: ".//task",
      key_selector: "./@name",
      field_storage: { item_selector: "./item", field_name_selector: "./@name", field_value_selector: "./@value" },
    },
    template: {
      sheet_scope: "E1&2",
      join: { template_key_column: "P", source_key: "name", match_mode: "normalized_exact" },
      mappings: [{ source_field: "ge", target_column: "F" }],
    },
    normalization: { trim_whitespace: true, case_sensitive: false, rules: [] },
    missing_value_policy: "leave_blank_and_report",
    missing_case_policy: "warning",
    duplicate_source_key_policy: "block",
  };
}

test("完整计划通过形状校验", () => {
  assert.deepEqual(validateResolvedPlanShape(validPlan()), []);
});

test("缺少必需字段被指出", () => {
  const plan = validPlan() as Partial<ResolvedPlan>;
  delete plan.template;
  const problems = validateResolvedPlanShape(plan);
  assert.ok(problems.some((problem) => problem.includes("template")), problems.join("; "));
});

test("mappings 为空被拒绝", () => {
  const plan = validPlan();
  plan.template.mappings = [];
  assert.ok(validateResolvedPlanShape(plan).some((problem) => problem.includes("mappings")));
});

test("非法 selector 被拒绝", () => {
  const plan = validPlan();
  plan.source_records.record_selector = ".//task[@name]"; // 谓词不在支持子集内
  assert.ok(validateResolvedPlanShape(plan).some((problem) => problem.includes("record_selector")));
});

test("selector 子集与 Python 层一致", () => {
  for (const selector of [".//task", "./@name", "@name", "task/item", "./item/@name", ".//task/text()"]) {
    assert.equal(isSupportedSelector(selector), true, selector);
  }
  for (const selector of ["", "   ", ".//task[@name]", "//task[1]", "*/item", "task/item|other", "./item/@na me"]) {
    assert.equal(isSupportedSelector(selector), false, JSON.stringify(selector));
  }
});

test("小模型生成的 JSON 字符串 plan 自动解析与校验通过", () => {
  const plan = validPlan();
  const jsonStr = JSON.stringify(plan);
  // 1. 直接传 JSON 字符串
  assert.deepEqual(validateResolvedPlanShape(jsonStr), []);
  // 2. 包装在 Markdown 代码块内
  const mdStr = `\`\`\`json\n${jsonStr}\n\`\`\``;
  assert.deepEqual(validateResolvedPlanShape(mdStr), []);
  // 3. 包装在 { plan: "..." } 内
  assert.deepEqual(validateResolvedPlanShape({ plan: jsonStr }), []);
  assert.deepEqual(validateResolvedPlanShape({ plan: mdStr }), []);
});

test("子字段被小模型额外 stringify 时自动递归修复", () => {
  const plan = validPlan();
  const messyPlan = {
    ...plan,
    plan_version: "2", // 字符串版本号
    output: JSON.stringify(plan.output),
    source_records: {
      ...plan.source_records,
      field_storage: JSON.stringify(plan.source_records.field_storage),
    },
    template: {
      ...plan.template,
      mappings: JSON.stringify(plan.template.mappings),
    },
  };
  const coerced = coercePlanObject(messyPlan);
  assert.ok(coerced);
  assert.equal(coerced.plan_version, 2);
  assert.equal(typeof coerced.output, "object");
  assert.equal(typeof (coerced.template as Record<string, unknown>).mappings, "object");
  assert.deepEqual(validateResolvedPlanShape(messyPlan), []);
});

