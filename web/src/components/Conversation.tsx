/** 对话流：用户输入气泡 + 助理回合（执行过程 → 流式汇报）。 */
import type { ReactNode } from "react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "cn";

import type { StatusTone } from "../labels";
import { phaseLabel, phaseTone } from "../labels";
import type { TurnView } from "../useRunStream";
import { PhaseBar } from "./PhaseBar";
import { ReportPanel } from "./ReportPanel";
import { ToolTimeline } from "./ToolTimeline";
import { IconChevron, IconSpark } from "./icons";

const PHASE_BADGE: Record<StatusTone, string> = {
  success: "border-ok/40 bg-ok/10 text-ok",
  warning: "border-warn/40 bg-warn/10 text-warn",
  danger: "border-bad/40 bg-bad/10 text-bad",
  neutral: "border-border bg-muted text-muted-foreground",
};

/** 用户一轮输入：右侧气泡，下方是这一轮携带的运行上下文。 */
export function UserTurn({ prompt, chips }: { prompt: string; chips?: ReactNode }) {
  return (
    <article className="flex flex-col items-end gap-2">
      <p className="max-w-[85%] rounded-lg bg-secondary px-3.5 py-2.5 text-sm leading-6 break-words whitespace-pre-wrap">
        {prompt}
      </p>
      {chips ? (
        <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground">
          {chips}
        </div>
      ) : null}
    </article>
  );
}

/** 助理一轮回复：先给「执行过程」，再给流式汇报。 */
export function AssistantTurn({ turn, phase, busy }: { turn: TurnView; phase: string | null; busy: boolean }) {
  // null = 跟随默认（进行中展开、结束后收起）；用户点过之后按用户的选择。
  const [stepsOpen, setStepsOpen] = useState<boolean | null>(null);
  const streaming = turn.live && busy;
  const open = stepsOpen ?? streaming;

  return (
    <article className="flex gap-3">
      <span
        aria-hidden="true"
        className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border border-border bg-card text-brand"
      >
        <IconSpark width={14} height={14} />
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">助理</span>
          {turn.live ? (
            <Badge variant="outline" className={cn("rounded-full", PHASE_BADGE[phaseTone(phase)])}>
              {phaseLabel(phase)}
            </Badge>
          ) : null}
          {streaming ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                aria-hidden="true"
                className="size-3 animate-spin rounded-full border-[1.5px] border-input border-t-brand"
              />
              进行中
            </span>
          ) : null}
        </div>

        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex flex-col gap-2.5 border-b border-border px-4 py-3">
            <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              执行过程
            </span>
            <PhaseBar phase={phase} />
          </div>

          <Collapsible open={open} onOpenChange={setStepsOpen}>
            <CollapsibleTrigger
              className={cn(
                "flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm",
                "hover:bg-accent hover:text-accent-foreground",
                open && "text-foreground",
              )}
            >
              <span aria-hidden="true" className={cn("inline-flex transition-transform", open && "rotate-180")}>
                <IconChevron width={14} height={14} />
              </span>
              <span>执行步骤</span>
              <span className="text-xs text-muted-foreground">
                {turn.tools.length > 0 ? `${turn.tools.length} 次工具调用` : "暂无调用"}
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent className="border-t border-border px-4 py-2">
              <ToolTimeline tools={turn.tools} busy={streaming} />
            </CollapsibleContent>
          </Collapsible>
        </div>

        <ReportPanel reply={turn.reply} busy={streaming} />
      </div>
    </article>
  );
}
