/**
 * 一次运行（run）的实时状态：POST 拿到 run_id 后立刻订阅 /api/runs/:id/stream，
 * 按事件增量累积状态；结束后可追问并重新订阅，继续追加。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  askRun,
  createCaseRun,
  createRun,
  errorMessage,
  extractRun,
  fetchRun,
  runStreamUrl,
} from "./api";
import type { AppMode } from "./mode";
import type { ResponseLanguage } from "./language";
import type { Check, RunError, RunView, ToolCall } from "./types";

/** 一轮对话：首次运行是需求，之后每次追问各算一轮。 */
export interface Turn {
  /** 用户输入的原文。 */
  prompt: string;
  /** 该轮开始时 reply / tools 的长度：把服务端的累积流切成每轮一段。 */
  replyBase: number;
  toolsBase: number;
  /** 首轮携带的运行上下文。 */
  datasetId: string | null;
  autoExecute: boolean;
  at: string;
}

/** 渲染用的一轮：把累积的 reply / tools 切成这一轮自己的片段。 */
export interface TurnView extends Turn {
  reply: string;
  tools: ToolCall[];
  /** 最后一轮为 true：只有它显示实时状态与光标。 */
  live: boolean;
}

export interface RunStreamState {
  runId: string | null;
  phase: string | null;
  tools: ToolCall[];
  reply: string;
  checks: Check[];
  run: RunView | null;
  error: string | null;
  /** 任务进行中（POST 在途或流未结束）——期间按钮 disabled。 */
  busy: boolean;
  finished: boolean;
  started: boolean;
  turns: Turn[];
  /** 实时连接暂时中断并正在尝试自动重连修复 */
  reconnecting?: boolean;
}

const INITIAL: RunStreamState = {
  runId: null,
  phase: null,
  tools: [],
  reply: "",
  checks: [],
  run: null,
  error: null,
  busy: false,
  finished: false,
  started: false,
  turns: [],
  reconnecting: false,
};

/** 服务端在每次追问的开头插入的分段线；前端按轮展示时剥掉。 */
const TURN_SEPARATOR = /^\s*-{3,}\s*/;

/** 把累积的 reply / tools 切成每一轮的片段，供对话流渲染。 */
export function turnViews(state: RunStreamState): TurnView[] {
  return state.turns.map((turn, index) => {
    const next = state.turns[index + 1];
    const rawReply = next ? state.reply.slice(turn.replyBase, next.replyBase) : state.reply.slice(turn.replyBase);
    return {
      ...turn,
      reply: rawReply.replace(TURN_SEPARATOR, "").replace(/^\n+/, ""),
      tools: state.tools.slice(turn.toolsBase, next ? next.toolsBase : undefined),
      live: index === state.turns.length - 1,
    };
  });
}

/** 工具调用：同一次调用以 name 匹配最近的未结束条目；at 保留开始时刻。 */
function mergeToolEnd(tools: ToolCall[], name: string, ok: boolean | undefined, at?: string): ToolCall[] {
  const next = [...tools];
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const entry = next[i];
    if (entry && entry.name === name && entry.ok === undefined) {
      next[i] = { ...entry, ok, at: entry.at ?? at };
      return next;
    }
  }
  return [...next, { name, ok, at }];
}

function mergeToolCalls(tools: ToolCall[], incoming: ToolCall[]): ToolCall[] {
  const next = [...tools];
  for (const call of incoming) {
    const seen = next.some((entry) => entry.name === call.name && entry.at === call.at);
    if (!seen) next.push(call);
  }
  return next;
}

function mergeChecks(checks: Check[], incoming: Check[]): Check[] {
  const next = [...checks];
  for (const check of incoming) {
    const index = next.findIndex((entry) => entry.name === check.name);
    if (index >= 0) next[index] = check;
    else next.push(check);
  }
  return next;
}

function formatRunError(err: string | RunError | null | undefined): string | null {
  if (!err) return null;
  if (typeof err === "string") return err;
  return err.message || err.code || JSON.stringify(err);
}

