/**
 * 控制面 API 契约（v1）的类型镜像，字段与 docs/api.md 一一对应。
 * 所有对外部 JSON 的读取都走这里的可选字段 + 运行时守卫，后端多给字段不会炸。
 */

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  provider: string;
  model_id: string;
  work_dir: string;
  has_credentials: boolean;
  dev_mode_allowed?: boolean;
  auth_required?: boolean;
  authenticated?: boolean;
}

export interface DatasetProblem {
  code: string;
  message: string;
}

export interface Dataset {
  dataset_id: string;
  name: string;
  access?: string | null;
  mount_root_id?: string | null;
  mount_root?: string | null;
  relative_path?: string | null;
  resolved_path?: string | null;
  available: boolean;
  problem?: DatasetProblem | null;
  sn_count?: number | null;
  writable_by_process?: boolean | null;
}

export interface DatasetsResponse {
  datasets: Dataset[];
}

export interface DirectoryEntry { name: string; relative_path: string; }
export interface MountRoot { mount_root_id: string; available: boolean; directories: DirectoryEntry[]; problem?: string; }
export interface MountRootsResponse { mount_roots: MountRoot[]; }

export interface CaseExpect {
  status?: string[];
  execution_allowed?: boolean;
  gates?: "all_pass" | "not_all_pass" | string;
  error_codes?: string[];
  output_xlsx?: number | null;
  tool_calls?: string[];
}

export type CaseKind = "agent" | "deterministic" | string;

export interface TestCase {
  id: string;
  title: string;
  description?: string;
  kind: CaseKind;
  dataset_id?: string;
  auto_execute?: boolean;
  request?: string;
  expect?: CaseExpect;
}

export interface CasesResponse {
  cases: TestCase[];
}

export type GateValue = "pass" | "fail" | "not_executed";

export interface ValidationIssue {
  code?: string;
  message?: string;
  count?: number;
}

export interface ValidationView {
  gates?: Record<string, GateValue>;
  errors?: ValidationIssue[];
  warnings?: ValidationIssue[];
  status?: string;
  execution_allowed?: boolean;
  [key: string]: unknown;
}

export interface ToolCall {
  name: string;
  ok?: boolean;
  at?: string;
}

export interface RunOutputs {
  directory?: string | null;
  total?: number;
  completed?: number;
  completed_with_warnings?: number;
  failed?: number;
}

export interface RunSummary {
  run_id: string;
  request: string;
  case_title?: string | null;
  phase?: string;
  started_at: string;
  tag?: string | null;
  pinned?: boolean;
}

export interface RunsResponse {
  runs: RunSummary[];
}

export interface Check {
  name: string;
  ok: boolean;
  detail?: string | null;
}

export interface RunError {
  code?: string;
  message?: string;
}

export interface RunView {
  run_id: string;
  kind?: string;
  case_id?: string | null;
  state?: "running" | "done" | "error" | string;
  task_id?: string;
  dataset_id?: string;
  mount_root_id?: string;
  relative_path?: string;
  request?: string;
  phase?: string;
  tool_calls?: ToolCall[] | null;
  reply?: string | null;
  plan?: unknown;
  validation?: ValidationView | null;
  outputs?: RunOutputs | null;
  output_files?: string[] | null;
  checks?: Check[] | null;
  error?: RunError | string | null;
  started_at?: string;
  finished_at?: string | null;
  duration_ms?: number | null;
  tag?: string | null;
  pinned?: boolean;
}

/** SSE 载荷：契约里的 type 联合。快照/结束同时兼容内联 RunView 的写法。 */
export interface SnapshotEvent {
  type: "snapshot";
  run?: RunView;
}

export interface StatusEvent {
  type: "status";
  phase: string;
}

export interface ToolEvent {
  type: "tool_start" | "tool_end";
  name: string;
  ok?: boolean;
  at?: string;
}

export interface TextEvent {
  type: "text";
  delta: string;
}

export interface CheckEvent {
  type: "check";
  name: string;
  ok: boolean;
  detail?: string;
}

export interface DoneEvent {
  type: "done";
  run?: RunView;
}

export interface StreamErrorEvent {
  type: "error";
  message: string;
}

export type StreamEvent =
  | SnapshotEvent
  | StatusEvent
  | ToolEvent
  | TextEvent
  | CheckEvent
  | DoneEvent
  | StreamErrorEvent;

export interface RunCreatedResponse {
  run_id: string;
  tag?: string;
}

export interface OkResponse {
  ok: boolean;
  message?: string;
}

export interface TemplateInfo {
  has_template: boolean;
  is_custom: boolean;
  filename: string | null;
  size: number;
  updated_at: string | null;
}

export interface TemplateUploadResponse {
  ok: boolean;
  message?: string;
  filename: string;
  size: number;
}
