/** 阶段流水线：直观展示任务进行到哪个步骤。 */
import { cn } from "cn";

import { PHASE_FLOW, PHASE_LABELS, PHASE_OFF_FLOW } from "../labels";
import { IconAlert, IconCheck } from "./icons";

export function PhaseBar({ phase }: { phase: string | null }) {
  const flow: readonly string[] = PHASE_FLOW;
  const index = phase ? flow.indexOf(phase) : -1;
  const isOffFlow = phase ? (PHASE_OFF_FLOW as readonly string[]).includes(phase) : false;

  return (
    <div className="flex flex-col gap-2" aria-label="任务阶段流水线">
      <ol className="flex flex-wrap items-center gap-1 sm:gap-2">
        {flow.map((step, stepIndex) => {
          const isDone = index >= 0 && stepIndex < index;
          const isCurrent = index >= 0 && stepIndex === index;
          const isPending = index < 0 || stepIndex > index;

          return (
            <li key={step} className="flex items-center">
              <div
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2 py-1 transition-all",
                  isCurrent && "bg-brand/10 text-brand ring-1 ring-brand/30",
                  isDone && "text-muted-foreground",
                  isPending && "text-muted-foreground/40",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "grid size-4 shrink-0 place-items-center rounded-full text-[10px] transition-all",
                    isDone && "bg-ok text-white dark:text-black",
                    isCurrent && "animate-pulse bg-brand text-white dark:text-black",
                    isPending && "border border-border bg-background",
                  )}
                >
                  {isDone ? (
                    <IconCheck width={10} height={10} strokeWidth={3} />
                  ) : (
                    <span className="font-mono text-[9px]">{stepIndex + 1}</span>
                  )}
                </span>
                <span
                  className={cn(
                    "text-xs font-medium whitespace-nowrap",
                    isCurrent && "font-semibold text-brand",
                    isDone && "text-foreground",
                  )}
                >
                  {PHASE_LABELS[step] ?? step}
                </span>
              </div>

              {stepIndex < flow.length - 1 ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "mx-0.5 h-[1px] w-2 sm:w-3 transition-colors",
                    stepIndex < index ? "bg-ok/60" : "bg-border",
                  )}
                />
              ) : null}
            </li>
          );
        })}

        {isOffFlow && phase ? (
          <li className="flex items-center">
            <span aria-hidden="true" className="mx-1 h-[1px] w-3 bg-bad/50" />
            <div className="flex items-center gap-1.5 rounded-md bg-bad/10 px-2 py-1 text-bad ring-1 ring-bad/30">
              <span className="grid size-4 place-items-center rounded-full bg-bad text-white">
                <IconAlert width={10} height={10} strokeWidth={2.5} />
              </span>
              <span className="text-xs font-semibold">{PHASE_LABELS[phase] ?? phase}</span>
            </div>
          </li>
        ) : null}
      </ol>
    </div>
  );
}
