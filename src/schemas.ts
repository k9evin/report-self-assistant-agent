/**
 * 三阶段 Plan 契约（PRD §7）：IntentPlan / ResolvedPlan / ValidatedPlan。
 * 与 tools/report_tools.py 的校验、执行层保持同一份语义；这里的校验是入口守卫，
 * 最终的权威判定仍然来自确定性工具的 Dry-Run。
 */

export interface IntentPlan {
  output: { mode: "one_file_per_sn"; filename_pattern: string };
  source_file_intent: { file_type: "xml"; name_hint?: string };
  template_intent: {
    sheet_scope: string;
    row_match_key: { semantic_name: string; column_hint?: string };
  };
  field_intents: { source_semantic: string; target_column_hint?: string }[];
}

export interface ResolvedPlan {
  plan_version: 2;
  dataset_id?: string;
  output: {
    mode: "one_file_per_sn";
    sn_source: "parent_directory_name";
    filename_pattern: string;
  };
  source_file: { pattern: string; multiple_match_policy: "latest_mtime" | "error" };
  source_records: {
    record_selector: string;
    key_selector: string;
    field_storage: {
      item_selector: string | null;
      field_name_selector: string | null;
      field_value_selector: string;
    };
  };
  template: {
    sheet_scope: string | string[];
    join: {
      template_key_column: string;
      source_key: string;
      match_mode: "exact" | "normalized_exact";
    };
    mappings: { source_field: string; target_column: string }[];
  };
  normalization: { trim_whitespace: boolean; case_sensitive: boolean; rules: string[] };
  missing_value_policy: "leave_blank_and_report" | "block";
  missing_case_policy: "warning" | "block";
  duplicate_source_key_policy: "block" | "warning";
}

export interface ValidatedPlan {
  plan_version: 2;
  validation: Record<string, unknown>;
  gates: Record<string, "pass" | "fail" | "not_executed">;
  warnings: { code: string; count?: number }[];
  errors: { code: string }[];
  status: "pass" | "pass_with_warnings" | "rejected";
  execution_allowed: boolean;
  plan_sha256?: string;
}

/** 确定性工具支持的 selector 子集（与 report_tools.py 的 parse_selector 一致）。 */
const SELECTOR_NAME = /^[A-Za-z_][\w.-]*$/;

export function isSupportedSelector(selector: unknown): boolean {
  if (typeof selector !== "string" || !selector.trim()) return false;
  let s = selector.trim();
  if (s.startsWith("@")) return SELECTOR_NAME.test(s.slice(1));
  if (s === "text()" || s === "./text()" || s === ".//text()") return true;
  // 叶子：元素 / 属性 / 文本。属性与文本叶子允许没有中间步骤（如 ./@name），与 Python 一致。
  let leafIsElement = true;
  if (s.endsWith("/text()")) {
    s = s.slice(0, -"/text()".length);
    leafIsElement = false;
  } else {
    const cut = s.lastIndexOf("/@");
    if (cut !== -1) {
      if (!SELECTOR_NAME.test(s.slice(cut + 2))) return false;
      s = s.slice(0, cut);
      leafIsElement = false;
    }
  }
  if (s.startsWith(".//")) s = s.slice(3);
  else if (s.startsWith("//")) s = s.slice(2);
  else if (s.startsWith("./")) s = s.slice(2);
  else if (s.startsWith(".")) s = s.slice(1);
  const steps = s.split("/").filter((part) => part && part !== ".");
  if (leafIsElement && steps.length === 0) return false;
  return steps.every((step) => SELECTOR_NAME.test(step));
}

type Problems = string[];

function requireObject(value: unknown, field: string, problems: Problems): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    problems.push(`${field} 必须是对象`);
    return null;
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string, problems: Problems): string {
  if (typeof value !== "string" || !value.trim()) {
    problems.push(`${field} 必须是非空字符串`);
    return "";
  }
  return value;
}

