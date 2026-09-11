/**
 * 测试案例集：把"这套系统到底靠不靠得住"变成可重复执行的断言。
 *
 * 两类用例：
 *  - kind="agent"：真的调用模型跑完整流程（探测 → 计划 → Dry-Run → 执行 → 汇报），贵但覆盖真实链路；
 *  - kind="deterministic"：只跑确定性核，不花 token，用来守住安全边界（公式覆盖、选择器语法、挂载缺失、路径越界）。
 *
 * 案例定义是纯 JSON（cases/*.json），断言结果由 evaluateCase 统一计算，前端与服务端共用同一份判定。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getMountRoot, loadConfig, type AppConfig, type DatasetRecord, type MountRootConfig } from "./config.ts";
import { createPlanner, type ToolCallTrace } from "./planner.ts";
import { parseToolJson, runTool } from "./python.ts";
import type { ResolvedPlan, ValidatedPlan } from "./schemas.ts";
import { DatasetError, resolveDataset } from "./storage.ts";
import { createTask, type TaskRecord } from "./tasks.ts";

export type CaseKind = "agent" | "deterministic";
export type CaseScenario =
  | "validate-plan"
  | "validate-and-execute"
  | "mount-not-found"
  | "dataset-escape"
  | "scale-execute"
  | "scale-parallel"
  | "scale-resume"
  | "scale-inspect";

export interface CaseExpect {
  /** 任务终态必须属于其中之一。 */
  status?: string[];
  execution_allowed?: boolean;
  gates?: "all_pass" | "not_all_pass";
  /** 必须出现的错误码；给空数组表示"不允许有任何错误"。 */
  error_codes?: string[];
  output_xlsx?: number;
  /** 必须被调用过的工具。 */
  tool_calls?: string[];
  /** 必须【没有】被调用过的工具。 */
  not_tool_calls?: string[];
  /** 确定性用例的期望问题码（MOUNT_NOT_FOUND / DATASET_OUTSIDE_MOUNT_ROOT …）。 */
  problem_code?: string;
  /** 批量规模：处理的 SN 数、写出的单元格总数、失败的 SN 数。 */
  sn_total?: number;
  cells_written?: number;
  min_cells_written?: number;
  sn_failed?: number;
  /** 失败 SN 的错误码里必须出现这些（用来区分"正确地阻断"和"碰巧失败"）。 */
  failed_sn_error_codes?: string[];
  /** 执行报告的警告里必须出现这些码——脏数据被容忍不等于可以被悄悄丢掉。 */
  warning_codes?: string[];
  /** 模板探测必须如实报告的最大行数——上万行时不能被采样截断。 */
  template_max_row?: number;
  /** 中间产物（探测/验证 JSON）不得超过这个体量——上万行时它是 Agent 的上下文来源。 */
  artifact_max_kb?: number;
  /** 并行相对串行的最小加速比（只在 CPU 足够时判定）。 */
  min_speedup?: number;
  /** 断点续跑时被跳过的 SN 数。 */
  resumed_sn?: number;
}

export interface CaseSpec {
  id: string;
  title: string;
  description: string;
  kind: CaseKind;
  scenario?: CaseScenario;
  dataset_id?: string;
  auto_execute?: boolean;
  request?: string;
  plan?: Record<string, unknown>;
  /** 只处理前 N 个 SN（规模用例里用来控制跑一次的成本）。 */
  limit?: number;
  /** scale-execute / scale-parallel 使用的并行进程数。 */
  workers?: number;
  expect: CaseExpect;
}

export interface CaseCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface CaseRunResult {
  checks: CaseCheck[];
  passed: boolean;
  task_id: string | null;
  /** 计划/验证/探测证据与 outputs/ 所在目录：模型用例是任务目录，确定性用例是临时草稿目录。 */
  artifact_dir: string | null;
  status: string | null;
  validation: ValidatedPlan | null;
  /** 模型用例是 ResolvedPlan，确定性用例是 cases/*.json 里原样给出的计划对象。 */
  plan: ResolvedPlan | Record<string, unknown> | null;
  outputs: TaskRecord["outputs"] | null;
  output_files: string[];
  tool_calls: ToolCallTrace[];
  reply: string;
  problem_code: string | null;
  duration_ms: number;
  /** 规模用例才有的量：SN 总数、写出单元格数、失败 SN 数、最大中间产物字节数、并行加速比、续跑跳过数。 */
  sn_total: number | null;
  cells_written: number | null;
  sn_failed: number | null;
  artifact_bytes: number | null;
  speedup: number | null;
  resumed_sn: number | null;
  /** 失败 SN 的错误码集合；执行报告的警告码集合；模板探测到的最大行数。 */
  failed_sn_error_codes: string[];
  warning_codes: string[];
  template_max_row: number | null;
}