function applySnapshot(state: RunStreamState, run: RunView): RunStreamState {
  const incomingTools = run.tool_calls ?? [];
  const incomingChecks = run.checks ?? [];
  const turns = state.turns.length > 0 || !run.request
    ? state.turns
    : [{ prompt: run.request, replyBase: 0, toolsBase: 0, datasetId: run.dataset_id ?? null, autoExecute: true, at: run.started_at ?? new Date().toISOString() }];
  return {
    ...state,
    turns,
    run,
    phase: run.phase ?? state.phase,
    error: formatRunError(run.error) ?? state.error,
    // 快照里是服务端累积的权威列表：不比本地少就整体替换，否则只补齐本地缺的条目。
    tools:
      incomingTools.length >= state.tools.length
        ? incomingTools
        : mergeToolCalls(state.tools, incomingTools),
    checks: state.checks.length === 0 ? incomingChecks : mergeChecks(state.checks, incomingChecks),
    // 快照里的 reply 是服务端累积全文；本地已有流式内容时保留本地，避免回退。
    reply: state.reply.length === 0 ? run.reply ?? "" : state.reply,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface RunStreamApi {
  state: RunStreamState;
  startRun: (input: {
    request: string;
    dataset_id?: string | null;
    mount_root_id?: string;
    relative_path?: string;
    auto_execute: boolean;
    mode?: AppMode;
    tag?: string;
    response_language?: ResponseLanguage;
  }) => Promise<string | null>;
  startCase: (caseId: string) => Promise<string | null>;
  ask: (message: string, responseLanguage?: ResponseLanguage) => Promise<void>;
  loadRun: (runId: string) => void;
  reconnect: () => void;
  reset: () => void;
}

export function useRunStream(): RunStreamApi {
  const [state, setState] = useState<RunStreamState>(INITIAL);
  const sourceRef = useRef<EventSource | null>(null);
  const aliveRef = useRef(true);
  const activeRunIdRef = useRef<string | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const isFinishedRef = useRef(false);

  const clearReconnectTimers = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const closeStream = useCallback(() => {
    clearReconnectTimers();
    sourceRef.current?.close();
    sourceRef.current = null;
  }, [clearReconnectTimers]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      closeStream();
    };
  }, [closeStream]);

  const update = useCallback((updater: (previous: RunStreamState) => RunStreamState) => {
    if (!aliveRef.current) return;
    setState(updater);
  }, []);

  const openStream = useCallback(
    (runId: string, isReconnect = false) => {
      clearReconnectTimers();
      sourceRef.current?.close();
      activeRunIdRef.current = runId;

      if (!isReconnect) {
        reconnectAttemptsRef.current = 0;
        isFinishedRef.current = false;
      }

      let source: EventSource;
      try {
        source = new EventSource(runStreamUrl(runId));
      } catch (cause) {
        update((previous) => ({
          ...previous,
          busy: false,
          reconnecting: false,
          error: `无法建立实时连接（${errorMessage(cause)}）`,
        }));
        return;
      }
      sourceRef.current = source;

      source.onopen = () => {
        if (sourceRef.current !== source) return;
        reconnectAttemptsRef.current = 0;
        clearReconnectTimers();
        update((previous) => (previous.reconnecting ? { ...previous, reconnecting: false } : previous));
      };

      const handlePayload = (payload: unknown) => {
        if (sourceRef.current !== source || !isRecord(payload)) return;
        reconnectAttemptsRef.current = 0;
        clearReconnectTimers();

        const type = typeof payload.type === "string" ? payload.type : "";

        if (type === "snapshot") {
          const run = extractRun(payload);
          if (run) {
            if (run.state !== "running") {
              isFinishedRef.current = true;
            }
            update((previous) => ({ ...applySnapshot(previous, run), reconnecting: false }));
          }
          return;
        }
        if (type === "status") {
          const phase = typeof payload.phase === "string" ? payload.phase : null;
          if (phase) update((previous) => ({ ...previous, phase, reconnecting: false }));
          return;
        }
        if (type === "tool_start" || type === "tool_end") {
          const name = typeof payload.name === "string" ? payload.name : "";
          if (!name) return;
          const at = typeof payload.at === "string" ? payload.at : undefined;
          if (type === "tool_start") {
            update((previous) => ({
              ...previous,
              tools: mergeToolEnd(previous.tools, name, undefined, at),
              reconnecting: false,
            }));
          } else {
            const ok = typeof payload.ok === "boolean" ? payload.ok : undefined;
            update((previous) => ({
              ...previous,
              tools: mergeToolEnd(previous.tools, name, ok, at),
              reconnecting: false,
            }));
          }
          return;
        }
        if (type === "text") {
          const delta = typeof payload.delta === "string" ? payload.delta : "";
          if (!delta) return;
          update((previous) => ({ ...previous, reply: previous.reply + delta, reconnecting: false }));
          return;
        }
        if (type === "check") {
          const name = typeof payload.name === "string" ? payload.name : "";
          if (!name) return;
          const check: Check = {
            name,
            ok: payload.ok === true,
            detail: typeof payload.detail === "string" ? payload.detail : null,
          };
          update((previous) => ({
            ...previous,
            checks: mergeChecks(previous.checks, [check]),
            reconnecting: false,
          }));
          return;
        }
        if (type === "done") {
          const run = extractRun(payload);
          isFinishedRef.current = true;
          update((previous) => {
            const merged = run ? applySnapshot(previous, run) : previous;
            const reply = merged.reply.length > 0 ? merged.reply : run?.reply ?? "";
            return {
              ...merged,
              reply,
              phase: run?.phase ?? merged.phase,
              busy: false,
              finished: true,
              reconnecting: false,
              error: formatRunError(run?.error) ?? merged.error,
            };
          });
          closeStream();
          return;
        }
        if (type === "error") {
          isFinishedRef.current = true;
          const message = typeof payload.message === "string" ? payload.message : "后端报告了未知错误";
          update((previous) => ({ ...previous, error: message, busy: false, finished: true, reconnecting: false }));
          closeStream();
        }
      };

      const onMessage = (event: MessageEvent<string>) => {
        if (typeof event.data !== "string" || !event.data.trim()) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          return;
        }
        handlePayload(parsed);
      };

      // 服务端可能用 data-only（走 onmessage）或命名事件（走 addEventListener），两条都接。
      source.onmessage = onMessage;
      for (const type of ["snapshot", "status", "tool_start", "tool_end", "text", "check", "done", "error"]) {
        source.addEventListener(type, onMessage as unknown as EventListener);
      }

      // 断链与自愈修复处理
      source.onerror = () => {
        if (sourceRef.current !== source) return;

        // 若任务已完成，流关闭属于正常收尾
        if (isFinishedRef.current) {
          closeStream();
          return;
        }

        reconnectAttemptsRef.current += 1;
        const attempts = reconnectAttemptsRef.current;

        // 主动通过 GET /api/runs/:id 检查任务真实状态（双通道主动自愈）
        const attemptRepair = async () => {
          if (!aliveRef.current || activeRunIdRef.current !== runId) return;

          try {
            const run = await fetchRun(runId);
            if (!aliveRef.current || activeRunIdRef.current !== runId) return;

            // 服务端已经完成，拉取最终快照并正常收尾
            if (run.state !== "running") {
              isFinishedRef.current = true;
              update((previous) => {
                const merged = applySnapshot(previous, run);
                return {
                  ...merged,
                  reply: merged.reply.length > 0 ? merged.reply : run.reply ?? "",
                  phase: run.phase ?? merged.phase,
                  busy: false,
                  finished: true,
                  reconnecting: false,
                };
              });
              closeStream();
              return;
            }

            // 服务端仍在运行，先同步最新快照
            update((previous) => applySnapshot(previous, run));
          } catch {
            /* 忽略瞬时离线错误 */
          }

          if (!aliveRef.current || activeRunIdRef.current !== runId) return;

          // 若在重试上限内（最多重试 8 次，指数退避），执行自动重连修复
          if (attempts <= 8) {
            update((previous) => ({ ...previous, reconnecting: true }));

            // 如果浏览器原生 EventSource 处于 CONNECTING（0）状态，前 3 次优先等待浏览器原生重连
            if (source.readyState === 0 && attempts <= 3) {
              return;
            }

            const delay = Math.min(1000 * Math.pow(1.4, attempts - 1), 5000);
            clearReconnectTimers();
            reconnectTimerRef.current = window.setTimeout(() => {
              if (!aliveRef.current || activeRunIdRef.current !== runId) return;
              openStream(runId, true);
            }, delay);
          } else {
            // 超过最大重试次数，安全挂起，提示用户可手动重试
            closeStream();
            update((previous) => ({
              ...previous,
              busy: false,
              reconnecting: false,
              error: previous.error ?? "与后端的实时连接已中断，可点击「重试」重新连接",
            }));
          }
        };

        void attemptRepair();
      };
    },
    [clearReconnectTimers, closeStream, update],
  );

  const start = useCallback(
    async (
      create: () => Promise<{ run_id: string }>,
      turn: { prompt: string; datasetId: string | null; autoExecute: boolean },
    ): Promise<string | null> => {
      closeStream();
      setState({
        ...INITIAL,
        busy: true,
        started: true,
        turns: [{ ...turn, replyBase: 0, toolsBase: 0, at: new Date().toISOString() }],
      });
      let runId: string;
      try {
        const created = await create();
        runId = created.run_id;
        if (typeof runId !== "string" || !runId) throw new Error("后端没有返回 run_id");
      } catch (cause) {
        update((previous) => ({ ...previous, busy: false, error: errorMessage(cause) }));
        return null;
      }
      update((previous) => ({ ...previous, runId }));
      openStream(runId);
      return runId;
    },
    [closeStream, openStream, update],
  );

  const startRun = useCallback(
    (input: {
      request: string;
      dataset_id?: string | null;
      mount_root_id?: string;
      relative_path?: string;
      auto_execute: boolean;
      mode?: AppMode;
      tag?: string;
      response_language?: ResponseLanguage;
    }) =>
      start(() => createRun(input), {
        prompt: input.request,
        datasetId: input.dataset_id ?? (input.mount_root_id && input.relative_path ? `dir:${input.mount_root_id}:${input.relative_path}` : null),
        autoExecute: input.auto_execute,
      }),
    [start],
  );

  const startCase = useCallback(
    (caseId: string) =>
      start(() => createCaseRun(caseId), { prompt: caseId, datasetId: null, autoExecute: true }),
    [start],
  );

  const ask = useCallback(
    async (message: string, responseLanguage?: ResponseLanguage) => {
      const runId = state.runId;
      if (!runId) return;
      closeStream();
      // 新一轮对话：记下起点，之后服务端追加的 reply / tools 都归这一轮。
      update((previous) => ({
        ...previous,
        busy: true,
        finished: false,
        error: null,
        turns: [
          ...previous.turns,
          {
            prompt: message,
            replyBase: previous.reply.length,
            toolsBase: previous.tools.length,
            datasetId: previous.turns[0]?.datasetId ?? null,
            autoExecute: previous.turns[0]?.autoExecute ?? true,
            at: new Date().toISOString(),
          },
        ],
      }));
      try {
        await askRun(runId, message, responseLanguage);
      } catch (cause) {
        update((previous) => ({ ...previous, busy: false, finished: true, error: errorMessage(cause) }));
        return;
      }
      openStream(runId);
    },
    [closeStream, openStream, state.runId, update],
  );

  const loadRun = useCallback(
    (runId: string) => {
      closeStream();
      setState({ ...INITIAL, runId, started: true, busy: true, turns: [] });
      openStream(runId);
    },
    [closeStream, openStream],
  );

  const reconnect = useCallback(() => {
    const targetId = state.runId || activeRunIdRef.current;
    if (!targetId) return;
    isFinishedRef.current = false;
    reconnectAttemptsRef.current = 0;
    update((previous) => ({ ...previous, error: null, reconnecting: true, busy: true }));
    openStream(targetId, true);
  }, [openStream, state.runId, update]);

  const reset = useCallback(() => {
    closeStream();
    setState(INITIAL);
  }, [closeStream]);

  return { state, startRun, startCase, ask, loadRun, reconnect, reset };
}
