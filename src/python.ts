/**
 * 与确定性层（tools/report_tools.py）的唯一通道。
 * Agent 侧没有 shell：所有确定性动作都必须经过这些包装函数，参数由后端构造。
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import type { AppConfig } from "./config.ts";

const execFileAsync = promisify(execFile);

export interface ToolRunResult {
  /** 进程是否以 0 退出。注意：Dry-Run "rejected" 也是 1，属于正常业务结果。 */
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ToolRunOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  /** 给了就按行回调 stderr（批量执行的进度走这里），此时改用 spawn 以便实时读取。 */
  onStderr?: (line: string) => void;
}

/**
 * 批量执行上万行时一跑就是几分钟到几十分钟，调用方（Agent / 控制面）必须能看见进度，
 * 所以给了 onStderr 就换成 spawn 流式读取；否则走 execFile，路径更短、开销更小。
 */
async function runToolStreaming(
  config: AppConfig,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  onStderr: (line: string) => void,
): Promise<ToolRunResult> {
  return new Promise<ToolRunResult>((resolve) => {
    const child = spawn(config.pythonBin, [config.toolsScript, ...args], { env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    let buffered = "";
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      buffered += text;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onStderr(line.trim());
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: -1, stdout, stderr: `${error.message}\n${stderr}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buffered.trim()) onStderr(buffered.trim());
      if (timedOut) {
        resolve({
          ok: false,
          exitCode: -1,
          stdout,
          stderr: `${stderr}\nEXECUTE_TIMEOUT: 超过 ${Math.round(timeoutMs / 1000)}s 未结束，已终止（可用 REPORT_EXECUTE_TIMEOUT_MS 调大，或改用 resume 续跑）`,
        });
        return;
      }
      const exitCode = code ?? -1;
      resolve({ ok: exitCode === 0, exitCode, stdout, stderr });
    });
  });
}

export async function runTool(
  config: AppConfig,
  args: string[],
  opts: ToolRunOptions = {},
): Promise<ToolRunResult> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const env = { ...process.env, ...opts.env, PYTHONDONTWRITEBYTECODE: "1" };
  if (opts.onStderr) return runToolStreaming(config, args, timeoutMs, env, opts.onStderr);
  try {
    const { stdout, stderr } = await execFileAsync(config.pythonBin, [config.toolsScript, ...args], {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env,
    });
    return { ok: true, exitCode: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: unknown; message?: string; stdout?: string; stderr?: string };
    if (typeof err.code === "string") {
      // spawn 层失败（python 不存在、超时等）：code 是错误码字符串而非退出码
      return { ok: false, exitCode: -1, stdout: err.stdout ?? "", stderr: `${err.code}: ${err.message ?? ""}` };
    }
    const exitCode = typeof err.code === "number" ? err.code : 1;
    return { ok: exitCode === 0, exitCode, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

export function parseToolJson<T = unknown>(run: ToolRunResult): T | null {
  const text = run.stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
