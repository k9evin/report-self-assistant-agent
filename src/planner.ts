/**
 * Planner（智能核）：PRD §26.2 的 PlannerService 契约 + pi 运行时实现。
 *
 * 运行时约束（安全边界）：
 *  - `noTools: "builtin"`：模型没有 bash / read / write / edit；
 *  - 只有 createReportTools() 注册的注册工具可用；
 *  - 系统提示 = persona.md + .agents/skills/*（内联，因为禁用了 read 工具，无法按需读取技能文件）。
 * 无人值守：pi 没有审批环节，`session.prompt()` 一次调用跑到任务结束。
 */
import fs from "node:fs";
import path from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { loadConfig, type AppConfig } from "./config.ts";
import { validateResolvedPlanShape, type ResolvedPlan, type ValidatedPlan } from "./schemas.ts";
import { appendEvent, loadTask, saveTask, type TaskRecord, type TaskStatus } from "./tasks.ts";
import { createReportTools } from "./tools.ts";

export interface ToolCallTrace {
  name: string;
  ok: boolean;
  at: string;
  /** "start" 表示工具开始执行，"end" 表示结束；省略时按 "start" 处理（兼容早期调用方）。 */
  phase?: "start" | "end";
  detail?: string;
}

export interface TaskOutcome {
  task_id: string;
  status: TaskStatus;
  plan_sha256: string | null;
  plan: ResolvedPlan | null;
  validation: ValidatedPlan | null;
  outputs: TaskRecord["outputs"] | null;
  output_files: string[];
  reply: string;
  tool_calls: ToolCallTrace[];
  duration_ms: number;
}

export interface PlanResult {
  plan_sha256: string;
  plan: ResolvedPlan;
}

/**
 * PRD §26.2 的 Planner 契约。完整版由 PiPlanner 实现；换运行时只需换实现类。
 */
export interface PlannerService {
  buildIntentPlan(taskId: string): Promise<Record<string, unknown>>;
  buildResolvedPlan(taskId: string): Promise<PlanResult>;
  replanFromErrors(taskId: string, errors: unknown[]): Promise<PlanResult>;
  runTask(
    taskId: string,
    options?: {
      autoExecute?: boolean;
      responseLanguage?: "auto" | "zh" | "en";
      onEvent?: (event: ToolCallTrace) => void;
      onText?: (delta: string) => void;
    },
  ): Promise<TaskOutcome>;
  ask(
    taskId: string,
    message: string,
    options?: {
      responseLanguage?: "auto" | "zh" | "en";
      onEvent?: (event: ToolCallTrace) => void;
      onText?: (delta: string) => void;
    },
  ): Promise<TaskOutcome>;
}

interface PiEvent {
  type?: string;
  assistantMessageEvent?: { type?: string; delta?: string };
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  error?: string;
  message?: unknown;
}

function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  return end === -1 ? text : text.slice(end + 4).trimStart();
}

