/**
 * HTTP 访问层：所有 URL 都是 /api/... 相对路径，开发走 vite 代理、生产同源。
 * 支持由 .env 配置的访问鉴权 Token，并在请求中透明携带。
 */
import type {
  CasesResponse,
  DatasetsResponse,
  HealthResponse,
  OkResponse,
  RunCreatedResponse,
  RunView,
  RunsResponse,
  TemplateInfo,
  TemplateUploadResponse,
} from "./types";
import type { AppMode } from "./mode";

const AUTH_STORAGE_KEY = "report-agent-auth-token";

export function getAuthToken(): string | null {
  try {
    return localStorage.getItem(AUTH_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setAuthToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(AUTH_STORAGE_KEY, token);
    else localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export class ApiFailure extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(message: string, code = "REQUEST_FAILED", status: number | null = null) {
    super(message);
    this.name = "ApiFailure";
    this.code = code;
    this.status = status;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiFailure) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readErrorBody(body: unknown): { code: string; message: string } | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  const code = typeof body.error.code === "string" ? body.error.code : "REQUEST_FAILED";
  const message = typeof body.error.message === "string" ? body.error.message : "";
  if (!message) return null;
  return { code, message };
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const token = getAuthToken();
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(init?.body ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}`, "X-Auth-Token": token } : {}),
    ...(init?.headers as Record<string, string> | undefined ?? {}),
  };

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers,
      credentials: "same-origin",
    });
  } catch (cause) {
    throw new ApiFailure(
      `无法连接后端服务，请确认控制面已启动（${cause instanceof Error ? cause.message : String(cause)}）`,
      "NETWORK_ERROR",
    );
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const body = readErrorBody(parsed);
    throw new ApiFailure(
      body?.message ?? `请求失败：HTTP ${response.status} ${response.statusText}`.trim(),
      body?.code ?? `HTTP_${response.status}`,
      response.status,
    );
  }

  return parsed;
}

async function post(path: string, body: unknown): Promise<unknown> {
  return request(path, { method: "POST", body: JSON.stringify(body) });
}

export async function fetchHealth(): Promise<HealthResponse> {
  const body = await request("/api/health");
  if (!isRecord(body)) {
    throw new ApiFailure("健康检查接口返回异常", "BAD_RESPONSE");
  }
  return body as unknown as HealthResponse;
}

export async function login(token: string): Promise<OkResponse> {
  setAuthToken(token);
  try {
    const res = (await post("/api/auth/login", { token })) as OkResponse;
    return res;
  } catch (err) {
    setAuthToken(null);
    throw err;
  }
}

export async function logout(): Promise<void> {
  try {
    await post("/api/auth/logout", {});
  } finally {
    setAuthToken(null);
  }
}

export async function fetchDatasets(): Promise<DatasetsResponse> {
  const body = await request("/api/datasets");
  if (!isRecord(body) || !Array.isArray(body.datasets)) {
    throw new ApiFailure("数据集接口返回了预期之外的结构", "BAD_RESPONSE");
  }
  return body as unknown as DatasetsResponse;
}

export async function fetchCases(): Promise<CasesResponse> {
  const body = await request("/api/cases");
  if (!isRecord(body) || !Array.isArray(body.cases)) {
    throw new ApiFailure("用例接口返回了预期之外的结构", "BAD_RESPONSE");
  }
  return body as unknown as CasesResponse;
}

export async function fetchRuns(): Promise<RunsResponse> {
  const body = await request("/api/runs");
  if (!isRecord(body) || !Array.isArray(body.runs)) {
    throw new ApiFailure("历史对话接口返回了预期之外的结构", "BAD_RESPONSE");
  }
  return body as unknown as RunsResponse;
}

export async function fetchRun(runId: string): Promise<RunView> {
  const body = await request(`/api/runs/${encodeURIComponent(runId)}`);
  if (!isRecord(body) || typeof body.run_id !== "string") {
    throw new ApiFailure("获取会话详情返回了预期之外的结构", "BAD_RESPONSE");
  }
  return body as unknown as RunView;
}

export function createRun(body: {
  request: string;
  dataset_id: string | null;
  auto_execute: boolean;
  mode?: AppMode;
  tag?: string;
}): Promise<RunCreatedResponse> {
  return post("/api/runs", body) as Promise<RunCreatedResponse>;
}

export function updateRun(runId: string, body: { tag?: string; pinned?: boolean }): Promise<OkResponse> {
  return request(`/api/runs/${encodeURIComponent(runId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  }) as Promise<OkResponse>;
}

export function createCaseRun(caseId: string): Promise<RunCreatedResponse> {
  return post("/api/runs/case", { case_id: caseId }) as Promise<RunCreatedResponse>;
}

export function askRun(runId: string, message: string): Promise<OkResponse> {
  return post(`/api/runs/${encodeURIComponent(runId)}/ask`, { message }) as Promise<OkResponse>;
}

export function runStreamUrl(runId: string): string {
  const token = getAuthToken();
  const base = `/api/runs/${encodeURIComponent(runId)}/stream`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

/** 产物下载地址：路径里的 / 逐段编码，服务端会拒绝含 / 的文件名。 */
export function outputFileUrl(runId: string, file: string): string {
  const token = getAuthToken();
  const encoded = file
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("%2F");
  const base = `/api/runs/${encodeURIComponent(runId)}/outputs/${encoded}`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

/** SSE 的 done / snapshot 可能内联 RunView，也可能包在 run 字段里，两种都收。 */
export function extractRun(payload: Record<string, unknown>): RunView | null {
  if (isRecord(payload.run)) return payload.run as unknown as RunView;
  if (typeof payload.run_id === "string") return payload as unknown as RunView;
  return null;
}

export function templateDownloadUrl(mode: AppMode = "prod", datasetId?: string): string {
  const token = getAuthToken();
  const params = new URLSearchParams({ mode });
  if (datasetId) params.set("dataset_id", datasetId);
  if (token) params.set("token", token);
  return `/api/template?${params.toString()}`;
}

export async function fetchTemplateInfo(mode: AppMode = "prod", datasetId?: string): Promise<TemplateInfo> {
  const params = new URLSearchParams({ mode });
  if (datasetId) params.set("dataset_id", datasetId);
  const body = await request(`/api/template/info?${params.toString()}`);
  if (!isRecord(body)) {
    throw new ApiFailure("模板信息接口返回异常", "BAD_RESPONSE");
  }
  return body as unknown as TemplateInfo;
}

export async function uploadTemplate(file: File): Promise<TemplateUploadResponse> {
  const reader = new FileReader();
  const base64 = await new Promise<string>((resolve, reject) => {
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
  return post("/api/template", {
    filename: file.name,
    content_base64: base64,
  }) as Promise<TemplateUploadResponse>;
}

export async function resetTemplate(): Promise<OkResponse> {
  return request("/api/template", { method: "DELETE" }) as Promise<OkResponse>;
}
