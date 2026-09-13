import { useCallback, useEffect, useState } from "react";

import { fetchRuns, updateRun } from "../api";
import { phaseLabel, phaseTone } from "../labels";
import type { AppMode } from "../mode";
import type { RunSummary } from "../types";
import { IconPlus } from "./icons";

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

export function HistorySidebar({
  activeRunId,
  onSelect,
  onNew,
  collapsed,
  mode = "prod",
}: {
  activeRunId: string | null;
  onSelect: (runId: string) => void;
  onNew: () => void;
  collapsed?: boolean;
  mode?: AppMode;
}) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetchRuns();
      setRuns(response.runs);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const handleTogglePin = useCallback(
    async (runId: string, pinned: boolean) => {
      try {
        await updateRun(runId, { pinned });
        await load();
      } catch {
        /* ignore */
      }
    },
    [load],
  );

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (collapsed) {
    return null;
  }

  // 上线业务模式下隐藏测试用例运行，仅展示真实任务；开发模式下展示全部运行。
  const displayRuns = mode === "dev" ? runs : runs.filter((r) => !r.case_title);

  return (
    <aside className="history-sidebar" aria-label="历史任务">
      <div className="history-head">
        <div className="flex items-center gap-2 min-w-0">
          <span className="size-2 rounded-full bg-brand animate-pulse" aria-hidden="true" />
          <h2 className="history-title">历史记录</h2>
          <span className="rounded-full bg-muted/60 px-1.5 py-0.2 text-[10px] font-mono text-muted-foreground">
            {displayRuns.length}
          </span>
        </div>
        <button
          type="button"
          aria-label="新建回填任务"
          title="新建回填任务"
          onClick={onNew}
          className="group flex items-center gap-1 rounded-full border border-border/70 bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-all duration-200 hover:border-brand/40 hover:bg-muted active:scale-[0.97]"
        >
          <span className="grid size-4 place-items-center rounded-full bg-brand/10 text-brand group-hover:scale-110 transition-transform">
            <IconPlus width={11} height={11} />
          </span>
          <span className="hidden sm:inline text-[11px]">新建</span>
        </button>
      </div>

      <div className="history-list">
        {error ? (
          <p className="history-empty">
            历史记录暂不可用<br />
            <span>{error}</span>
          </p>
        ) : null}
        {!error && displayRuns.length === 0 ? (
          <p className="history-empty">
            暂无历史任务<br />
            <span>发起一次回填任务后将自动保存在此</span>
          </p>
        ) : null}
        {displayRuns.map((run) => {
          const isCase = Boolean(run.case_title);
          const active = activeRunId === run.run_id;
          return (
            <div
              key={run.run_id}
              className={`group relative flex items-center rounded-xl transition-all ${
                active
                  ? "bg-card border border-brand/40 shadow-xs ring-1 ring-brand/10"
                  : "hover:bg-muted/50 border border-transparent"
              }`}
            >
              <button
                type="button"
                className="flex flex-1 items-start gap-2.5 p-2.5 text-left min-w-0 cursor-pointer"
                onClick={() => onSelect(run.run_id)}
              >
                <span className={`history-dot history-dot-${phaseTone(run.phase)}`} aria-hidden="true" />
                <span className="history-item-body">
                  <span className="history-item-title flex items-center gap-1.5">
                    {run.pinned ? <span className="text-amber-500 text-xs shrink-0" title="已标记会话">★</span> : null}
                    <span className="truncate">{run.request || run.case_title || run.run_id}</span>
                  </span>
                  <span className="history-item-meta flex flex-wrap items-center gap-1.5">
                    <span>{formatDate(run.started_at)}</span>
                    <span>·</span>
                    <span className="truncate">{phaseLabel(run.phase)}</span>
                    {run.tag ? (
                      <span className="rounded bg-brand/10 text-brand px-1.5 py-0.2 text-[10px] font-medium shrink-0 max-w-28 truncate">
                        {run.tag}
                      </span>
                    ) : null}
                    {isCase ? (
                      <span className="text-[10px] rounded bg-muted px-1 font-mono shrink-0">CASE</span>
                    ) : null}
                  </span>
                </span>
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleTogglePin(run.run_id, !run.pinned);
                }}
                className={`mr-2 flex size-6 shrink-0 items-center justify-center rounded-md transition-all cursor-pointer ${
                  run.pinned
                    ? "text-amber-500 hover:text-amber-600"
                    : "text-muted-foreground/30 hover:text-amber-500 opacity-0 group-hover:opacity-100"
                }`}
                title={run.pinned ? "取消会话标记" : "为会话添加标记"}
                aria-label={run.pinned ? "取消会话标记" : "为会话添加标记"}
              >
                <span className="text-xs">{run.pinned ? "★" : "☆"}</span>
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