function baseResult(): Omit<CaseRunResult, "checks" | "passed"> {
  return {
    task_id: null,
    artifact_dir: null,
    status: null,
    validation: null,
    plan: null,
    outputs: null,
    output_files: [],
    tool_calls: [],
    reply: "",
    problem_code: null,
    duration_ms: 0,
    sn_total: null,
    cells_written: null,
    sn_failed: null,
    artifact_bytes: null,
    speedup: null,
    resumed_sn: null,
    failed_sn_error_codes: [],
    warning_codes: [],
    template_max_row: null,
  };
}

interface ExecuteTotals {
  sn_total: number;
  sn_completed: number;
  sn_completed_with_warnings: number;
  sn_failed: number;
  sn_resumed?: number;
  cells_written: number;
  unmatched_case_total: number;
  missing_value_total: number;
}

interface ExecuteReport {
  totals: ExecuteTotals;
  results: { sn: string; status: string; errors?: { code: string }[]; warnings?: { code: string; resolution?: string }[] }[];
}

/** 运行期事件：服务端转成 SSE，直接跑用例时打印到终端。 */
export type RunEvent =
  | { type: "status"; phase: string }
  | { type: "tool_start"; name: string; at: string }
  | { type: "tool_end"; name: string; ok: boolean; at: string }
  | { type: "text"; delta: string }
  | { type: "check"; name: string; ok: boolean; detail: string }
  | { type: "log"; message: string };

export type Emit = (event: RunEvent) => void;

// --------------------------------------------------------------------------- //
// 读取用例
// --------------------------------------------------------------------------- //

export function casesDir(config: AppConfig = loadConfig()): string {
  return path.join(config.projectRoot, "cases");
}

export function listCases(config: AppConfig = loadConfig()): CaseSpec[] {
  const dir = casesDir(config);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const spec = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as CaseSpec;
      if (spec.kind !== "agent" && spec.kind !== "deterministic") {
        throw new Error(`用例 ${name} 的 kind 非法: ${String(spec.kind)}`);
      }
      return spec;
    });
}

export function getCase(id: string, config: AppConfig = loadConfig()): CaseSpec {
  const spec = listCases(config).find((item) => item.id === id);
  if (!spec) throw new Error(`未知用例: ${id}`);
  return spec;
}

// --------------------------------------------------------------------------- //
// 断言
// --------------------------------------------------------------------------- //

function check(name: string, ok: boolean, detail = ""): CaseCheck {
  return { name, ok, detail };
}

