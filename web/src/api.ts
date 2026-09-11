/**
 * HTTP 访问层：所有 URL 都是 /api/... 相对路径，开发走 vite 代理、生产同源。
 * 非 2xx 统一解析 { error: { code, message } }，把 message 原样交给 UI（不静默失败）。
 */
import type {
  CasesResponse,
  DatasetsResponse,
  OkResponse,
  RunCreatedResponse,
  RunView,
} from "./types";

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
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
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

export function createRun(body: {
  request: string;
  dataset_id: string | null;
  auto_execute: boolean;
}): Promise<RunCreatedResponse> {
  return post("/api/runs", body) as Promise<RunCreatedResponse>;
}

export function createCaseRun(caseId: string): Promise<RunCreatedResponse> {
  return post("/api/runs/case", { case_id: caseId }) as Promise<RunCreatedResponse>;
}

export function askRun(runId: string, message: string): Promise<OkResponse> {
  return post(`/api/runs/${encodeURIComponent(runId)}/ask`, { message }) as Promise<OkResponse>;
}

export function runStreamUrl(runId: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/stream`;
}

/** 产物下载地址：路径里的 / 逐段编码，服务端会拒绝含 / 的文件名。 */
export function outputFileUrl(runId: string, file: string): string {
  const encoded = file
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("%2F");
  return `/api/runs/${encodeURIComponent(runId)}/outputs/${encoded}`;
}

/** SSE 的 done / snapshot 可能内联 RunView，也可能包在 run 字段里，两种都收。 */
export function extractRun(payload: Record<string, unknown>): RunView | null {
  if (isRecord(payload.run)) return payload.run as unknown as RunView;
  if (typeof payload.run_id === "string") return payload as unknown as RunView;
  return null;
}