/** 系统提示 = 角色 + 内联技能 + 工具清单（PRD §12）。 */
export function buildSystemPrompt(config: AppConfig): string {
  const parts: string[] = [fs.readFileSync(config.personaPath, "utf8").trim()];

  const skillDirs = fs.existsSync(config.skillsDir)
    ? fs.readdirSync(config.skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory())
    : [];
  for (const dir of skillDirs.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(config.skillsDir, dir.name, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    parts.push(`# 技能：${dir.name}\n\n${stripFrontmatter(fs.readFileSync(file, "utf8")).trim()}`);
  }

  parts.push(
    [
      "# 你的工具（只有这些，没有 shell、没有文件读写）",
      "",
      "- `inspect_template()` — 分析本任务模板结构。",
      "- `inspect_xml_schema({pattern?, sample_count?})` — 探测数据集里代表性 SN 的 XML 结构。",
      "- `submit_resolved_plan({plan})` — 提交 ResolvedPlan，落盘并返回 plan_sha256。",
      "- `validate_report_plan()` — 对已提交计划做 Dry-Run，返回五道 Gate 与结构化错误。",
      "- `execute_validated_plan({plan_sha256})` — 执行已验证计划（一 SN 一文件 + validation_report.json）。",
      "- `get_task_status()` — 读取任务状态、验证摘要与产物位置。",
      "",
      "计划、验证结果与输出都由工具落盘；你不需要（也无法）自己写文件。",
    ].join("\n"),
  );

  return parts.join("\n\n");
}

function resolveSkillsDocumented(config: AppConfig): string[] {
  if (!fs.existsSync(config.skillsDir)) return [];
  return fs
    .readdirSync(config.skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(config.skillsDir, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

async function createModelRuntime(config: AppConfig): Promise<ModelRuntime> {
  const options: { modelsPath?: string; authPath?: string } = {};
  if (fs.existsSync(config.modelsPath)) options.modelsPath = config.modelsPath;
  if (fs.existsSync(config.authPath)) options.authPath = config.authPath;
  return ModelRuntime.create(options);
}

export function buildTaskPrompt(task: TaskRecord, options: { autoExecute: boolean; responseLanguage?: "auto" | "zh" | "en" }): string {
  const languageInstruction = (() => {
    if (options.responseLanguage === "zh") return "语言要求：请全程使用中文回答与汇报。";
    if (options.responseLanguage === "en") return "Language requirement: Please reply and report entirely in English.";
    return "语言要求：请根据用户输入所使用的语言进行回答与汇报（用户使用中文则用中文，用户使用英文则用英文）。";
  })();

  const lines = [
    `任务 ${task.task_id}`,
    "",
    "用户需求（原话）：",
    "```text",
    task.request_text.trim(),
    "```",
    "",
    `数据集 dataset_id：${task.dataset_id}（只读挂载，用 inspect_xml_schema 探测）`,
    "模板：已就绪，inspect_template 无需参数。",
    "",
    "按技能流程执行：",
    "1. 探测模板与 XML 结构；",
    "2. 依据证据写出 ResolvedPlan 并用 submit_resolved_plan 提交；",
    "3. 用 validate_report_plan 做 Dry-Run；被拒时按结构化错误修正后重新提交并重验（同类错误最多修正 2 次，之后停下来问用户）；",
    options.autoExecute
      ? "4. 验证通过（execution_allowed=true）后调用 execute_validated_plan 执行；"
      : "4. 本轮不要执行，验证通过即可停止；",
    options.autoExecute
      ? "5. 用 get_task_status 取回统计，最后向用户汇报：计划摘要、五道 Gate 与警告/阻断、执行结果（成功/带警告/失败数量）。"
      : "5. 向用户汇报：计划摘要、五道 Gate 与警告/阻断、需要用户拍板的事项。",
    "",
    languageInstruction,
    "",
    "如果出现需求与模板矛盾、一对多、多个候选证据相似、目标列覆盖公式等情况，不要猜：停下来把冲突和两个可选方案讲清楚，交给用户决定。",
  ];
  return lines.join("\n");
}

export class PiPlanner implements PlannerService {
  constructor(private readonly config: AppConfig = loadConfig()) {}

  private async openSession(task: TaskRecord) {
    const workspaceDir = path.dirname(task.template_path);
    const runtime = await createModelRuntime(this.config);
    const model = runtime.getModel(this.config.provider, this.config.modelId);
    if (!model) {
      throw new Error(
        `模型不可用: (${this.config.provider}, ${this.config.modelId}) — 检查 .pi/agent/models.json 与 REPORT_LLM_* 环境变量`,
      );
    }

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 3 },
    });
    const systemPrompt = buildSystemPrompt(this.config);
    const loader = new DefaultResourceLoader({
      cwd: workspaceDir,
      agentDir: this.config.agentDir,
      settingsManager,
      systemPromptOverride: () => systemPrompt,
      // 技能已内联进系统提示（运行时没有 read 工具），这里不再做磁盘发现，保证行为确定。
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
    });
    await loader.reload();

    const customTools = createReportTools({
      config: this.config,
      taskId: task.task_id,
      workspaceDir,
    });

    const created = await createAgentSession({
      cwd: workspaceDir,
      agentDir: this.config.agentDir,
      model,
      modelRuntime: runtime,
      thinkingLevel: this.config.thinkingLevel as never,
      noTools: "builtin",
      customTools,
      resourceLoader: loader,
      sessionManager: SessionManager.create(workspaceDir),
      settingsManager,
    });
    return { session: created.session, workspaceDir };
  }

  private async runTurn(
    task: TaskRecord,
    prompt: string,
    onEvent?: (event: ToolCallTrace) => void,
    onText?: (delta: string) => void,
  ): Promise<{ reply: string; toolCalls: ToolCallTrace[] }> {
    const { session } = await this.openSession(task);
    const toolCalls: ToolCallTrace[] = [];
    let reply = "";

    const unsubscribe = session.subscribe((raw) => {
      const event = raw as unknown as PiEvent;
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        const delta = event.assistantMessageEvent.delta ?? "";
        reply += delta;
        if (delta) onText?.(delta);
        return;
      }
      if (event.type === "tool_execution_start" && event.toolName) {
        const trace: ToolCallTrace = { name: event.toolName, ok: true, at: new Date().toISOString(), phase: "start" };
        toolCalls.push(trace);
        appendEvent(this.config, task.task_id, { type: "agent.tool_start", tool: event.toolName });
        onEvent?.(trace);
        return;
      }
      if (event.type === "tool_execution_end" && event.toolName) {
        const ok = event.isError !== true;
        const last = [...toolCalls].reverse().find((call) => call.name === event.toolName);
        if (last) last.ok = ok;
        appendEvent(this.config, task.task_id, { type: "agent.tool_end", tool: event.toolName, ok });
        onEvent?.({ name: event.toolName, ok, at: new Date().toISOString(), phase: "end" });
      }
    });

    try {
      await session.prompt(prompt);
    } finally {
      unsubscribe?.();
      const disposable = session as unknown as { dispose?: () => void };
      disposable.dispose?.();
    }
    return { reply: reply.trim(), toolCalls };
  }

  private readArtifacts(taskId: string) {
    const task = loadTask(this.config, taskId);
    const workspaceDir = path.dirname(task.template_path);
    const readJson = <T>(file: string): T | null => {
      const full = path.join(workspaceDir, file);
      if (!fs.existsSync(full)) return null;
      try {
        return JSON.parse(fs.readFileSync(full, "utf8")) as T;
      } catch {
        return null;
      }
    };
    const outputsDir = path.join(workspaceDir, "outputs");
    return {
      task,
      plan: readJson<ResolvedPlan>("plan.json"),
      validation: readJson<ValidatedPlan>("validation.json"),
      outputFiles: fs.existsSync(outputsDir) ? fs.readdirSync(outputsDir).sort() : [],
    };
  }

  private async outcome(taskId: string, reply: string, toolCalls: ToolCallTrace[], started: number): Promise<TaskOutcome> {
    const { task, plan, validation, outputFiles } = this.readArtifacts(taskId);
    const status: TaskStatus = task.status;
    return {
      task_id: taskId,
      status,
      plan_sha256: task.plan_sha256 ?? null,
      plan,
      validation,
      outputs: task.outputs ?? null,
      output_files: outputFiles,
      reply,
      tool_calls: toolCalls,
      duration_ms: Date.now() - started,
    };
  }

  /** 无人值守跑完整任务：探测 → 计划 → Dry-Run →（可选）执行 → 汇报。 */
  async runTask(
    taskId: string,
    options: { autoExecute?: boolean; responseLanguage?: "auto" | "zh" | "en"; onEvent?: (event: ToolCallTrace) => void; onText?: (delta: string) => void } = {},
  ): Promise<TaskOutcome> {
    const started = Date.now();
    const task = loadTask(this.config, taskId);
    const autoExecute = options.autoExecute ?? true;
    appendEvent(this.config, taskId, {
      type: "agent.started",
      provider: this.config.provider,
      model_id: this.config.modelId,
      thinking_level: this.config.thinkingLevel,
      builtin_tools: "disabled",
      skills: resolveSkillsDocumented(this.config),
      auto_execute: autoExecute,
    });
    const { reply, toolCalls } = await this.runTurn(
      task,
      buildTaskPrompt(task, { autoExecute, responseLanguage: options.responseLanguage }),
      options.onEvent,
      options.onText,
    );
    const result = await this.outcome(taskId, reply, toolCalls, started);
    appendEvent(this.config, taskId, { type: "agent.finished", status: result.status, duration_ms: result.duration_ms });
    return result;
  }

  /** 追问/追问式修正：同一任务目录、同一份产物，新开一轮会话。 */
  async ask(
    taskId: string,
    message: string,
    options: { responseLanguage?: "auto" | "zh" | "en"; onEvent?: (event: ToolCallTrace) => void; onText?: (delta: string) => void } = {},
  ): Promise<TaskOutcome> {
    const started = Date.now();
    const task = loadTask(this.config, taskId);
    appendEvent(this.config, taskId, { type: "agent.ask", message });
    const prompt = (() => {
      if (options.responseLanguage === "zh") return `${message}\n\n（请全程使用中文回答与汇报）`;
      if (options.responseLanguage === "en") return `${message}\n\n(Please reply and report entirely in English)`;
      if (options.responseLanguage === "auto") return `${message}\n\n（请根据用户输入语言回答与汇报：用户使用中文则用中文，用户使用英文则用英文）`;
      return message;
    })();
    const { reply, toolCalls } = await this.runTurn(task, prompt, options.onEvent, options.onText);
    return this.outcome(taskId, reply, toolCalls, started);
  }

  async buildIntentPlan(taskId: string): Promise<Record<string, unknown>> {
    const task = loadTask(this.config, taskId);
    const { reply } = await this.runTurn(
      task,
      [
        "只做需求理解，不要探测、不要提交计划。",
        "把下面的需求复述成 IntentPlan（输出粒度 output.mode/filename_pattern、source_file_intent、template_intent、field_intents），",
        "用 JSON 直接回答，缺失的槽位用 null 标出。",
        "",
        "需求：",
        task.request_text,
      ].join("\n"),
    );
    const match = reply.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("未能得到 IntentPlan JSON");
    return JSON.parse(match[0]) as Record<string, unknown>;
  }

  async buildResolvedPlan(taskId: string): Promise<PlanResult> {
    const task = loadTask(this.config, taskId);
    await this.runTurn(
      task,
      [
        "根据当前任务的探测结果与需求，写出 ResolvedPlan 并调用 submit_resolved_plan 提交。",
        "提交后用 validate_report_plan 验证；未通过则按结构化错误修正后重新提交并重验，通过即停止。",
        "最后用中文汇报计划摘要与验证结果。",
      ].join("\n"),
    );
    const { task: updated, plan } = this.readArtifacts(taskId);
    if (!plan || !updated.plan_sha256) throw new Error("未能得到 ResolvedPlan");
    const problems = validateResolvedPlanShape(plan);
    if (problems.length > 0) throw new Error(`ResolvedPlan 非法: ${problems.join("; ")}`);
    return { plan_sha256: updated.plan_sha256, plan };
  }

  async replanFromErrors(taskId: string, errors: unknown[]): Promise<PlanResult> {
    const task = loadTask(this.config, taskId);
    await this.runTurn(
      task,
      [
        "上一轮 Dry-Run 被拒，以下是结构化的验证错误与修复候选：",
        "```json",
        JSON.stringify(errors, null, 2),
        "```",
        "请修正 ResolvedPlan 并重新提交、重验。不要改变需求的语义，也不要引入模糊匹配。",
      ].join("\n"),
    );
    const { task: updated, plan } = this.readArtifacts(taskId);
    if (!plan || !updated.plan_sha256) throw new Error("重规划失败");
    return { plan_sha256: updated.plan_sha256, plan };
  }
}