/** 按 expect 逐条判定。前端与服务端都走这里，避免"看着像过了"。 */
export function evaluateCase(spec: CaseSpec, result: Omit<CaseRunResult, "checks" | "passed">): CaseCheck[] {
  const expect = spec.expect;
  const checks: CaseCheck[] = [];
  const validation = result.validation;

  if (expect.problem_code !== undefined) {
    checks.push(
      check(`问题码为 ${expect.problem_code}`, result.problem_code === expect.problem_code, String(result.problem_code)),
    );
  }
  if (expect.status) {
    checks.push(check(`任务终态在 ${expect.status.join(" / ")}`, expect.status.includes(result.status ?? ""), String(result.status)));
  }
  if (expect.execution_allowed !== undefined) {
    checks.push(
      check(
        expect.execution_allowed ? "Dry-Run 放行执行" : "Dry-Run 拒绝执行",
        validation?.execution_allowed === expect.execution_allowed,
        String(validation?.execution_allowed),
      ),
    );
  }
  if (expect.gates) {
    const gates = Object.values(validation?.gates ?? {});
    const allPass = gates.length > 0 && gates.every((gate) => gate === "pass");
    checks.push(
      check(
        expect.gates === "all_pass" ? "五道 Gate 全通过" : "存在未通过的 Gate",
        expect.gates === "all_pass" ? allPass : !allPass,
        JSON.stringify(validation?.gates ?? {}),
      ),
    );
  }
  if (expect.error_codes) {
    // 空数组 = 不允许有任何阻断项；非空 = 这些错误码必须出现（允许确定性核追加下游错误码，
    // 例如 FORMULA_OVERWRITE 之后还会带出 WRITE_READBACK_MISMATCH，那是同一个根因的后续表现）。
    const codes = (validation?.errors ?? []).map((error) => error.code);
    const missing = expect.error_codes.filter((code) => !codes.includes(code));
    checks.push(
      check(
        expect.error_codes.length === 0 ? "无阻断项" : `出现错误码 ${expect.error_codes.join(", ")}`,
        missing.length === 0,
        codes.length === 0 ? "(无)" : codes.join(", "),
      ),
    );
  }
  if (expect.output_xlsx !== undefined) {
    const xlsx = result.output_files.filter((file) => file.endsWith(".xlsx"));
    checks.push(check(`产出 ${expect.output_xlsx} 个 Excel`, xlsx.length === expect.output_xlsx, xlsx.join(", ") || "(无)"));
  }
  const called = new Set(result.tool_calls.map((trace) => trace.name));
  for (const name of expect.tool_calls ?? []) {
    checks.push(check(`调用了 ${name}`, called.has(name), [...called].join(" → ") || "(无)"));
  }
  for (const name of expect.not_tool_calls ?? []) {
    checks.push(check(`没有调用 ${name}`, !called.has(name), [...called].join(" → ") || "(无)"));
  }

  // ---- 规模断言 ----
  if (expect.sn_total !== undefined) {
    checks.push(check(`处理 ${expect.sn_total} 个 SN`, result.sn_total === expect.sn_total, String(result.sn_total)));
  }
  if (expect.cells_written !== undefined) {
    checks.push(
      check(
        `写入 ${expect.cells_written.toLocaleString("en-US")} 个单元格`,
        result.cells_written === expect.cells_written,
        result.cells_written === null ? "null" : result.cells_written.toLocaleString("en-US"),
      ),
    );
  }
  if (expect.min_cells_written !== undefined) {
    checks.push(
      check(
        `写入单元格数 ≥ ${expect.min_cells_written.toLocaleString("en-US")}`,
        result.cells_written !== null && result.cells_written >= expect.min_cells_written,
        result.cells_written === null ? "null" : result.cells_written.toLocaleString("en-US"),
      ),
    );
  }
  if (expect.sn_failed !== undefined) {
    checks.push(check(`失败的 SN 数为 ${expect.sn_failed}`, result.sn_failed === expect.sn_failed, String(result.sn_failed)));
  }
  if (expect.failed_sn_error_codes) {
    const missing = expect.failed_sn_error_codes.filter((code) => !result.failed_sn_error_codes.includes(code));
    checks.push(
      check(
        `失败原因包含 ${expect.failed_sn_error_codes.join(", ")}`,
        missing.length === 0,
        result.failed_sn_error_codes.join(", ") || "(无失败 SN)",
      ),
    );
  }
  if (expect.warning_codes) {
    const missing = expect.warning_codes.filter((code) => !result.warning_codes.includes(code));
    checks.push(
      check(
        `执行警告包含 ${expect.warning_codes.join(", ")}`,
        missing.length === 0,
        result.warning_codes.join(", ") || "(无警告)",
      ),
    );
  }
  if (expect.template_max_row !== undefined) {
    checks.push(
      check(
        `模板探测如实报告 ${expect.template_max_row} 行`,
        result.template_max_row === expect.template_max_row,
        String(result.template_max_row),
      ),
    );
  }
  if (expect.artifact_max_kb !== undefined) {
    const kb = result.artifact_bytes === null ? null : result.artifact_bytes / 1024;
    checks.push(
      check(
        `中间产物不超过 ${expect.artifact_max_kb} KB`,
        kb !== null && kb <= expect.artifact_max_kb,
        kb === null ? "null" : `${kb.toFixed(1)} KB`,
      ),
    );
  }
  if (expect.min_speedup !== undefined) {
    const cpus = os.cpus().length;
    if (cpus < 4) {
      checks.push(check(`并行加速比 ≥ ${expect.min_speedup}×`, true, `跳过：本机只有 ${cpus} 核，不适合判定并行收益`));
    } else {
      checks.push(
        check(
          `并行加速比 ≥ ${expect.min_speedup}×`,
          result.speedup !== null && result.speedup >= expect.min_speedup,
          result.speedup === null ? "null" : `${result.speedup.toFixed(2)}×`,
        ),
      );
    }
  }
  if (expect.resumed_sn !== undefined) {
    checks.push(check(`续跑跳过 ${expect.resumed_sn} 个 SN`, result.resumed_sn === expect.resumed_sn, String(result.resumed_sn)));
  }

  if (checks.length === 0) checks.push(check("用例没有可判定的期望", false, "expect 为空"));
  return checks;
}

// --------------------------------------------------------------------------- //
// 确定性用例
// --------------------------------------------------------------------------- //

/** 每个确定性用例一个独立草稿目录，绝不碰真实任务目录。 */
function scratchDir(config: AppConfig, caseId: string): string {
  const dir = fs.mkdtempSync(path.join(config.workDir, `case-${caseId}-`));
  return dir;
}