/** 形状校验：返回问题清单，空数组表示通过入口守卫。 */
export function validateResolvedPlanShape(input: unknown): Problems {
  const problems: Problems = [];
  const plan = requireObject(input, "plan", problems);
  if (!plan) return problems;

  if (plan.plan_version !== 2) problems.push("plan_version 必须为 2");

  const output = requireObject(plan.output, "output", problems);
  if (output) {
    if (output.mode !== "one_file_per_sn") problems.push("output.mode 只支持 one_file_per_sn");
    if (output.sn_source !== "parent_directory_name") {
      problems.push("output.sn_source 只支持 parent_directory_name");
    }
    const pattern = requireString(output.filename_pattern, "output.filename_pattern", problems);
    if (pattern && !pattern.includes("{sn}")) {
      problems.push("output.filename_pattern 必须包含 {sn} 占位符（一 SN 一文件）");
    }
  }

  const sourceFile = requireObject(plan.source_file, "source_file", problems);
  if (sourceFile) {
    requireString(sourceFile.pattern, "source_file.pattern", problems);
    const policy = sourceFile.multiple_match_policy;
    if (policy !== "latest_mtime" && policy !== "error") {
      problems.push("source_file.multiple_match_policy 只支持 latest_mtime / error");
    }
  }

  const records = requireObject(plan.source_records, "source_records", problems);
  if (records) {
    const recordSelector = requireString(records.record_selector, "source_records.record_selector", problems);
    if (recordSelector && !isSupportedSelector(recordSelector)) {
      problems.push(`source_records.record_selector 语法不支持: ${recordSelector}`);
    }
    const keySelector = requireString(records.key_selector, "source_records.key_selector", problems);
    if (keySelector && !isSupportedSelector(keySelector)) {
      problems.push(`source_records.key_selector 语法不支持: ${keySelector}`);
    }
    const storage = requireObject(records.field_storage, "source_records.field_storage", problems);
    if (storage) {
      for (const [field, value] of [
        ["item_selector", storage.item_selector],
        ["field_name_selector", storage.field_name_selector],
      ] as const) {
        if (value !== null && !isSupportedSelector(value)) {
          problems.push(`source_records.field_storage.${field} 语法不支持: ${String(value)}`);
        }
      }
      const valueSelector = requireString(
        storage.field_value_selector,
        "source_records.field_storage.field_value_selector",
        problems,
      );
      if (valueSelector && !isSupportedSelector(valueSelector)) {
        problems.push(`source_records.field_storage.field_value_selector 语法不支持: ${valueSelector}`);
      }
    }
  }

  const template = requireObject(plan.template, "template", problems);
  if (template) {
    const scope = template.sheet_scope;
    if (typeof scope !== "string" && !Array.isArray(scope)) {
      problems.push("template.sheet_scope 必须是字符串或字符串数组");
    }
    const join = requireObject(template.join, "template.join", problems);
    if (join) {
      const keyColumn = requireString(join.template_key_column, "template.join.template_key_column", problems);
      if (keyColumn && !/^[A-Z]{1,3}$/.test(keyColumn)) {
        problems.push(`template.join.template_key_column 必须是列字母（如 P）: ${keyColumn}`);
      }
      requireString(join.source_key, "template.join.source_key", problems);
      if (join.match_mode !== "exact" && join.match_mode !== "normalized_exact") {
        problems.push("template.join.match_mode 只支持 exact / normalized_exact（不得模糊匹配）");
      }
    }
    const mappings = template.mappings;
    if (!Array.isArray(mappings) || mappings.length === 0) {
      problems.push("template.mappings 必须是非空数组");
    } else {
      mappings.forEach((entry, index) => {
        const mapping = requireObject(entry, `template.mappings[${index}]`, problems);
        if (!mapping) return;
        requireString(mapping.source_field, `template.mappings[${index}].source_field`, problems);
        const column = requireString(mapping.target_column, `template.mappings[${index}].target_column`, problems);
        if (column && !/^[A-Z]{1,3}$/.test(column)) {
          problems.push(`template.mappings[${index}].target_column 必须是列字母: ${column}`);
        }
      });
    }
  }

  const normalization = requireObject(plan.normalization, "normalization", problems);
  if (normalization) {
    if (normalization.trim_whitespace !== undefined && typeof normalization.trim_whitespace !== "boolean") {
      problems.push("normalization.trim_whitespace 必须是布尔值");
    }
    if (normalization.case_sensitive !== undefined && typeof normalization.case_sensitive !== "boolean") {
      problems.push("normalization.case_sensitive 必须是布尔值");
    }
    if (normalization.rules !== undefined && !Array.isArray(normalization.rules)) {
      problems.push("normalization.rules 必须是数组");
    }
  }

  const policies: [string, unknown, readonly string[]][] = [
    ["missing_value_policy", plan.missing_value_policy, ["leave_blank_and_report", "block"]],
    ["missing_case_policy", plan.missing_case_policy, ["warning", "block"]],
    ["duplicate_source_key_policy", plan.duplicate_source_key_policy, ["block", "warning"]],
  ];
  for (const [field, value, allowed] of policies) {
    if (value !== undefined && !allowed.includes(value as string)) {
      problems.push(`${field} 只支持 ${allowed.join(" / ")}`);
    }
  }

  return problems;
}

export function isValidationAllowed(validation: unknown): boolean {
  if (typeof validation !== "object" || validation === null) return false;
  const record = validation as Record<string, unknown>;
  return record.execution_allowed === true;
}
