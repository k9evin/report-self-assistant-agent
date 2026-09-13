import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "cn";

import { outputFileUrl } from "../api";
import { GATE_ORDER, gateLabel, issueDetail, phaseLabel, phaseTone } from "../labels";
import type { Check, GateValue, RunView, ValidationIssue } from "../types";
import { ChecksBlock } from "./Checks";
import { ResultBlock } from "./ResultBlock";
import { ToneBadge } from "./ToneBadge";
import {
  IconCheck,
  IconChevron,
  IconCross,
  IconDash,
  IconDownload,
  IconFileSpreadsheet,
  IconShieldCheck,
} from "./icons";

const GATE_TEXT: Record<GateValue, string> = {
  pass: "通过",
  fail: "阻断",
  not_executed: "未执行",
};

function GateCard({ gateKey, value }: { gateKey: string; value: GateValue }) {
  const isPass = value === "pass";
  const isFail = value === "fail";

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-xl border p-3.5 transition-all duration-200 shadow-2xs",
        isPass && "border-ok/30 bg-ok/5 dark:bg-ok/10",
        isFail && "border-bad/40 bg-bad/5 dark:bg-bad/10",
        !isPass && !isFail && "border-border/60 bg-muted/25",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-foreground">{gateLabel(gateKey)}</span>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium",
            isPass && "bg-ok/15 text-ok",
            isFail && "bg-bad/15 text-bad",
            !isPass && !isFail && "bg-muted text-muted-foreground",
          )}
        >
          {isPass ? (
            <IconCheck width={12} height={12} strokeWidth={2.5} />
          ) : isFail ? (
            <IconCross width={12} height={12} strokeWidth={2.5} />
          ) : (
            <IconDash width={12} height={12} />
          )}
          <span>{GATE_TEXT[value]}</span>
        </span>
      </div>
      <code className="text-[10px] text-muted-foreground/70 font-mono">{gateKey}</code>
    </div>
  );
}