function cloneConfig(
  config: AppConfig,
  over: { mountRoots?: Map<string, MountRootConfig>; datasets?: Map<string, DatasetRecord> },
): AppConfig {
  return {
    ...config,
    mountRoots: over.mountRoots ?? config.mountRoots,
    datasets: over.datasets ?? config.datasets,
  };
}

function fixturePaths(config: AppConfig, datasetId: string) {
  const dataset = resolveDataset(config, datasetId);
  return {
    dataset,
    template: path.join(getMountRoot(config, dataset.mountRootId).resolvedRoot, "template.xlsx"),
  };
}

interface ScaleContext {
  dir: string;
  datasetPath: string;
  template: string;
  planFile: string;
}

function preparePlanFile(config: AppConfig, spec: CaseSpec): ScaleContext {
  const dir = scratchDir(config, spec.id);
  const { dataset, template } = fixturePaths(config, spec.dataset_id!);
  const planFile = path.join(dir, "plan.json");
  fs.writeFileSync(planFile, JSON.stringify(spec.plan, null, 2) + "\n", "utf8");
  return { dir, datasetPath: dataset.resolvedPath, template, planFile };
}

async function runValidateStage(
  config: AppConfig,
  ctx: ScaleContext,
  emit: Emit,
  sampleSns?: number,
): Promise<{ validation: ValidatedPlan; validationFile: string }> {
  const validationFile = path.join(ctx.dir, "validation.json");
  const args = [
    "validate-plan",
    "--plan", ctx.planFile,
    "--dataset", ctx.datasetPath,
    "--template", ctx.template,
    "--dry-run-dir", path.join(ctx.dir, "dryrun"),
    "--out", validationFile,
  ];
  if (sampleSns) args.push("--sample-sns", String(sampleSns));
  emit({ type: "tool_start", name: "validate_report_plan", at: new Date().toISOString() });
  const run = await runTool(config, args);
  const validation = parseToolJson<ValidatedPlan>(run);
  emit({ type: "tool_end", name: "validate_report_plan", ok: validation !== null, at: new Date().toISOString() });
  if (!validation) {
    throw new Error(`Dry-Run 未产出结果: ${run.stderr.slice(0, 800) || `exit=${run.exitCode}`}`);
  }
  for (const gate of Object.entries(validation.gates ?? {})) {
    emit({ type: "log", message: `Gate ${gate[0]} = ${gate[1]}` });
  }
  return { validation, validationFile };
}

async function runExecuteStage(
  config: AppConfig,
  ctx: ScaleContext,
  emit: Emit,
  opts: { outDir: string; workers?: number; limit?: number; resume?: boolean },
): Promise<{ report: ExecuteReport; files: string[]; durationMs: number }> {
  const args = [
    "execute-plan",
    "--plan", ctx.planFile,
    "--dataset", ctx.datasetPath,
    "--template", ctx.template,
    "--out-dir", opts.outDir,
  ];
  if (opts.workers !== undefined) args.push("--workers", String(opts.workers));
  if (opts.limit !== undefined) args.push("--limit", String(opts.limit));
  if (opts.resume) args.push("--resume");
  emit({ type: "tool_start", name: "execute_validated_plan", at: new Date().toISOString() });
  const started = Date.now();
  const run = await runTool(config, args, { timeoutMs: 60 * 60 * 1000 });
  const durationMs = Date.now() - started;
  const report = parseToolJson<ExecuteReport>(run);
  emit({ type: "tool_end", name: "execute_validated_plan", ok: report !== null, at: new Date().toISOString() });
  if (!report) throw new Error(`批量执行未产出报告: ${run.stderr.slice(0, 800)}`);
  const files = fs.existsSync(opts.outDir)
    ? fs.readdirSync(opts.outDir).filter((name) => !name.startsWith("_")).sort()
    : [];
  return { report, files, durationMs };
}

/** 把执行报告里的规模量搬进统一的结果载荷。 */
function scalesFrom(report: ExecuteReport | null, sizeOf?: number): Partial<CaseRunResult> {
  if (!report) return {};
  const failedCodes = new Set<string>();
  const warningCodes = new Set<string>();
  for (const entry of report.results) {
    for (const warning of entry.warnings ?? []) warningCodes.add(warning.code);
    if (entry.status !== "failed") continue;
    for (const error of entry.errors ?? []) failedCodes.add(error.code);
  }
  return {
    sn_total: report.totals.sn_total,
    cells_written: report.totals.cells_written,
    sn_failed: report.totals.sn_failed,
    resumed_sn: report.totals.sn_resumed ?? null,
    artifact_bytes: sizeOf ?? null,
    failed_sn_error_codes: [...failedCodes].sort(),
    warning_codes: [...warningCodes].sort(),
  };
}

