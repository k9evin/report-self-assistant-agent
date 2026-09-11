/**
 * 任务存储（PRD §17 的 MVP 子集）：一个任务一个目录，计划 / 验证 / 输出 / 审计事件都落在这里。
 * 契约与平台无关：FastAPI 控制面可以按同样字段落库。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { AppConfig } from "./config.ts";

export type TaskStatus =
  | "CREATED"
  | "INSPECTING"
  | "PLANNING"
  | "VALIDATING"
  | "NEEDS_REPLAN"
  | "BLOCKED"
  | "READY"
  | "RUNNING"
  | "COMPLETED"
  | "COMPLETED_WITH_WARNINGS"
  | "FAILED";

export interface TaskRecord {
  task_id: string;
  request_text: string;
  dataset_id: string;
  template_path: string;
  template_sha256: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  plan_sha256?: string;
  validation_summary?: {
    status: string;
    execution_allowed: boolean;
    gates: Record<string, string>;
    warning_count: number;
    error_count: number;
  };
  outputs?: {
    directory: string;
    total: number;
    completed: number;
    completed_with_warnings: number;
    failed: number;
  };
  notes?: string[];
}

export function taskDir(config: AppConfig, taskId: string): string {
  return path.join(config.workDir, taskId);
}

export function taskFile(config: AppConfig, taskId: string): string {
  return path.join(taskDir(config, taskId), "task.json");
}

export function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function newTaskId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  return `task-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

export function loadTask(config: AppConfig, taskId: string): TaskRecord {
  const file = taskFile(config, taskId);
  if (!fs.existsSync(file)) throw new Error(`任务不存在: ${taskId}`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as TaskRecord;
}

export function saveTask(config: AppConfig, task: TaskRecord): void {
  task.updated_at = new Date().toISOString();
  fs.writeFileSync(taskFile(config, task.task_id), JSON.stringify(task, null, 2) + "\n", "utf8");
}

export function updateTaskStatus(config: AppConfig, taskId: string, status: TaskStatus, note?: string): TaskRecord {
  const task = loadTask(config, taskId);
  task.status = status;
  if (note) task.notes = [...(task.notes ?? []), note];
  saveTask(config, task);
  return task;
}

/** 模板以只读副本进入任务目录：源上传文件不再被触碰，hash 用于执行前一致性校验。 */
export function stageTemplate(config: AppConfig, taskId: string, templatePath: string): string {
  const source = path.resolve(templatePath);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error(`模板文件不存在: ${source}`);
  }
  const target = path.join(taskDir(config, taskId), "template.xlsx");
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o444);
  return target;
}

export function createTask(
  config: AppConfig,
  input: { requestText: string; datasetId: string; templatePath: string },
): TaskRecord {
  const taskId = newTaskId();
  fs.mkdirSync(taskDir(config, taskId), { recursive: true });
  const templatePath = stageTemplate(config, taskId, input.templatePath);
  const now = new Date().toISOString();
  const task: TaskRecord = {
    task_id: taskId,
    request_text: input.requestText,
    dataset_id: input.datasetId,
    template_path: templatePath,
    template_sha256: sha256File(templatePath),
    status: "CREATED",
    created_at: now,
    updated_at: now,
  };
  saveTask(config, task);
  appendEvent(config, taskId, { type: "task.created", dataset_id: input.datasetId });
  return task;
}

export interface TaskEvent {
  type: string;
  at?: string;
  [key: string]: unknown;
}

/** 追加式审计日志（PRD §22 可审计）：每一步工具调用与状态迁移都留痕。 */
export function appendEvent(config: AppConfig, taskId: string, event: TaskEvent): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n";
  fs.appendFileSync(path.join(taskDir(config, taskId), "events.jsonl"), line, "utf8");
}

export function readEvents(config: AppConfig, taskId: string): TaskEvent[] {
  const file = path.join(taskDir(config, taskId), "events.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TaskEvent);
}
