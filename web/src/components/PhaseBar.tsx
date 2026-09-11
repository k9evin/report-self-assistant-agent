/** 阶段条：把任务状态机映射成中文步骤条（嵌在对话的「执行过程」里，不带卡片外壳）。 */
import { cn } from "cn";

import { PHASE_FLOW, PHASE_LABELS, PHASE_OFF_FLOW } from "../labels";

export function PhaseBar({ phase }: { phase: string | null }) {
  const flow: readonly string[] = PHASE_FLOW;
  const index = phase ? flow.indexOf(phase) : -1;
  const isOffFlow = phase ? (PHASE_OFF_FLOW as readonly string[]).includes(phase) : false;

  return (
    <ol className="flex flex-wrap items-center gap-x-3 gap-y-2" aria-label="任务阶段">
      {flow.map((step, stepIndex) => {
        const state =
          index < 0 ? "todo" : stepIndex < index ? "done" : stepIndex === index ? "current" : "todo";
        return (
          <li key={step} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 rounded-full border",
                state === "done" && "border-ok bg-ok",
                state === "current" && "animate-pulse border-brand bg-brand",
                state === "todo" && "border-input bg-background",
              )}
            />
            <span
              className={cn(
                "text-xs text-muted-foreground",
                state === "current" && "font-medium text-foreground",
              )}
            >
              {PHASE_LABELS[step] ?? step}
            </span>
          </li>
        );
      })}
      {isOffFlow && phase ? (
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-1.5 rounded-full border border-bad bg-bad" />
          <span className="text-xs font-medium text-bad">{PHASE_LABELS[phase] ?? phase}</span>
        </li>
      ) : null}
    </ol>
  );
}