function outputsFrom(report: ExecuteReport, outDir: string): TaskRecord["outputs"] {
  return {
    directory: outDir,
    total: report.totals.sn_total,
    completed: report.totals.sn_completed,
    completed_with_warnings: report.totals.sn_completed_with_warnings,
    failed: report.totals.sn_failed,
  };
}

async function runValidateAndExecute(
  config: AppConfig,
  spec: CaseSpec,
  emit: Emit,
  { execute }: { execute: boolean },
): Promise<Omit<CaseRunResult, "checks" | "passed">> {
  const started = Date.now();
  const ctx = preparePlanFile(config, spec);
  emit({ type: "log", message: `挂载：${ctx.datasetPath}（只读）  模板：${ctx.template}` });
  const { validation } = await runValidateStage(config, ctx, emit);

  const outputsDir = path.join(ctx.dir, "outputs");
  let outputFiles: string[] = [];
  let outputs: TaskRecord["outputs"] | null = null;
  let scales: Partial<CaseRunResult> = {};

  if (execute) {
    if (validation.execution_allowed !== true) throw new Error("验证未放行，按契约不应执行");
    const { report, files } = await runExecuteStage(config, ctx, emit, { outDir: outputsDir });
    outputs = outputsFrom(report, outputsDir);
    outputFiles = files;
    scales = scalesFrom(report);
    emit({ type: "log", message: `输出：${files.join(", ") || "(无)"}` });
  }

  return {
    ...baseResult(),
    ...scales,
    artifact_dir: ctx.dir,
    status: validation.status,
    validation,
    plan: spec.plan ?? null,
    outputs,
    output_files: outputFiles,
    tool_calls: [
      { name: "validate_report_plan", ok: true, at: new Date().toISOString() },
      ...(execute ? [{ name: "execute_validated_plan" as const, ok: true, at: new Date().toISOString() }] : []),
    ],
    duration_ms: Date.now() - started,
  };
}

/** 规模基线：上万行 + 多个 SN 的完整 Dry-Run + 批量执行。 */
async function runScaleExecute(
  config: AppConfig,
  spec: CaseSpec,
  emit: Emit,
): Promise<Omit<CaseRunResult, "checks" | "passed">> {
  const started = Date.now();
  const ctx = preparePlanFile(config, spec);
  emit({ type: "log", message: `挂载：${ctx.datasetPath}（只读）  模板：${ctx.template}` });
  const { validation, validationFile } = await runValidateStage(config, ctx, emit);
  if (validation.execution_allowed !== true) throw new Error("验证未放行，规模用例无法继续");

  const outputsDir = path.join(ctx.dir, "outputs");
  const { report, files } = await runExecuteStage(config, ctx, emit, {
    outDir: outputsDir,
    workers: spec.workers,
    limit: spec.limit,
  });

  const stats = report.results.map((entry) => ({
    sn: entry.sn,
    status: entry.status,
    errors: (entry.errors ?? []).map((error) => error.code),
  }));
  const failedSamples = stats.filter((entry) => entry.status === "failed").slice(0, 3);
  emit({
    type: "log",
    message: `处理 ${report.totals.sn_total} 个 SN，写入 ${report.totals.cells_written} 个单元格，失败 ${report.totals.sn_failed}`,
  });
  for (const entry of failedSamples) {
    emit({ type: "log", message: `  失败 ${entry.sn}: ${entry.errors.join(", ")}` });
  }

  const artifacts = ["plan.json", "validation.json"].map((name) => path.join(ctx.dir, name));
  const artifactBytes = Math.max(
    fs.statSync(validationFile).size,
    ...artifacts.filter((file) => fs.existsSync(file)).map((file) => fs.statSync(file).size),
  );

  return {
    ...baseResult(),
    ...scalesFrom(report, artifactBytes),
    artifact_dir: ctx.dir,
    status: validation.status,
    validation,
    plan: spec.plan ?? null,
    outputs: outputsFrom(report, outputsDir),
    output_files: files,
    tool_calls: [
      { name: "validate_report_plan", ok: true, at: new Date().toISOString() },
      { name: "execute_validated_plan", ok: true, at: new Date().toISOString() },
    ],
    duration_ms: Date.now() - started,
  };
}

/**
 * 并行不只是更快，还必须和串行写出完全一样的内容。
 * 同一批 SN 分别用 1 个进程和 N 个进程各跑一次，比单元格总数与逐 SN 结论，再比耗时。
 */
