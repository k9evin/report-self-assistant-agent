/** 中文标签映射：阶段、工具、Gate、用例 expect 摘要。 */
import type { CaseExpect, ValidationIssue } from "./types";

export const PHASE_LABELS: Record<string, string> = {
  CREATED: "已创建",
  INSPECTING: "探测中",
  PLANNING: "计划中",
  VALIDATING: "门禁校验中",
  NEEDS_REPLAN: "需修正",
  BLOCKED: "被阻断",
  READY: "可执行",
  RUNNING: "回填中",
  COMPLETED: "完成",
  COMPLETED_WITH_WARNINGS: "完成（有警告）",
  FAILED: "失败",
  DONE: "完成",
  ERROR: "失败",
};

/** 阶段条的顺路径（异常阶段单独作为补充 chip 渲染）。 */
export const PHASE_FLOW = [
  "CREATED",
  "INSPECTING",
  "PLANNING",
  "VALIDATING",
  "READY",
  "RUNNING",
  "COMPLETED",
] as const;

export const PHASE_OFF_FLOW = ["NEEDS_REPLAN", "BLOCKED", "FAILED"] as const;

export function phaseLabel(phase: string | null | undefined): string {
  if (!phase) return "等待开始";
  return PHASE_LABELS[phase] ?? phase;
}

export type StatusTone = "success" | "warning" | "danger" | "neutral";

/** 阶段 → 药丸语义色：完成绿 / 有警告黄 / 失败红。 */
export function phaseTone(phase: string | null | undefined): StatusTone {
  switch (phase) {
    case "COMPLETED":
    case "DONE":
      return "success";
    case "COMPLETED_WITH_WARNINGS":
      return "warning";
    case "FAILED":
    case "ERROR":
    case "BLOCKED":
    case "NEEDS_REPLAN":
      return "danger";
    case "RUNNING":
    case "READY":
    case "VALIDATING":
    case "PLANNING":
    case "INSPECTING":
    case "CREATED":
      return "neutral";
    default:
      return "neutral";
  }
}

export const TOOL_LABELS: Record<string, string> = {
  inspect_template: "分析模板",
  inspect_xml_schema: "探测 XML 结构",
  submit_resolved_plan: "提交计划",
  validate_report_plan: "预演校验",
  execute_validated_plan: "执行回填",
  get_task_status: "读取结果",
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

export const GATE_LABELS: Record<string, string> = {
  source_schema_valid: "数据源结构有效",
  template_structure_valid: "模板结构有效",
  join_valid: "匹配有效",
  write_safe: "写入安全",
  output_integrity_valid: "输出完整性",
};

export const GATE_ORDER = [
  "source_schema_valid",
  "template_structure_valid",
  "join_valid",
  "write_safe",
  "output_integrity_valid",
] as const;

export function gateLabel(key: string): string {
  return GATE_LABELS[key] ?? key;
}

export function kindLabel(kind: string): string {
  if (kind === "agent") return "模型用例";
  if (kind === "deterministic") return "确定性用例，不花 token";
  return kind;
}

/** 把 expect 拼成一句人话，例如「五道 Gate 全通过 · 3 个 Excel · 无阻断项」。 */
export function expectSummary(expect: CaseExpect | undefined): string {
  if (!expect) return "未声明期望";
  const parts: string[] = [];

  if (expect.gates === "all_pass") parts.push("五道 Gate 全通过");
  else if (expect.gates === "not_all_pass") parts.push("五道 Gate 非全通过");

  const excel = expect.output_xlsx;
  if (typeof excel === "number") parts.push(`${excel} 个 Excel`);
  else parts.push("不校验 Excel 个数");

  if (Array.isArray(expect.error_codes)) {
    parts.push(
      expect.error_codes.length === 0
        ? "无阻断项"
        : `需出现错误码 ${expect.error_codes.join("、")}`,
    );
  }

  if (Array.isArray(expect.status) && expect.status.length > 0) {
    parts.push(`终态 ${expect.status.map((s) => PHASE_LABELS[s] ?? s).join(" / ")}`);
  }

  if (expect.execution_allowed === true) parts.push("允许写入");
  else if (expect.execution_allowed === false) parts.push("禁止写入");

  if (Array.isArray(expect.tool_calls) && expect.tool_calls.length > 0) {
    parts.push(`必调工具 ${expect.tool_calls.map((t) => toolLabel(t)).join("、")}`);
  }

  return parts.join(" · ");
}

/** 去掉 code 之后的细节文本（code 单独用等宽徽章渲染）。 */
export function issueDetail(issue: ValidationIssue): string {
  const count = typeof issue.count === "number" ? `×${issue.count}` : "";
  return [count, issue.message ?? ""].filter(Boolean).join(" ") || "—";
}
