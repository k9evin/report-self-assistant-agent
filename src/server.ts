/**
 * 控制面 HTTP 服务（契约见 docs/api.md）。
 *
 *   npm run serve                 # 默认 127.0.0.1:8787，端口被占自动往后找
 *   REPORT_PORT=9000 npm run serve
 *
 * 只依赖 node:http —— 没有框架，就没有额外的攻击面与升级负担。
 * 同一个端口既提供 API，也把前端构建产物（web/dist）当静态站点托管，业务用户只需要一个网址。
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { loadConfig, type AppConfig } from "./config.ts";
import { getCase, listCases, runCase, type CaseSpec, type RunEvent } from "./cases.ts";
import { createTask, loadTask, readEvents, type TaskRecord } from "./tasks.ts";
import { createPlanner } from "./planner.ts";
import { DatasetError, resolveDataset } from "./storage.ts";

const VERSION = "1.0";
const HEARTBEAT_MS = 15_000;

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

interface RunState {
  run_id: string;
  kind: "free" | "case";
  case_id: string | null;
  state: "running" | "done" | "error";
  task_id: string | null;
  /** 计划 / 验证 / outputs/ 所在目录；模型用例是任务目录，确定性用例是临时草稿目录。 */
  artifact_dir: string | null;
  dataset_id: string;
  request: string;
  auto_execute: boolean;
  phase: string;
  tool_calls: { name: string; ok: boolean; at: string }[];
  reply: string;
  plan: unknown;
  validation: unknown;
  outputs: TaskRecord["outputs"] | null;
  output_files: string[];
  checks: Check[] | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

const runs = new Map<string, RunState>();
const subscribers = new Map<string, Set<(event: RunEvent | { type: "done"; run: RunState } | { type: "error"; message: string } | { type: "snapshot"; run: RunState }) => void>>();

function emit(runId: string, event: RunEvent | { type: "done"; run: RunState } | { type: "error"; message: string }) {
  for (const listener of subscribers.get(runId) ?? []) listener(event);
}

function publicRun(run: RunState): RunState {
  return { ...run };
}

// --------------------------------------------------------------------------- //
// 环境准备
// --------------------------------------------------------------------------- //

function config(): AppConfig {
  return loadConfig();
}

/** 演示夹具是这套案例的前提：不存在就现造一份（真数据上跑时不触发）。 */
function ensureFixture(config: AppConfig): string | null {
  const dev = config.mountRoots.get("dev");
  if (!dev) return null;
  const template = path.join(dev.resolvedRoot, "template.xlsx");
  if (!fs.existsSync(template)) {
    console.log(`[serve] 演示夹具不存在，正在生成：${dev.resolvedRoot}`);
    execFileSync(process.env.REPORT_PYTHON ?? "python3", [path.join(config.projectRoot, "tests", "make_fixture.py"), dev.resolvedRoot], {
      stdio: "inherit",
    });
  }
  return fs.existsSync(template) ? template : null;
}