async function runScaleParallel(
  config: AppConfig,
  spec: CaseSpec,
  emit: Emit,
): Promise<Omit<CaseRunResult, "checks" | "passed">> {
  const started = Date.now();
  const ctx = preparePlanFile(config, spec);
  const limit = spec.limit ?? 4;
  emit({ type: "log", message: `同一批 ${limit} 个 SN 分别串行与并行执行，比对内容与耗时` });

  const serialDir = path.join(ctx.dir, "serial");
  const parallelDir = path.join(ctx.dir, "parallel");
  emit({ type: "log", message: "串行：--workers 1" });
  const serial = await runExecuteStage(config, ctx, emit, { outDir: serialDir, workers: 1, limit });
  emit({ type: "log", message: `串行耗时 ${serial.durationMs}ms` });
  const parallelWorkers = spec.workers ?? Math.max(2, Math.min((os.cpus().length || 2) - 1, limit));
  emit({ type: "log", message: `并行：--workers ${parallelWorkers}` });
  const parallel = await runExecuteStage(config, ctx, emit, { outDir: parallelDir, workers: parallelWorkers, limit });
  emit({ type: "log", message: `并行耗时 ${parallel.durationMs}ms` });

  const speedup = parallel.durationMs > 0 ? serial.durationMs / parallel.durationMs : null;
  const sameTotals = serial.report.totals.cells_written === parallel.report.totals.cells_written;
  const sameOrder = serial.report.results.map((r) => r.sn).join() === parallel.report.results.map((r) => r.sn).join();
  const sameRows = serial.report.results.every((entry, index) => entry.status === parallel.report.results[index]?.status);
  if (!sameTotals || !sameOrder || !sameRows) {
    throw new Error(
      `并行与串行的结果不一致：cells ${serial.report.totals.cells_written} vs ${parallel.report.totals.cells_written}，` +
        `顺序一致=${sameOrder}，逐 SN 结论一致=${sameRows}`,
    );
  }

  return {
    ...baseResult(),
    ...scalesFrom(parallel.report),
    speedup,
    artifact_dir: ctx.dir,
    status: `serial=${serial.durationMs}ms parallel=${parallel.durationMs}ms`,
    plan: spec.plan ?? null,
    outputs: outputsFrom(parallel.report, parallelDir),
    output_files: parallel.files,
    tool_calls: [
      { name: "execute_validated_plan", ok: true, at: new Date().toISOString() },
      { name: "execute_validated_plan", ok: true, at: new Date().toISOString() },
    ],
    duration_ms: Date.now() - started,
  };
}

/** 断点续跑：跑完 → 删掉一个产物（模拟中途被杀）→ 带 --resume 重跑，只补缺失的那一个。 */
async function runScaleResume(
  config: AppConfig,
  spec: CaseSpec,
  emit: Emit,
): Promise<Omit<CaseRunResult, "checks" | "passed">> {
  const started = Date.now();
  const ctx = preparePlanFile(config, spec);
  const outputsDir = path.join(ctx.dir, "outputs");
  const limit = spec.limit ?? 4;

  const first = await runExecuteStage(config, ctx, emit, { outDir: outputsDir, workers: spec.workers, limit });
  const victim = first.files.filter((name) => name.endsWith(".xlsx"))[0];
  if (!victim) throw new Error("首次执行没有产出任何 Excel，无法验证续跑");
  fs.unlinkSync(path.join(outputsDir, victim));
  emit({ type: "log", message: `删掉 ${victim} 模拟中途被杀，然后带 --resume 重跑` });

  const resumed = await runExecuteStage(config, ctx, emit, { outDir: outputsDir, workers: spec.workers, limit, resume: true });
  const restored = fs.existsSync(path.join(outputsDir, victim));
  emit({ type: "log", message: `续跑：跳过 ${resumed.report.totals.sn_resumed ?? 0} 个，重新处理 ${resumed.report.totals.sn_total - (resumed.report.totals.sn_resumed ?? 0)} 个` });

  return {
    ...baseResult(),
    ...scalesFrom(resumed.report),
    artifact_dir: ctx.dir,
    status: `${victim} 已补回=${restored}`,
    plan: spec.plan ?? null,
    outputs: outputsFrom(resumed.report, outputsDir),
    output_files: resumed.files,
    tool_calls: [
      { name: "execute_validated_plan", ok: true, at: new Date().toISOString() },
      { name: "execute_validated_plan", ok: true, at: new Date().toISOString() },
    ],
    duration_ms: Date.now() - started,
  };
}

/**
 * 上下文安全：上万行时探测证据仍然是 KB 级，否则 Agent 在第一轮就会被自己的工具输出淹掉。
 */
