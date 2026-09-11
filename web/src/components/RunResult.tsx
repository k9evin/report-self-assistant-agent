/** 结果区：状态药丸、五道 Gate、错误/警告、产物、计划与验证 JSON（全部 shadcn 组件 + 设计令牌）。 */
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "cn";

import { outputFileUrl } from "../api";
import { GATE_ORDER, gateLabel, issueDetail, phaseLabel, phaseTone } from "../labels";
import type { Check, GateValue, RunView, ValidationIssue } from "../types";
import { ChecksBlock } from "./Checks";
import { ResultBlock } from "./ResultBlock";
import { ToneBadge } from "./ToneBadge";
import { IconCheck, IconChevron, IconCross, IconDash, IconDownload } from "./icons";

const GATE_TEXT: Record<GateValue, string> = {
  pass: "通过",
  fail: "失败",
  not_executed: "未执行",
};

const GATE_TONE: Record<GateValue, string> = {
  pass: "text-ok",
  fail: "text-bad",
  not_executed: "text-faint",
};

function GateMark({ value }: { value: GateValue }) {
  const Icon = value === "pass" ? IconCheck : value === "fail" ? IconCross : IconDash;
  return (
    <span className={cn("inline-flex items-center gap-1.5", GATE_TONE[value])}>
      <Icon width={14} height={14} aria-hidden="true" /> {GATE_TEXT[value]}
    </span>
  );
}

function IssueList({ title, issues }: { title: string; issues: ValidationIssue[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-faint">{title}</span>
      {issues.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">无</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {issues.map((issue, index) => (
            <li
              key={`${issue.code ?? "issue"}-${index}`}
              className="flex items-baseline gap-2 text-[13px] break-words text-muted-foreground"
            >
              {issue.code ? (
                <code className="flex-none rounded border border-border bg-muted px-1.5 py-px text-foreground">
                  {issue.code}
                </code>
              ) : null}
              <span>{issueDetail(issue)}</span>
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
      <CollapsibleTrigger className="flex min-h-10 w-full items-center gap-2 rounded-md border border-border bg-muted px-3 py-1.5 text-left text-[13px] hover:text-brand [&[data-state=open]>svg]:rotate-180">
        <IconChevron width={16} height={16} aria-hidden="true" className="transition-transform" />
        <span className="font-medium">{title}</span>
        {empty ? <span className="ml-auto text-xs text-faint">未产出</span> : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {empty ? (
          <p className="px-3 py-2 text-[13px] text-muted-foreground">本次运行没有产出这份 JSON。</p>
        ) : (
          <pre className="max-h-[420px] overflow-auto border-t border-border bg-muted p-3 font-mono text-[13px] leading-[1.85] break-words whitespace-pre-wrap">
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
}: {
  runId: string;
  run: RunView | null;
  phase: string | null;
  checks: Check[];
  className?: string;
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

  return (
    <Card
      aria-label="运行结果"
      className={cn("gap-0 border-border px-6 py-6 shadow-none", className)}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold tracking-tight">运行结果</h3>
        <div className="flex items-center gap-2">
          <ToneBadge tone={phaseTone(finalPhase)}>{phaseLabel(finalPhase)}</ToneBadge>
          {duration ? <span className="text-xs text-faint">{duration}</span> : null}
        </div>
      </div>

      <dl className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-x-4 gap-y-2">
        <div>
          <dt className="text-xs text-faint">运行 ID</dt>
          <dd className="mt-0.5 text-[13px] break-all">
            <code>{runId}</code>
          </dd>
        </div>
        {run?.task_id ? (
          <div>
            <dt className="text-xs text-faint">任务 ID</dt>
            <dd className="mt-0.5 text-[13px] break-all">
              <code>{run.task_id}</code>
            </dd>
          </div>
        ) : null}
        {run?.dataset_id ? (
          <div>
            <dt className="text-xs text-faint">数据集</dt>
            <dd className="mt-0.5 text-[13px] break-all">
              <code>{run.dataset_id}</code>
            </dd>
          </div>
        ) : null}
      </dl>

      <ResultBlock title="五道 Gate">
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-auto px-3 py-2 text-xs font-medium text-faint">Gate</TableHead>
              <TableHead className="h-auto px-3 py-2 text-xs font-medium text-faint">结果</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...GATE_ORDER, ...extraGates].map((key) => {
              const value: GateValue = gates[key] ?? "not_executed";
              return (
                <TableRow key={key} className="hover:bg-transparent">
                  <TableHead
                    scope="row"
                    className="flex h-auto flex-col gap-0.5 px-3 py-2 font-normal whitespace-normal"
                  >
                    <span className="text-foreground">{gateLabel(key)}</span>
                    <code className="text-xs text-faint">{key}</code>
                  </TableHead>
                  <TableCell className="px-3 py-2 whitespace-normal">
                    <GateMark value={value} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {validation === null ? (
          <p className="mt-2 text-[13px] text-muted-foreground">
            本次运行没有产出验证 JSON，Gate 一律显示为未执行。
          </p>
        ) : null}
      </ResultBlock>

      <ResultBlock title="错误与警告">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4">
          <IssueList title="错误（errors）" issues={errors} />
          <IssueList title="警告（warnings）" issues={warnings} />
        </div>
      </ResultBlock>

      <ResultBlock title="产物">
        <div className="mb-3 grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-3 max-sm:grid-cols-2">
          <div className="flex flex-col gap-0.5 rounded-md border border-border px-3 py-2.5">
            <span className="text-xl font-semibold tracking-tight">{outputs?.total ?? 0}</span>
            <span className="text-xs text-faint">总数</span>
          </div>
          <div className="flex flex-col gap-0.5 rounded-md border border-border px-3 py-2.5">
            <span className="text-xl font-semibold tracking-tight text-ok">{outputs?.completed ?? 0}</span>
            <span className="text-xs text-faint">成功</span>
          </div>
          <div className="flex flex-col gap-0.5 rounded-md border border-border px-3 py-2.5">
            <span className="text-xl font-semibold tracking-tight text-warn">
              {outputs?.completed_with_warnings ?? 0}
            </span>
            <span className="text-xs text-faint">带警告</span>
          </div>
          <div className="flex flex-col gap-0.5 rounded-md border border-border px-3 py-2.5">
            <span className="text-xl font-semibold tracking-tight text-bad">{outputs?.failed ?? 0}</span>
            <span className="text-xs text-faint">失败</span>
          </div>
        </div>
        {files.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">没有可下载的产物文件。</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {files.map((file) => (
              <li key={file}>
                <a
                  className="inline-flex min-h-10 items-center gap-2 rounded-md border border-border px-2.5 py-1 text-[13px] break-all text-foreground no-underline transition-colors hover:border-faint hover:bg-muted hover:no-underline"
                  href={outputFileUrl(runId, file)}
                  download
                >
                  <IconDownload width={14} height={14} aria-hidden="true" />
                  <span>{file}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </ResultBlock>

      {checks.length > 0 ? <ChecksBlock checks={checks} /> : null}

      <ResultBlock title="原始 JSON">
        <div className="flex flex-col gap-2">
          <JsonViewer title="计划 JSON" value={run?.plan ?? null} />
          <JsonViewer title="验证 JSON" value={validation} />
        </div>
      </ResultBlock>
    </Card>
  );
}