function IssueList({ title, issues, tone }: { title: string; issues: ValidationIssue[]; tone: "bad" | "warn" }) {
  const isBad = tone === "bad";
  return (
    <div className="flex flex-col gap-2">
      <span className={cn("text-xs font-semibold uppercase tracking-wider", isBad ? "text-bad" : "text-warn")}>
        {title} ({issues.length})
      </span>
      {issues.length === 0 ? (
        <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/15 px-3.5 py-2.5 text-xs text-muted-foreground">
          <IconCheck width={14} height={14} className="text-ok" />
          <span>无异常记录</span>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {issues.map((issue, index) => (
            <li
              key={`${issue.code ?? "issue"}-${index}`}
              className={cn(
                "flex flex-col gap-1 rounded-xl border p-3 text-xs leading-relaxed",
                isBad ? "border-bad/30 bg-bad/5" : "border-warn/30 bg-warn/5",
              )}
            >
              <div className="flex items-center gap-2">
                {issue.code ? (
                  <code className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] font-bold text-foreground">
                    {issue.code}
                  </code>
                ) : null}
                <span className="font-medium text-foreground">{issueDetail(issue)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function JsonViewer({ title, value }: { title: string; value: unknown }) {
  const empty = value === null || value === undefined;
  return (
    <Collapsible>
      <CollapsibleTrigger className="flex min-h-10 w-full items-center justify-between rounded-xl border border-border/70 bg-card px-3.5 py-2.5 text-left text-xs hover:bg-muted/50 transition-colors shadow-2xs cursor-pointer">
        <div className="flex items-center gap-2">
          <IconChevron width={14} height={14} aria-hidden="true" className="transition-transform [&[data-state=open]]:rotate-180" />
          <span className="font-medium text-foreground">{title}</span>
        </div>
        {empty ? (
          <span className="text-xs text-muted-foreground">未生成</span>
        ) : (
          <span className="text-[11px] font-mono text-muted-foreground">JSON 格式</span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {empty ? (
          <p className="px-4 py-2 text-xs text-muted-foreground">本次运行未产出对应 JSON。</p>
        ) : (
          <pre className="max-h-[380px] overflow-auto rounded-b-xl border-x border-b border-border/70 bg-muted/40 p-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
            {JSON.stringify(value, null, 2)}
          </pre>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function formatDuration(run: RunView): string | null {
  if (typeof run.duration_ms !== "number") return null;
  const seconds = run.duration_ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${Math.round(seconds - minutes * 60)} 秒`;
}

export function RunResult({
  runId,
  run,
  phase,
  checks,
  className,
  devMode = false,
}: {
  runId: string;
  run: RunView | null;
  phase: string | null;
  checks: Check[];
  className?: string;
  devMode?: boolean;
}) {
  const validation = run?.validation ?? null;
  const gates = validation?.gates ?? {};
  const errors = Array.isArray(validation?.errors) ? validation.errors : [];
  const warnings = Array.isArray(validation?.warnings) ? validation.warnings : [];
  const extraGates = Object.keys(gates).filter(
    (key) => !(GATE_ORDER as readonly string[]).includes(key),
  );
  const outputs = run?.outputs ?? null;
  const files = Array.isArray(run?.output_files) ? run.output_files : [];
  const duration = run ? formatDuration(run) : null;
  const finalPhase = run?.phase ?? phase;

  const total = outputs?.total ?? 0;
  const completed = outputs?.completed ?? 0;
  const withWarnings = outputs?.completed_with_warnings ?? 0;
  const failed = outputs?.failed ?? 0;
  const successTotal = completed + withWarnings;
  const successRate = total > 0 ? Math.round((successTotal / total) * 100) : 0;

  return (
    <div className={cn("rounded-[1.75rem] p-1.5 border border-border/70 bg-muted/20 backdrop-blur-xl shadow-lg", className)}>
      <div className="flex flex-col gap-6 rounded-[calc(1.75rem-0.375rem)] border border-border/40 bg-card p-6 sm:p-8 shadow-[inset_0_1px_1px_rgba(255,255,255,0.08)]">
        {/* 头部元信息栏 */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-4">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-xl bg-brand/10 text-brand ring-1 ring-brand/25">
              <IconShieldCheck width={17} height={17} />
            </span>
            <div>
              <h3 className="text-base font-semibold tracking-tight text-foreground">运行结果</h3>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <ToneBadge tone={phaseTone(finalPhase)} className="px-3 py-1 text-xs">
              {phaseLabel(finalPhase)}
            </ToneBadge>
            {duration ? (
              <span className="rounded-full border border-border bg-muted/50 px-2.5 py-0.5 font-mono text-xs text-muted-foreground">
                {duration}
              </span>
            ) : null}
          </div>
        </div>

        {/* 运行指标与统计卡片 */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="flex flex-col gap-1 rounded-xl border border-border/70 bg-background/50 p-3.5 shadow-2xs">
            <span className="text-xs text-muted-foreground">总数</span>
            <span className="font-mono text-2xl font-bold tracking-tight text-foreground">{total}</span>
          </div>
          <div className="flex flex-col gap-1 rounded-xl border border-border/70 bg-background/50 p-3.5 shadow-2xs">
            <span className="text-xs text-muted-foreground">成功</span>
            <span className="font-mono text-2xl font-bold tracking-tight text-ok">{completed}</span>
          </div>
          <div className="flex flex-col gap-1 rounded-xl border border-border/70 bg-background/50 p-3.5 shadow-2xs">
            <span className="text-xs text-muted-foreground">带警告</span>
            <span className="font-mono text-2xl font-bold tracking-tight text-warn">{withWarnings}</span>
          </div>
          <div className="flex flex-col gap-1 rounded-xl border border-border/70 bg-background/50 p-3.5 shadow-2xs">
            <span className="text-xs text-muted-foreground">失败</span>
            <span className="font-mono text-2xl font-bold tracking-tight text-bad">{failed}</span>
          </div>
        </div>

        {/* 回填进度条 */}
        {total > 0 ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>回填成功率</span>
              <span className="font-mono font-medium">{successRate}% ({successTotal}/{total})</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full transition-all duration-500",
                  failed > 0 ? "bg-warn" : "bg-ok",
                )}
                style={{ width: `${successRate}%` }}
              />
            </div>
          </div>
        ) : null}

        {/* 产物文件下载专区 */}
        <ResultBlock title="产物文件">
          {files.length === 0 ? (
            <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/20 p-4 text-xs text-muted-foreground">
              <span>本次运行未产出结果文件。</span>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {files.map((file) => {
                const isExcel = file.endsWith(".xlsx");
                return (
                  <a
                    key={file}
                    className="group flex items-center justify-between rounded-xl border border-border/70 bg-card p-3.5 transition-all duration-200 hover:border-brand/40 hover:bg-muted/40 active:scale-[0.99] shadow-2xs"
                    href={outputFileUrl(runId, file)}
                    download
                    title={`点击下载 ${file}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        aria-hidden="true"
                        className={cn(
                          "grid size-9 shrink-0 place-items-center rounded-xl text-sm",
                          isExcel ? "bg-ok/15 text-ok ring-1 ring-ok/20" : "bg-muted text-foreground",
                        )}
                      >
                        {isExcel ? <IconFileSpreadsheet width={17} height={17} /> : <IconDownload width={16} height={16} />}
                      </span>
                      <div className="flex flex-col min-w-0">
                        <span className="text-xs font-semibold text-foreground truncate group-hover:text-brand transition-colors">
                          {file}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          {isExcel ? "回填完成的测试报告 Excel" : "统计与验证明细"}
                        </span>
                      </div>
                    </div>
                    {/* Button-in-Button Trailing Download Icon */}
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border/80 bg-background text-muted-foreground transition-all duration-200 group-hover:border-brand/40 group-hover:bg-brand/10 group-hover:text-brand group-hover:scale-105">
                      <IconDownload width={13} height={13} />
                    </span>
                  </a>
                );
              })}
            </div>
          )}
        </ResultBlock>

        {/* 五道 Gate 安全准入看板 */}
        <ResultBlock title="五道 Gate 安全门禁">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[...GATE_ORDER, ...extraGates].map((key) => {
              const val: GateValue = gates[key] ?? "not_executed";
              return <GateCard key={key} gateKey={key} value={val} />;
            })}
          </div>
          {validation === null ? (
            <p className="mt-2 text-xs text-muted-foreground">
              本次运行没有产出验证 JSON，Gate 一律显示为未执行。
            </p>
          ) : null}
        </ResultBlock>

        {/* 错误与警告清单 */}
        {(errors.length > 0 || warnings.length > 0) ? (
          <ResultBlock title="错误与警告">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <IssueList title="阻断项 (Errors)" issues={errors} tone="bad" />
              <IssueList title="提示警告 (Warnings)" issues={warnings} tone="warn" />
            </div>
          </ResultBlock>
        ) : null}

        {/* 案例断言结果（仅在开发模式展示） */}
        {devMode && checks.length > 0 ? <ChecksBlock checks={checks} /> : null}

        {/* 原始 JSON 审计抽屉（仅在开发模式展示） */}
        {devMode ? (
          <ResultBlock title="原始计划与验证 JSON">
            <div className="flex flex-col gap-2">
              <JsonViewer title="回填计划 JSON (plan.json)" value={run?.plan ?? null} />
              <JsonViewer title="门禁校验 JSON (validation.json)" value={validation} />
            </div>
          </ResultBlock>
        ) : null}
      </div>
    </div>
  );
}