async function runScaleInspect(
  config: AppConfig,
  spec: CaseSpec,
  emit: Emit,
): Promise<Omit<CaseRunResult, "checks" | "passed">> {
  const started = Date.now();
  const ctx = preparePlanFile(config, spec);
  const templateFile = path.join(ctx.dir, "template-inspection.json");
  const xmlFile = path.join(ctx.dir, "xml-inspection.json");

  emit({ type: "tool_start", name: "inspect_template", at: new Date().toISOString() });
  const templateRun = await runTool(config, ["inspect-template", "--template", ctx.template, "--out", templateFile]);
  emit({ type: "tool_end", name: "inspect_template", ok: templateRun.ok, at: new Date().toISOString() });
  if (!fs.existsSync(templateFile)) throw new Error(`模板探测未产出: ${templateRun.stderr.slice(0, 400)}`);

  emit({ type: "tool_start", name: "inspect_xml_schema", at: new Date().toISOString() });
  const xmlRun = await runTool(config, ["inspect-xml", "--dataset", ctx.datasetPath, "--out", xmlFile]);
  emit({ type: "tool_end", name: "inspect_xml_schema", ok: xmlRun.ok, at: new Date().toISOString() });
  if (!fs.existsSync(xmlFile)) throw new Error(`XML 探测未产出: ${xmlRun.stderr.slice(0, 400)}`);

  const sizes = [templateFile, xmlFile].map((file) => fs.statSync(file).size);
  const largest = Math.max(...sizes);
  const templateJson = JSON.parse(fs.readFileSync(templateFile, "utf8")) as {
    sheets?: { name?: string; max_row?: number; non_empty_columns?: Record<string, number> }[];
  };
  const maxRow = Math.max(...(templateJson.sheets ?? []).map((sheet) => sheet.max_row ?? 0));
  emit({ type: "log", message: `模板最大行数 ${maxRow}，探测证据最大 ${(largest / 1024).toFixed(1)} KB` });

  return {
    ...baseResult(),
    artifact_dir: ctx.dir,
    artifact_bytes: largest,
    template_max_row: maxRow,
    status: `最大 ${maxRow} 行，证据 ${(largest / 1024).toFixed(1)} KB`,
    tool_calls: [
      { name: "inspect_template", ok: true, at: new Date().toISOString() },
      { name: "inspect_xml_schema", ok: true, at: new Date().toISOString() },
    ],
    duration_ms: Date.now() - started,
  };
}

function runMountFailure(
  config: AppConfig,
  spec: CaseSpec,
  emit: Emit,
  kind: "mount-not-found" | "dataset-escape",
): Omit<CaseRunResult, "checks" | "passed"> {
  const started = Date.now();
  const base = scratchDir(config, spec.id);
  const rootConfig = getMountRoot(config, resolveDataset(config, spec.dataset_id!).mountRootId);
  const record = config.datasets.get(spec.dataset_id!)!;

  let probe: AppConfig;
  if (kind === "mount-not-found") {
    const missing = path.join(base, "no-such-mount");
    emit({ type: "log", message: `把挂载根指向不存在的目录：${missing}` });
    probe = cloneConfig(config, {
      mountRoots: new Map([[rootConfig.id, { ...rootConfig, resolvedRoot: missing }]]),
    });
  } else {
    // 造一个真实的越界：挂载根是 base/root，数据集相对路径写成 ../outside，且 outside 真实存在。
    const root = path.join(base, "root");
    const outside = path.join(base, "outside");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    emit({ type: "log", message: `挂载根 ${root}，数据集相对路径 ${record.relative_path} → ../outside` });
    probe = cloneConfig(config, {
      mountRoots: new Map([[rootConfig.id, { ...rootConfig, resolvedRoot: root }]]),
      datasets: new Map([[spec.dataset_id!, { ...record, relative_path: "../outside" }]]),
    });
  }

  let problemCode: string | null = null;
  try {
    const resolved = resolveDataset(probe, spec.dataset_id!);
    emit({ type: "log", message: `竟然解析成功：${resolved.resolvedPath} —— 这本身就是缺陷` });
  } catch (error) {
    if (error instanceof DatasetError) {
      problemCode = error.code;
      emit({ type: "log", message: `已按预期拒绝：${error.code} — ${error.message}` });
    } else {
      throw error;
    }
  }

  return { ...baseResult(), artifact_dir: base, problem_code: problemCode, duration_ms: Date.now() - started };
}

// --------------------------------------------------------------------------- //
// 模型用例
// --------------------------------------------------------------------------- //

