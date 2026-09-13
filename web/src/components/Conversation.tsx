/** 对话流：用户输入气泡 + 助理回合（执行流水线 → 工具调用 → 流式业务汇报）。 */
import type { ReactNode } from "react";
import { useState } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "cn";

import { phaseLabel, phaseTone } from "../labels";
import type { TurnView } from "../useRunStream";
import { PhaseBar } from "./PhaseBar";
import { ReportPanel } from "./ReportPanel";
import { ToneBadge } from "./ToneBadge";
import { ToolTimeline } from "./ToolTimeline";
import { IconChevron, IconSpark } from "./icons";

/** 用户一轮输入：右侧气泡，下方是这一轮携带的运行上下文。 */
export function UserTurn({ prompt, chips }: { prompt: string; chips?: ReactNode }) {
  return (
    <article className="flex flex-col items-end gap-1.5 self-end max-w-[90%] sm:max-w-[80%]">
      <p className="rounded-2xl rounded-tr-xs bg-primary px-4 py-2.5 text-sm leading-6 text-primary-foreground break-words whitespace-pre-wrap shadow-xs">
        {prompt}
      </p>
      {chips ? (
        <div className="flex flex-wrap items-center justify-end gap-2 px-1 text-xs text-muted-foreground">
          {chips}
        </div>
      ) : null}
    </article>
  );
}

/** 助理一轮回复：包含状态指示、执行流水线卡片、展开工具记录与业务汇报。 */
export function AssistantTurn({ turn, phase, busy }: { turn: TurnView; phase: string | null; busy: boolean }) {
  // null = 跟随默认（进行中展开、结束后收起）；用户点过之后按用户的选择。
  const [stepsOpen, setStepsOpen] = useState<boolean | null>(null);
  const streaming = turn.live && busy;
  const open = stepsOpen ?? streaming;

  return (
    <article className="flex items-start gap-3 w-full">
      <span
        aria-hidden="true"
        className={cn(
          "mt-1 grid size-8 shrink-0 place-items-center rounded-xl border border-border bg-surface text-brand shadow-xs transition-all",
          streaming && "border-brand/40 ring-2 ring-brand/20",
        )}
      >
        <IconSpark width={16} height={16} />
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {/* 顶部标题栏 */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">助理</span>
          {turn.live ? <ToneBadge tone={phaseTone(phase)}>{phaseLabel(phase)}</ToneBadge> : null}
          {streaming ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                aria-hidden="true"
                className="size-3 animate-spin rounded-full border-[1.5px] border-input border-t-brand"
              />
              正在执行
            </span>
          ) : null}
        </div>

        {/* 核心工作卡片：流水线阶段 + 工具执行详情 */}
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
          <div className="flex flex-col gap-2.5 border-b border-border/70 bg-muted/20 px-4 py-3">
            <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              执行过程
            </span>
            <PhaseBar phase={phase} />
          </div>

          <Collapsible open={open} onOpenChange={setStepsOpen}>
            <CollapsibleTrigger
              className={cn(
                "flex w-full items-center justify-between px-4 py-2.5 text-left text-xs font-medium transition-colors",
                "hover:bg-accent hover:text-accent-foreground",
                open && "text-foreground bg-muted/10",
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={cn("inline-flex transition-transform duration-200", open && "rotate-180")}
                >
                  <IconChevron width={14} height={14} />
                </span>
                <span>执行明细</span>
              </div>
              <span className="text-xs text-muted-foreground">
                {turn.tools.length > 0 ? `${turn.tools.length} 次调用` : "准备中"}
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent className="border-t border-border/70 px-4 py-2 bg-surface/50">
              <ToolTimeline tools={turn.tools} busy={streaming} />
            </CollapsibleContent>
          </Collapsible>
        </div>

        {/* 业务汇报 */}
        <ReportPanel reply={turn.reply} busy={streaming} />
      </div>
    </article>
  );
}
