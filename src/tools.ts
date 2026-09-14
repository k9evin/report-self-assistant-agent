/**
 * Agent 能看到的全部工具（PRD §12）。
 *
 * 关键约束：运行时 `noTools: "builtin"` —— 模型没有 bash / read / write，
 * 只能调用这里注册的工具；参数由后端构造，模型无法传入宿主机路径。
 */
import fs from "node:fs";
import path from "node:path";

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { AppConfig } from "./config.ts";
import { parseToolJson, runTool } from "./python.ts";
import { coercePlanObject, validateResolvedPlanShape } from "./schemas.ts";
import { DatasetError, readOnlyEvidence, resolveDataset } from "./storage.ts";
import { appendEvent, loadTask, saveTask, sha256File, updateTaskStatus } from "./tasks.ts";

export interface ReportToolContext {
  config: AppConfig;
  taskId: string;
  workspaceDir: string;
}

type ToolResult = { content: { type: "text"; text: string }[]; details: Record<string, unknown> };

function toolError(code: string, message: string, extra: Record<string, unknown> = {}): ToolResult {
  return {
    content: [{ type: "text", text: `TOOL_ERROR ${code}\n${JSON.stringify({ status: "tool_error", code, message, ...extra }, null, 2)}` }],
    details: { error: code },
  };
}

function toolOk(payload: unknown, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], details };
}

function datasetFailure(error: unknown): ToolResult {
  if (error instanceof DatasetError) {
    return toolError(error.code, error.message, error.details);
  }
  return toolError("DATASET_RESOLVE_FAILED", error instanceof Error ? error.message : String(error));
}