async function runAgentCase(
  config: AppConfig,
  spec: CaseSpec,
  emit: Emit,
): Promise<Omit<CaseRunResult, "checks" | "passed">> {
  const started = Date.now();
  const { template } = fixturePaths(config, spec.dataset_id!);
  const task = createTask(config, {
    requestText: spec.request ?? "",
    datasetId: spec.dataset_id!,
    templatePath: template,
  });
  emit({ type: "log", message: `任务 ${task.task_id}（模板副本 + 计划 + 验证 + 输出都在 work/${task.task_id}/）` });

  const timer = setInterval(() => {
    try {
      const current = JSON.parse(fs.readFileSync(path.join(config.workDir, task.task_id, "task.json"), "utf8")) as TaskRecord;
      emit({ type: "status", phase: current.status });
    } catch {
      /* 任务文件还没写出，忽略 */
    }
  }, 1000);

  try {
    const outcome = await createPlanner(config).runTask(task.task_id, {
      autoExecute: spec.auto_execute ?? true,
      onEvent: (trace) => {
        if ((trace.phase ?? "start") === "end") emit({ type: "tool_end", name: trace.name, ok: trace.ok, at: trace.at });
        else emit({ type: "tool_start", name: trace.name, at: trace.at });
      },
      onText: (delta) => emit({ type: "text", delta }),
    });
    emit({ type: "status", phase: outcome.status });
    return {
      ...baseResult(),
      task_id: outcome.task_id,
      artifact_dir: path.dirname(task.template_path),
      status: outcome.status,
      validation: outcome.validation,
      plan: outcome.plan,
      outputs: outcome.outputs,
      output_files: outcome.output_files,
      tool_calls: outcome.tool_calls,
      reply: outcome.reply,
      duration_ms: Date.now() - started,
    };
  } finally {
    clearInterval(timer);
  }
}

// --------------------------------------------------------------------------- //
// 入口
// --------------------------------------------------------------------------- //

export async function runCase(config: AppConfig, spec: CaseSpec, emit: Emit = () => {}): Promise<CaseRunResult> {
  emit({ type: "log", message: `用例 ${spec.id}（${spec.kind === "agent" ? "模型" : "确定性"}）：${spec.title}` });

  let payload: Omit<CaseRunResult, "checks" | "passed">;
  switch (spec.kind) {
    case "agent":
      payload = await runAgentCase(config, spec, emit);
      break;
    case "deterministic":
      switch (spec.scenario) {
        case "validate-plan":
          payload = await runValidateAndExecute(config, spec, emit, { execute: false });
          break;
        case "validate-and-execute":
          payload = await runValidateAndExecute(config, spec, emit, { execute: true });
          break;
        case "mount-not-found":
        case "dataset-escape":
          payload = runMountFailure(config, spec, emit, spec.scenario);
          break;
        case "scale-execute":
          payload = await runScaleExecute(config, spec, emit);
          break;
        case "scale-parallel":
          payload = await runScaleParallel(config, spec, emit);
          break;
        case "scale-resume":
          payload = await runScaleResume(config, spec, emit);
          break;
        case "scale-inspect":
          payload = await runScaleInspect(config, spec, emit);
          break;
        default:
          throw new Error(`用例 ${spec.id} 的 scenario 非法: ${String(spec.scenario)}`);
      }
      break;
  }

  const checks = evaluateCase(spec, payload);
  for (const item of checks) emit({ type: "check", ...item });
  return { ...payload, checks, passed: checks.every((item) => item.ok) };
}

/** 命令行入口：`npm run cases [用例 id …]`。 */
export async function runCasesByIds(ids: string[], options: { quiet?: boolean } = {}): Promise<boolean> {
  const config = loadConfig();
  const specs = ids.length > 0 ? ids.map((id) => getCase(id, config)) : listCases(config);
  if (specs.length === 0) {
    console.error(`没有用例：${casesDir(config)} 是空的`);
    return false;
  }
  let failed = 0;
  for (const spec of specs) {
    console.log(`\n=== ${spec.id} — ${spec.title} ===`);
    const emit: Emit = options.quiet
      ? () => {}
      : (event) => {
          if (event.type === "log") console.log(`  · ${event.message}`);
          else if (event.type === "tool_start") console.log(`  → ${event.name}`);
          else if (event.type === "status") console.log(`  · 状态 ${event.phase}`);
          else if (event.type === "text") process.stdout.write(event.delta);
        };
    try {
      const result = await runCase(config, spec, emit);
      for (const item of result.checks) console.log(`  ${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
      console.log(`  ${result.passed ? "✅ 用例通过" : "❌ 用例失败"}（${result.duration_ms}ms）`);
      if (!result.passed) failed += 1;
    } catch (error) {
      failed += 1;
      console.log(`  ❌ 用例异常: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`\n合计 ${specs.length} 个用例，通过 ${specs.length - failed}，失败 ${failed}`);
  return failed === 0;
}