// --------------------------------------------------------------------------- //
// HTTP 小工具
// --------------------------------------------------------------------------- //

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res: http.ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 2 * 1024 * 1024) throw new Error("请求体过大");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function datasetViews(config: AppConfig) {
  return [...config.datasets.values()].map((record) => {
    const root = config.mountRoots.get(record.mount_root_id);
    try {
      const resolved = resolveDataset(config, record.dataset_id);
      const snCount = fs.readdirSync(resolved.resolvedPath, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
      let writable = true;
      try {
        fs.accessSync(resolved.resolvedPath, fs.constants.W_OK);
      } catch {
        writable = false;
      }
      return {
        dataset_id: record.dataset_id,
        name: record.name,
        access: record.access,
        mount_root_id: record.mount_root_id,
        mount_root: root?.resolvedRoot ?? null,
        resolved_path: resolved.resolvedPath,
        available: true,
        problem: null,
        sn_count: snCount,
        writable_by_process: writable,
      };
    } catch (error) {
      const code = error instanceof DatasetError ? error.code : "DATASET_RESOLVE_FAILED";
      return {
        dataset_id: record.dataset_id,
        name: record.name,
        access: record.access,
        mount_root_id: record.mount_root_id,
        mount_root: root?.resolvedRoot ?? null,
        resolved_path: null,
        available: false,
        problem: { code, message: error instanceof Error ? error.message : String(error) },
        sn_count: null,
        writable_by_process: null,
      };
    }
  });
}

// --------------------------------------------------------------------------- //
// 运行
// --------------------------------------------------------------------------- //

let runSeq = 0;

function newRunState(kind: "free" | "case", datasetId: string, request: string, autoExecute: boolean, caseId: string | null): RunState {
  runSeq += 1;
  const run: RunState = {
    run_id: `run-${Date.now().toString(36)}-${runSeq.toString(36)}`,
    kind,
    case_id: caseId,
    state: "running",
    task_id: null,
    artifact_dir: null,
    dataset_id: datasetId,
    request,
    auto_execute: autoExecute,
    phase: "CREATED",
    tool_calls: [],
    reply: "",
    plan: null,
    validation: null,
    outputs: null,
    output_files: [],
    checks: null,
    error: null,
    started_at: new Date().toISOString(),
    finished_at: null,
    duration_ms: null,
  };
  runs.set(run.run_id, run);
  subscribers.set(run.run_id, new Set());
  return run;
}

/** 把内部的 RunEvent 转成 RunState 上的可见状态，并广播给所有订阅者。 */
function makeSink(run: RunState) {
  return (event: RunEvent) => {
    switch (event.type) {
      case "status":
        run.phase = event.phase;
        break;
      case "tool_start":
        run.tool_calls.push({ name: event.name, ok: true, at: event.at });
        break;
      case "tool_end": {
        const last = [...run.tool_calls].reverse().find((call) => call.name === event.name);
        if (last) last.ok = event.ok;
        break;
      }
      case "text":
        run.reply += event.delta;
        break;
      case "check":
        run.checks = [...(run.checks ?? []), { name: event.name, ok: event.ok, detail: event.detail }];
        break;
      case "log":
        break;
    }
    emit(run.run_id, event);
  };
}

function finish(run: RunState, error: unknown = null): void {
  run.state = error ? "error" : "done";
  run.error = error ? (error instanceof Error ? error.message : String(error)) : null;
  run.finished_at = new Date().toISOString();
  run.duration_ms = Date.parse(run.finished_at) - Date.parse(run.started_at);
  if (error) emit(run.run_id, { type: "error", message: run.error! });
  emit(run.run_id, { type: "done", run: publicRun(run) });
}

function startCaseRun(config: AppConfig, spec: CaseSpec): RunState {
  const run = newRunState("case", spec.dataset_id ?? "", spec.request ?? spec.title, spec.auto_execute ?? true, spec.id);
  void (async () => {
    try {
      const result = await runCase(config, spec, makeSink(run));
      run.task_id = result.task_id;
      run.artifact_dir = result.artifact_dir;
      run.phase = result.status ?? run.phase;
      run.plan = result.plan;
      run.validation = result.validation;
      run.outputs = result.outputs;
      run.output_files = result.output_files;
      run.reply = result.reply || run.reply;
      run.checks = result.checks;
      finish(run);
    } catch (error) {
      finish(run, error);
    }
  })();
  return run;
}

function startFreeRun(config: AppConfig, datasetId: string, request: string, autoExecute: boolean): RunState {
  const run = newRunState("free", datasetId, request, autoExecute, null);
  void (async () => {
    let timer: NodeJS.Timeout | null = null;
    try {
      const dataset = resolveDataset(config, datasetId);
      const template = path.join(config.mountRoots.get(dataset.mountRootId)!.resolvedRoot, "template.xlsx");
      const uploaded = process.env.REPORT_TEMPLATE_DIR ? path.join(process.env.REPORT_TEMPLATE_DIR, "template.xlsx") : null;
      const task = createTask(config, {
        requestText: request,
        datasetId,
        templatePath: uploaded && fs.existsSync(uploaded) ? uploaded : template,
      });
      run.task_id = task.task_id;
      run.artifact_dir = path.dirname(task.template_path);
      const sink = makeSink(run);
      sink({ type: "log", message: `任务 ${task.task_id}` });

      timer = setInterval(() => {
        try {
          const current = loadTask(config, task.task_id);
          if (current.status !== run.phase) sink({ type: "status", phase: current.status });
        } catch {
          /* 忽略 */
        }
      }, 1000);

      const outcome = await createPlanner(config).runTask(task.task_id, {
        autoExecute,
        onEvent: (trace) => {
          const phase = trace.phase ?? "start";
          sink({ type: phase === "end" ? "tool_end" : "tool_start", name: trace.name, ok: trace.ok, at: trace.at });
        },
        onText: (delta) => sink({ type: "text", delta }),
      });
      run.phase = outcome.status;
      run.plan = outcome.plan;
      run.validation = outcome.validation;
      run.outputs = outcome.outputs;
      run.output_files = outcome.output_files;
      run.reply = outcome.reply;
      finish(run);
    } catch (error) {
      finish(run, error);
    } finally {
      if (timer) clearInterval(timer);
    }
  })();
  return run;
}

function startAsk(config: AppConfig, run: RunState, message: string): void {
  const taskId = run.task_id;
  if (!taskId) throw new Error("任务尚未创建，无法追问");
  run.state = "running";
  run.error = null;
  run.finished_at = null;
  run.duration_ms = null;
  void (async () => {
    let timer: NodeJS.Timeout | null = null;
    try {
      const sink = makeSink(run);
      sink({ type: "text", delta: "\n\n---\n\n" });
      timer = setInterval(() => {
        try {
          const current = loadTask(config, taskId);
          if (current.status !== run.phase) sink({ type: "status", phase: current.status });
        } catch {
          /* 忽略 */
        }
      }, 1000);
      const outcome = await createPlanner(config).ask(taskId, message, {
        onEvent: (trace) => {
          const phase = trace.phase ?? "start";
          sink({ type: phase === "end" ? "tool_end" : "tool_start", name: trace.name, ok: trace.ok, at: trace.at });
        },
        onText: (delta) => sink({ type: "text", delta }),
      });
      run.phase = outcome.status;
      run.plan = outcome.plan ?? run.plan;
      run.validation = outcome.validation ?? run.validation;
      run.outputs = outcome.outputs ?? run.outputs;
      run.output_files = outcome.output_files;
      finish(run);
    } catch (error) {
      finish(run, error);
    } finally {
      if (timer) clearInterval(timer);
    }
  })();
}

// --------------------------------------------------------------------------- //
// 静态资源
// --------------------------------------------------------------------------- //

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function serveStatic(config: AppConfig, res: http.ServerResponse, urlPath: string): boolean {
  const dist = path.join(config.projectRoot, "web", "dist");
  if (!fs.existsSync(dist)) return false;
  const relative = urlPath.replace(/^\/+/, "");
  let file = path.resolve(dist, relative);
  if (!file.startsWith(dist)) return false;
  if (!relative || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, "index.html");
  if (!fs.existsSync(file)) return false;
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
  return true;
}

/** 把用例里的 plan 从 cases/*.json 反查出来（前端展示期望用）。 */
function caseForRun(run: RunState, config: AppConfig): CaseSpec | null {
  if (!run.case_id) return null;
  try {
    return getCase(run.case_id, config);
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- //
// 路由
// --------------------------------------------------------------------------- //

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const config = loadConfig();
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const method = req.method ?? "GET";

  if (parts[0] === "api") {
    // GET /api/health
    if (method === "GET" && parts[1] === "health" && parts.length === 2) {
      return sendJson(res, 200, {
        ok: true,
        version: VERSION,
        provider: config.provider,
        model_id: config.modelId,
        python: config.pythonBin,
        work_dir: config.workDir,
        has_credentials: Boolean(process.env.DEEPSEEK_API_KEY || process.env.REPORT_LLM_API_KEY),
      });
    }

    // GET /api/datasets
    if (method === "GET" && parts[1] === "datasets" && parts.length === 2) {
      return sendJson(res, 200, { datasets: datasetViews(config) });
    }

    // GET /api/cases
    if (method === "GET" && parts[1] === "cases" && parts.length === 2) {
      return sendJson(res, 200, { cases: listCases(config) });
    }

    // GET /api/template
    if (method === "GET" && parts[1] === "template" && parts.length === 2) {
      const dev = config.mountRoots.get("dev");
      const file = dev ? path.join(dev.resolvedRoot, "template.xlsx") : null;
      if (!file || !fs.existsSync(file)) return sendError(res, 404, "TEMPLATE_NOT_FOUND", "演示模板不存在");
      res.writeHead(200, {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="template.xlsx"`,
      });
      return void fs.createReadStream(file).pipe(res);
    }

    // POST /api/runs
    if (method === "POST" && parts[1] === "runs" && parts.length === 2) {
      const body = await readJsonBody(req);
      const request = String(body.request ?? "").trim();
      const datasetId = String(body.dataset_id ?? "");
      if (!request) return sendError(res, 400, "REQUEST_REQUIRED", "需求不能为空");
      if (!config.datasets.has(datasetId)) {
        return sendError(res, 400, "DATASET_UNKNOWN", `未知 dataset_id: ${datasetId}`);
      }
      const run = startFreeRun(config, datasetId, request, body.auto_execute !== false);
      return sendJson(res, 202, { run_id: run.run_id });
    }

    // POST /api/runs/case
    if (method === "POST" && parts[1] === "runs" && parts[2] === "case") {
      const body = await readJsonBody(req);
      const caseId = String(body.case_id ?? "");
      let spec: CaseSpec;
      try {
        spec = getCase(caseId, config);
      } catch (error) {
        return sendError(res, 404, "CASE_NOT_FOUND", error instanceof Error ? error.message : String(error));
      }
      const run = startCaseRun(config, spec);
      return sendJson(res, 202, { run_id: run.run_id, case_id: spec.id });
    }

    // /api/runs/:id...
    if (parts[1] === "runs" && parts[2]) {
      const run = runs.get(parts[2]);
      if (!run) return sendError(res, 404, "RUN_NOT_FOUND", `未知 run_id: ${parts[2]}`);

      if (method === "GET" && parts.length === 3) {
        const spec = caseForRun(run, config);
        return sendJson(res, 200, { ...publicRun(run), case_title: spec?.title ?? null, expects: spec?.expect ?? null });
      }

      // GET /api/runs/:id/stream
      if (method === "GET" && parts[3] === "stream" && parts.length === 4) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        const write = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
        write({ type: "snapshot", run: publicRun(run) });
        if (run.state !== "running") {
          write({ type: "done", run: publicRun(run) });
        }
        const listener = (event: unknown) => write(event);
        subscribers.get(run.run_id)!.add(listener as never);
        const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), HEARTBEAT_MS);
        req.on("close", () => {
          clearInterval(heartbeat);
          subscribers.get(run.run_id)?.delete(listener as never);
        });
        return;
      }

      // POST /api/runs/:id/ask
      if (method === "POST" && parts[3] === "ask" && parts.length === 4) {
        const body = await readJsonBody(req);
        const message = String(body.message ?? "").trim();
        if (!message) return sendError(res, 400, "MESSAGE_REQUIRED", "追问内容不能为空");
        if (run.state === "running") return sendError(res, 409, "RUN_BUSY", "这一轮还没跑完");
        try {
          startAsk(config, run, message);
        } catch (error) {
          return sendError(res, 409, "ASK_FAILED", error instanceof Error ? error.message : String(error));
        }
        return sendJson(res, 202, { ok: true });
      }

      // GET /api/runs/:id/events
      if (method === "GET" && parts[3] === "events" && parts.length === 4) {
        if (!run.task_id) return sendJson(res, 200, { events: [] });
        return sendJson(res, 200, { events: readEvents(config, run.task_id) });
      }

      // GET /api/runs/:id/artifact?name=plan.json
      if (method === "GET" && parts[3] === "artifact" && parts.length === 4) {
        const name = url.searchParams.get("name") ?? "";
        if (!/^[a-z0-9._-]+\.json$/i.test(name)) return sendError(res, 400, "BAD_ARTIFACT", "非法的产物名");
        if (!run.artifact_dir) return sendError(res, 404, "NO_TASK", "任务尚未创建");
        const file = path.join(run.artifact_dir, name);
        if (!fs.existsSync(file)) return sendError(res, 404, "ARTIFACT_NOT_FOUND", `${name} 还不存在`);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        return void fs.createReadStream(file).pipe(res);
      }

      // GET /api/runs/:id/outputs/:file
      if (method === "GET" && parts[3] === "outputs" && parts[4]) {
        if (!run.artifact_dir) return sendError(res, 404, "NO_TASK", "任务尚未创建");
        const file = decodeURIComponent(parts[4]);
        if (file.includes("/") || file.includes("\\") || file.startsWith(".")) {
          return sendError(res, 400, "BAD_FILENAME", "非法的文件名");
        }
        const full = path.join(run.artifact_dir, "outputs", file);
        if (!fs.existsSync(full)) return sendError(res, 404, "OUTPUT_NOT_FOUND", `产物不存在: ${file}`);
        const type = file.endsWith(".json") ? "application/json; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        res.writeHead(200, { "content-type": type, "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file)}` });
        return void fs.createReadStream(full).pipe(res);
      }
    }

    return sendError(res, 404, "NOT_FOUND", `${method} ${url.pathname} 不存在`);
  }

  if (method === "GET" && (parts.length === 0 || parts[0] !== "api")) {
    if (serveStatic(config, res, url.pathname)) return;
  }
  sendError(res, 404, "NOT_FOUND", "资源不存在");
}

// --------------------------------------------------------------------------- //
// 启动
// --------------------------------------------------------------------------- //

/** 端口被占就往后找，绝不抢占别人的端口（也不杀别人的进程）。 */
async function listenOnFreePort(server: http.Server, host: string, preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 20; port += 1) {
    const ok = await new Promise<boolean>((resolve) => {
      const onError = () => {
        server.off("listening", onListening);
        resolve(false);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(true);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
    if (ok) return port;
  }
  throw new Error(`端口 ${preferred}–${preferred + 19} 都被占用`);
}

const bootConfig = config();
if (!fs.existsSync(bootConfig.workDir)) fs.mkdirSync(bootConfig.workDir, { recursive: true });
const fixture = ensureFixture(bootConfig);

const server = http.createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    console.error("[serve] 未捕获的请求错误:", error);
    if (!res.headersSent) sendError(res, 500, "INTERNAL", error instanceof Error ? error.message : String(error));
    else res.end();
  });
});

const preferredPort = Number(process.env.REPORT_PORT ?? 8787);
const host = process.env.REPORT_HOST ?? "127.0.0.1";
const port = await listenOnFreePort(server, host, preferredPort);

const dist = path.join(bootConfig.projectRoot, "web", "dist");
console.log(`[serve] 自动化测试报告智能助理`);
console.log(`[serve] 模型：${bootConfig.provider}/${bootConfig.modelId}    工作目录：${bootConfig.workDir}`);
console.log(`[serve] 演示夹具：${fixture ?? "(未配置 dev 挂载根)"}`);
console.log(`[serve] 前端：${fs.existsSync(dist) ? dist : `未构建（在 web/ 里跑 npm install && npm run build）`}`);
console.log(`[serve] 打开：http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/`);