function findGoldenPlan(config: AppConfig, datasetId: string): ResolvedPlan | null {
  const casesPath = path.join(config.projectRoot, "cases");
  if (!fs.existsSync(casesPath)) return null;
  const files = fs.readdirSync(casesPath).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    try {
      const spec = JSON.parse(fs.readFileSync(path.join(casesPath, f), "utf8")) as {
        kind?: string;
        dataset_id?: string;
        plan?: ResolvedPlan;
        expect?: { execution_allowed?: boolean };
      };
      if (spec.kind === "deterministic" && spec.dataset_id === datasetId && spec.plan && spec.expect?.execution_allowed === true) {
        return spec.plan;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export class MockPlanner implements PlannerService {
  constructor(private readonly config: AppConfig = loadConfig()) {}

  private readArtifacts(taskId: string) {
    const task = loadTask(this.config, taskId);
    const workspaceDir = path.dirname(task.template_path);
    const readJson = <T>(file: string): T | null => {
      const full = path.join(workspaceDir, file);
      if (!fs.existsSync(full)) return null;
      try {
        return JSON.parse(fs.readFileSync(full, "utf8")) as T;
      } catch {
        return null;
      }
    };
    const outputsDir = path.join(workspaceDir, "outputs");
    return {
      task,
      plan: readJson<ResolvedPlan>("plan.json"),
      validation: readJson<ValidatedPlan>("validation.json"),
      outputFiles: fs.existsSync(outputsDir) ? fs.readdirSync(outputsDir).sort() : [],
    };
  }

  async runTask(
    taskId: string,
    options: { autoExecute?: boolean; onEvent?: (event: ToolCallTrace) => void; onText?: (delta: string) => void } = {},
  ): Promise<TaskOutcome> {
    const started = Date.now();
    const task = loadTask(this.config, taskId);
    const autoExecute = options.autoExecute ?? true;
    const workspaceDir = path.dirname(task.template_path);
    const toolDefs = createReportTools({ config: this.config, taskId, workspaceDir });
    const tools = new Map(toolDefs.map((t) => [t.name, t]));
    const toolCalls: ToolCallTrace[] = [];

    const callTool = async (name: string, params: Record<string, unknown> = {}) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`未知工具: ${name}`);
      const startTrace: ToolCallTrace = { name, ok: true, at: new Date().toISOString(), phase: "start" };
      toolCalls.push(startTrace);
      options.onEvent?.(startTrace);
      appendEvent(this.config, taskId, { type: "agent.tool_start", tool: name });

      let ok = true;
      try {
        const result = await (tool.execute as Function)(name + "-call", params);
        if ((result as any)?.details?.error) ok = false;
        return result;
      } catch (err) {
        ok = false;
        throw err;
      } finally {
        startTrace.ok = ok;
        appendEvent(this.config, taskId, { type: "agent.tool_end", tool: name, ok });
        options.onEvent?.({ name, ok, at: new Date().toISOString(), phase: "end" });
      }
    };

    await callTool("inspect_template", {});
    await callTool("inspect_xml_schema", {});

    const plan = findGoldenPlan(this.config, task.dataset_id);
    if (!plan) throw new Error(`MockPlanner 未能找到数据集 ${task.dataset_id} 的 Golden Plan`);
    await callTool("submit_resolved_plan", { plan });
    await callTool("validate_report_plan", {});

    if (autoExecute) {
      const curTask = loadTask(this.config, taskId);
      if (curTask.plan_sha256) {
        await callTool("execute_validated_plan", { plan_sha256: curTask.plan_sha256 });
      }
      await callTool("get_task_status", {});
    }

    const reply = autoExecute
      ? `已完成 ${task.dataset_id} 的数据源与模板探测，自动生成规划并通过 Dry-Run 校验，成功完成数据回填。`
      : `已完成 ${task.dataset_id} 的数据源与模板探测，自动生成规划并通过 Dry-Run 校验（未执行回填）。`;
    options.onText?.(reply);

    const { task: finalTask, plan: finalPlan, validation, outputFiles } = this.readArtifacts(taskId);
    return {
      task_id: taskId,
      status: finalTask.status,
      plan_sha256: finalTask.plan_sha256 ?? null,
      plan: finalPlan,
      validation,
      outputs: finalTask.outputs ?? null,
      output_files: outputFiles,
      reply,
      tool_calls: toolCalls,
      duration_ms: Date.now() - started,
    };
  }

  async ask(
    taskId: string,
    message: string,
    options: { onEvent?: (event: ToolCallTrace) => void; onText?: (delta: string) => void } = {},
  ): Promise<TaskOutcome> {
    const started = Date.now();
    const task = loadTask(this.config, taskId);
    appendEvent(this.config, taskId, { type: "agent.ask", message });
    const reply = `收到追问：“${message}”。MockPlanner 已确认当前状态就绪。`;
    options.onText?.(reply);
    const { task: finalTask, plan: finalPlan, validation, outputFiles } = this.readArtifacts(taskId);
    return {
      task_id: taskId,
      status: finalTask.status,
      plan_sha256: finalTask.plan_sha256 ?? null,
      plan: finalPlan,
      validation,
      outputs: finalTask.outputs ?? null,
      output_files: outputFiles,
      reply,
      tool_calls: [],
      duration_ms: Date.now() - started,
    };
  }

  async buildIntentPlan(taskId: string): Promise<Record<string, unknown>> {
    return { mode: "mock", taskId };
  }

  async buildResolvedPlan(taskId: string): Promise<PlanResult> {
    const task = loadTask(this.config, taskId);
    const plan = findGoldenPlan(this.config, task.dataset_id);
    if (!plan) throw new Error("未能得到 ResolvedPlan");
    return { plan_sha256: "mock-sha256", plan };
  }

  async replanFromErrors(taskId: string): Promise<PlanResult> {
    return this.buildResolvedPlan(taskId);
  }
}

export function createPlanner(config?: AppConfig): PlannerService {
  const cfg = config ?? loadConfig();
  if (cfg.provider === "mock" || process.env.REPORT_PLANNER === "mock") {
    return new MockPlanner(cfg);
  }
  return new PiPlanner(cfg);
}