export function createReportTools(ctx: ReportToolContext): ToolDefinition[] {
  const { config, taskId, workspaceDir } = ctx;
  const taskFile = path.join(workspaceDir, "task.json");
  const planFile = path.join(workspaceDir, "plan.json");
  const validationFile = path.join(workspaceDir, "validation.json");
  const outputsDir = path.join(workspaceDir, "outputs");
  const templateInspectionFile = path.join(workspaceDir, "template-inspection.json");
  const xmlInspectionFile = path.join(workspaceDir, "xml-inspection.json");

  const task = () => loadTask(config, taskId);
  const datasetId = () => task().dataset_id;
  const templatePath = () => task().template_path;

  /** 任务前挂载校验（PRD §18.5.5）：跑一次确定性 check-dataset 并留审计。 */
  const runDatasetCheck = async () => {
    const dataset = resolveDataset(config, datasetId());
    const run = await runTool(config, [
      "check-dataset",
      "--mount-root", dataset.mountRoot,
      "--relative", dataset.resolvedPath.slice(dataset.mountRoot.length).replace(/^[/\\]/, ""),
      "--dataset-id", dataset.datasetId,
    ]);
    const json = parseToolJson<Record<string, unknown>>(run);
    appendEvent(config, taskId, {
      type: "dataset.checked",
      dataset_id: dataset.datasetId,
      ok: json?.ok ?? false,
      problems: json?.problems ?? [],
      warnings: json?.warnings ?? [],
    });
    return { dataset, check: json, ok: json?.ok === true };
  };

  const inspectTemplate = defineTool({
    name: "inspect_template",
    label: "Inspect Template",
    // 计划/验证/执行是有状态流水线：禁止与其它工具并发，保证顺序确定。
    executionMode: "sequential",
    description:
      "分析本任务的 Excel 模板结构（Sheet、每列非空数、匹配键候选列、公式单元格、合并区域、保护状态）。" +
      "无参数：模板由任务提供。返回 JSON 证据，用于决定 ResolvedPlan 的 sheet_scope / join / mappings。",
    parameters: Type.Object({
      max_samples: Type.Optional(Type.Number({ description: "每列返回的样例值个数，默认 3" })),
    }),
    execute: async (_toolCallId, params) => {
      updateTaskStatus(config, taskId, "INSPECTING", "inspect_template");
      const run = await runTool(config, [
        "inspect-template",
        "--template", templatePath(),
        "--max-samples", String(params.max_samples ?? 3),
        "--out", templateInspectionFile,
      ]);
      const json = parseToolJson(run);
      if (!json) return toolError("INSPECT_TEMPLATE_FAILED", "模板探测失败", { stderr: run.stderr.slice(0, 2000) });
      appendEvent(config, taskId, { type: "tool.inspect_template", ok: true });
      return toolOk(json, { artifact: templateInspectionFile });
    },
  });

  const inspectXml = defineTool({
    name: "inspect_xml_schema",
    label: "Inspect XML Schema",
    // 计划/验证/执行是有状态流水线：禁止与其它工具并发，保证顺序确定。
    executionMode: "sequential",
    description:
      "探测本任务数据集里代表性 SN 的 XML 结构：记录节点候选（record_selector）、键候选（key_selector）、" +
      "字段模型（item/name/value selector）、结构指纹与异常。采样覆盖最早/最新/大小中位数。无路径参数：数据集由 dataset_id 解析。",
    parameters: Type.Object({
      pattern: Type.Optional(Type.String({ description: "报告文件名 glob，默认 *_test_report*.xml" })),
      sample_count: Type.Optional(Type.Number({ description: "采样 SN 数，默认 4" })),
    }),
    execute: async (_toolCallId, params) => {
      updateTaskStatus(config, taskId, "INSPECTING", "inspect_xml_schema");
      let dataset;
      try {
        const checked = await runDatasetCheck();
        if (!checked.ok) {
          return toolError("DATASET_UNAVAILABLE", "数据集不可用，任务中止", { check: checked.check });
        }
        dataset = checked.dataset;
      } catch (error) {
        return datasetFailure(error);
      }
      const args = [
        "inspect-xml",
        "--dataset", dataset.resolvedPath,
        "--sample-count", String(params.sample_count ?? 4),
        "--out", xmlInspectionFile,
      ];
      if (params.pattern) args.push("--pattern", params.pattern);
      const run = await runTool(config, args);
      const json = parseToolJson(run);
      if (!json) return toolError("INSPECT_XML_FAILED", "XML 结构探测失败", { stderr: run.stderr.slice(0, 2000) });
      appendEvent(config, taskId, {
        type: "tool.inspect_xml_schema",
        ok: true,
        read_only_evidence: readOnlyEvidence(dataset.resolvedPath),
      });
      return toolOk(json, { artifact: xmlInspectionFile, dataset: dataset.resolvedPath });
    },
  });

  const submitPlan = defineTool({
    name: "submit_resolved_plan",
    label: "Submit Resolved Plan",
    // 计划/验证/执行是有状态流水线：禁止与其它工具并发，保证顺序确定。
    executionMode: "sequential",
    description:
      "提交 ResolvedPlan（PRD §7.2 的 JSON）。后端会做形状校验、注入 dataset_id、落盘并返回 plan_sha256。" +
      "校验不通过会返回全部问题字段；任何字段都不要凭猜测填写，必须能追溯到探测证据。",
    parameters: Type.Object({
      plan: Type.Any({ description: "ResolvedPlan JSON 对象（亦兼容 JSON 字符串及 Markdown 代码块包裹）" }),
    }),
    execute: async (_toolCallId, params) => {
      const raw = (params as Record<string, unknown> | null)?.plan !== undefined
        ? (params as Record<string, unknown>).plan
        : params;
      const parsedPlan = coercePlanObject(raw);
      if (!parsedPlan) {
        appendEvent(config, taskId, {
          type: "plan.rejected_by_schema",
          problems: ["plan 无法解析：必须是有效的 ResolvedPlan JSON 对象或可解析的 JSON 字符串"],
        });
        return toolError("PLAN_SCHEMA_INVALID", "ResolvedPlan 无法解析为有效 JSON 对象", {
          problems: ["plan 无法解析：必须是有效的 ResolvedPlan JSON 对象或可解析的 JSON 字符串"],
        });
      }
      const problems = validateResolvedPlanShape(parsedPlan);
      if (problems.length > 0) {
        appendEvent(config, taskId, { type: "plan.rejected_by_schema", problems });
        return toolError("PLAN_SCHEMA_INVALID", "ResolvedPlan 形状校验未通过", { problems });
      }
      const plan = { ...parsedPlan, dataset_id: datasetId() };
      fs.writeFileSync(planFile, JSON.stringify(plan, null, 2) + "\n", "utf8");
      const planSha = sha256File(planFile);
      const current = task();
      current.plan_sha256 = planSha;
      current.status = "VALIDATING";
      saveTask(config, current);
      appendEvent(config, taskId, { type: "plan.submitted", plan_sha256: planSha });
      return toolOk({ status: "accepted", plan_sha256: planSha, stored_at: planFile, plan }, { plan_sha256: planSha });
    },
  });

  const validatePlan = defineTool({
    name: "validate_report_plan",
    label: "Validate Report Plan",
    // 计划/验证/执行是有状态流水线：禁止与其它工具并发，保证顺序确定。
    executionMode: "sequential",
    description:
      "对已提交的计划做 Dry-Run：在代表性样本 SN 上真实执行 复制模板→Join→写单元格→保存→重开→回读，" +
      "并返回五道 Gate、计数、警告与结构化错误（含修复候选）。无参数：使用已提交的计划。" +
      "只有 execution_allowed=true 才允许执行；rejected 时按错误里的候选修正后重新 submit 再验证。",
    parameters: Type.Object({}),
    execute: async () => {
      if (!fs.existsSync(planFile)) {
        return toolError("PLAN_NOT_SUBMITTED", "还没有提交计划，请先调用 submit_resolved_plan");
      }
      const dataset = resolveDataset(config, datasetId());
      updateTaskStatus(config, taskId, "VALIDATING", "validate_report_plan");
      const run = await runTool(config, [
        "validate-plan",
        "--plan", planFile,
        "--dataset", dataset.resolvedPath,
        "--template", templatePath(),
        "--dry-run-dir", path.join(workspaceDir, "dryrun"),
        "--out", validationFile,
      ]);
      const json = parseToolJson<Record<string, unknown>>(run);
      if (!json) return toolError("VALIDATE_FAILED", "Dry-Run 未产出结果", { stderr: run.stderr.slice(0, 2000) });
      json.plan_sha256 = sha256File(planFile);
      fs.writeFileSync(validationFile, JSON.stringify(json, null, 2) + "\n", "utf8");

      const allowed = json.execution_allowed === true;
      const current = task();
      current.plan_sha256 = json.plan_sha256 as string;
      current.validation_summary = {
        status: String(json.status),
        execution_allowed: allowed,
        gates: (json.gates ?? {}) as Record<string, string>,
        warning_count: Array.isArray(json.warnings) ? json.warnings.length : 0,
        error_count: Array.isArray(json.errors) ? json.errors.length : 0,
      };
      if (allowed) current.status = "READY";
      else current.status = Array.isArray(json.errors) && json.errors.length > 0 ? "NEEDS_REPLAN" : "BLOCKED";
      saveTask(config, current);
      appendEvent(config, taskId, {
        type: "validation.completed",
        status: json.status,
        execution_allowed: allowed,
        errors: (json.errors as { code?: string }[] | undefined)?.map((e) => e.code) ?? [],
      });
      return toolOk(json, { execution_allowed: allowed });
    },
  });

  const executePlan = defineTool({
    name: "execute_validated_plan",
    label: "Execute Validated Plan",
    // 计划/验证/执行是有状态流水线：禁止与其它工具并发，保证顺序确定。
    executionMode: "sequential",
    description:
      "执行已验证的计划（一 SN 一文件 + validation_report.json）。必须传入 validate_report_plan 返回的 plan_sha256；" +
      "后端会校验计划未改、模板 hash 未变、execution_allowed=true、数据集授权有效。被拒绝时不要重试，按返回的原因处理。",
    parameters: Type.Object({
      plan_sha256: Type.String({ description: "来自 validate_report_plan 的计划 hash" }),
      resume: Type.Optional(
        Type.Boolean({
          description:
            "断点续跑。上一轮被中断（超时/被杀）后置 true：已完成且产物 hash 未变的 SN 直接跳过，只补没做完的。首次执行不要传。",
        }),
      ),
      workers: Type.Optional(
        Type.Number({ description: "并行进程数。默认 min(CPU 数 − 1, 8)；受机器资源限制时才需要显式指定。" }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      if (!fs.existsSync(planFile) || !fs.existsSync(validationFile)) {
        return toolError("PLAN_NOT_VALIDATED", "计划未提交或未验证，禁止执行");
      }
      const current = task();
      const currentPlanSha = sha256File(planFile);
      if (params.plan_sha256 !== currentPlanSha) {
        return toolError("PLAN_HASH_MISMATCH", "计划已被修改或 hash 不匹配", {
          expected: currentPlanSha,
          received: params.plan_sha256,
        });
      }
      const validation = JSON.parse(fs.readFileSync(validationFile, "utf8")) as { execution_allowed?: boolean };
      if (validation.execution_allowed !== true) {
        return toolError("EXECUTION_NOT_ALLOWED", "验证未通过，禁止执行", { validation_status: validation });
      }
      const templateSha = sha256File(templatePath());
      if (templateSha !== current.template_sha256) {
        return toolError("TEMPLATE_CHANGED", "模板 hash 与任务创建时不一致", {
          expected: current.template_sha256,
          actual: templateSha,
        });
      }
      let dataset;
      try {
        const checked = await runDatasetCheck();
        if (!checked.ok) return toolError("DATASET_UNAVAILABLE", "数据集不可用，禁止执行", { check: checked.check });
        dataset = checked.dataset;
      } catch (error) {
        return datasetFailure(error);
      }
      if (fs.existsSync(path.join(outputsDir, "validation_report.json")) && params.resume !== true) {
        return toolError("OUTPUT_DIR_NOT_EMPTY", "输出目录已有执行结果，请改用新任务或先确认；若上次是被中断的，用 resume=true 续跑", {
          outputs: outputsDir,
        });
      }
      updateTaskStatus(config, taskId, "RUNNING", "execute_validated_plan");
      const args = [
        "execute-plan",
        "--plan", planFile,
        "--dataset", dataset.resolvedPath,
        "--template", templatePath(),
        "--out-dir", outputsDir,
        // 进度走 stderr，逐行进审计日志：上万行要跑几分钟到几十分钟，不能让人对着黑屏等。
        "--progress",
      ];
      if (params.resume === true) args.push("--resume");
      if (typeof params.workers === "number") args.push("--workers", String(Math.max(1, Math.floor(params.workers))));

      let progressCount = 0;
      const run = await runTool(config, args, {
        timeoutMs: Number(process.env.REPORT_EXECUTE_TIMEOUT_MS ?? 4 * 60 * 60 * 1000),
        onStderr: (line) => {
          progressCount += 1;
          // 只留最近 200 条，避免超大任务的审计日志本身变成瓶颈
          if (progressCount <= 3 || progressCount % 25 === 0) {
            appendEvent(config, taskId, { type: "execute.progress", message: line });
          }
        },
      });
      const report = parseToolJson<{ totals?: Record<string, number>; results?: unknown[] }>(run);
      if (!report) return toolError("EXECUTE_FAILED", "批量执行未产出报告", { stderr: run.stderr.slice(0, 2000) });

      const totals = report.totals ?? {};
      const failed = Number(totals.sn_failed ?? 0);
      const withWarnings = Number(totals.sn_completed_with_warnings ?? 0);
      const next = task();
      next.outputs = {
        directory: outputsDir,
        total: Number(totals.sn_total ?? 0),
        completed: Number(totals.sn_completed ?? 0),
        completed_with_warnings: withWarnings,
        failed,
      };
      next.status = failed > 0 ? "FAILED" : withWarnings > 0 ? "COMPLETED_WITH_WARNINGS" : "COMPLETED";
      saveTask(config, next);
      appendEvent(config, taskId, { type: "task.completed", totals });
      return toolOk(
        {
          status: next.status,
          totals,
          outputs_directory: outputsDir,
          failed_sn: (report.results as { sn?: string; status?: string }[] | undefined)
            ?.filter((r) => r.status === "failed")
            .map((r) => r.sn)
            .slice(0, 20),
        },
        { outputs_directory: outputsDir },
      );
    },
  });

  const getStatus = defineTool({
    name: "get_task_status",
    label: "Get Task Status",
    // 计划/验证/执行是有状态流水线：禁止与其它工具并发，保证顺序确定。
    executionMode: "sequential",
    description: "读取本任务的当前状态、验证摘要、产物位置与最近审计事件（只读，无参数）。",
    parameters: Type.Object({}),
    execute: async () => {
      const current = loadTask(config, taskId);
      const outputs = fs.existsSync(outputsDir) ? fs.readdirSync(outputsDir).sort() : [];
      return toolOk({
        task_id: current.task_id,
        status: current.status,
        dataset_id: current.dataset_id,
        template_sha256: current.template_sha256,
        plan_sha256: current.plan_sha256,
        validation_summary: current.validation_summary ?? null,
        outputs: current.outputs ?? null,
        output_files: outputs,
        artifacts: {
          task: taskFile,
          plan: fs.existsSync(planFile) ? planFile : null,
          validation: fs.existsSync(validationFile) ? validationFile : null,
          outputs_directory: outputsDir,
        },
      });
    },
  });

  return [inspectTemplate, inspectXml, submitPlan, validatePlan, executePlan, getStatus];
}
