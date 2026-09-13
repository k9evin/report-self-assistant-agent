/** 页签 2：测试案例 —— 用例清单 + 筛选 + 逐行运行 + 行内结果。 */
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

import { errorMessage, fetchCases } from "../api";
import { expectSummary, phaseLabel, phaseTone } from "../labels";
import type { TestCase } from "../types";
import { useRunStream } from "../useRunStream";
import { RunResult } from "./RunResult";
import { EmptyState, ErrorBox, LoadingDots } from "./States";
import { ToneBadge } from "./ToneBadge";
import { IconChevron, IconShieldCheck, IconSpark } from "./icons";

function CaseRow({ testCase }: { testCase: TestCase }) {
  const { state, startCase, reset } = useRunStream();
  const running = state.busy;
  const isAgent = testCase.kind !== "deterministic";

  return (
    <Card className="gap-3 border-border p-5 shadow-xs transition-all hover:border-border/80">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <h3 className="text-sm font-semibold tracking-tight text-foreground">{testCase.title || testCase.id}</h3>
          <ToneBadge tone={isAgent ? "neutral" : "success"} title={`用例类型：${testCase.kind}`}>
            {isAgent ? (
              <span className="flex items-center gap-1">
                <IconSpark width={12} height={12} className="text-brand" />
                <span>模型用例</span>
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <IconShieldCheck width={12} height={12} className="text-ok" />
                <span>确定性核（0 Token）</span>
              </span>
            )}
          </ToneBadge>
        </div>
        <Button
          type="button"
          size="sm"
          className="h-8 rounded-lg px-4"
          onClick={() => void startCase(testCase.id)}
          disabled={running}
        >
          {running ? "运行中…" : "运行此用例"}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed">{testCase.description ?? "——"}</p>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        <div>
          <dt className="text-[11px] text-muted-foreground">用例 ID</dt>
          <dd className="mt-0.5 text-xs font-mono text-foreground">
            <code>{testCase.id}</code>
          </dd>
        </div>
        {testCase.dataset_id ? (
          <div>
            <dt className="text-[11px] text-muted-foreground">数据集</dt>
            <dd className="mt-0.5 text-xs font-mono text-foreground">
              <code>{testCase.dataset_id}</code>
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="text-[11px] text-muted-foreground">写入</dt>
          <dd className="mt-0.5 text-xs font-medium text-foreground">
            {testCase.auto_execute ? "写入产物" : "仅门禁验证"}
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-baseline gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-1.5 text-xs">
        <span className="font-semibold text-muted-foreground">期望：</span>
        <span className="text-foreground">{expectSummary(testCase.expect)}</span>
      </div>

      {testCase.request ? (
        <Collapsible>
          <CollapsibleTrigger className="flex min-h-8 w-full items-center justify-between rounded-md border border-border bg-card px-3 py-1.5 text-left text-xs hover:bg-muted/50 transition-colors">
            <div className="flex items-center gap-1.5 font-medium text-muted-foreground">
              <IconChevron width={14} height={14} aria-hidden="true" className="transition-transform [&[data-state=open]]:rotate-180" />
              <span>查看需求原文</span>
            </div>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="max-h-[300px] overflow-auto rounded-b-md border-x border-b border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
              {testCase.request}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      {state.error ? (
        <ErrorBox message={state.error} title="用例运行出错" onRetry={() => reset()} retryLabel="清除" />
      ) : null}

      {state.started || state.run ? (
        <div className="flex flex-col gap-3 border-t border-border/80 pt-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              本次运行
              {state.runId ? (
                <>
                  {" · "}
                  <code className="font-mono text-foreground">{state.runId}</code>
                </>
              ) : null}
            </span>
            <div className="flex items-center gap-2">
              <ToneBadge tone={phaseTone(state.phase)}>{phaseLabel(state.phase)}</ToneBadge>
              {running ? <span className="text-xs text-muted-foreground">正在执行</span> : null}
            </div>
          </div>

          {state.tools.length > 0 ? (
            <p className="text-xs break-all text-muted-foreground font-mono">
              工具链路：
              {state.tools.map((tool) => tool.name).join(" → ")}
            </p>
          ) : null}

          {state.reply ? (
            <pre className="max-h-[220px] overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
              {state.reply}
            </pre>
          ) : null}

          {state.finished && state.runId ? (
            <RunResult
              runId={state.runId}
              run={state.run}
              phase={state.phase}
              checks={state.checks}
              className="mt-0 gap-4 rounded-xl border-border bg-muted/10 p-4"
            />
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

export function CasesTab() {
  const [cases, setCases] = useState<TestCase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filterKind, setFilterKind] = useState<"all" | "deterministic" | "agent">("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body = await fetchCases();
      setCases(body.cases);
    } catch (cause) {
      setError(errorMessage(cause));
      setCases([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <Card className="border-border p-6 shadow-none">
        <LoadingDots label="正在加载内置测试案例…" />
      </Card>
    );
  }

  if (error) {
    return <ErrorBox message={error} title="测试案例加载失败" onRetry={() => void load()} />;
  }

  const allCases = cases ?? [];
  const filtered = allCases.filter((c) => {
    if (filterKind === "all") return true;
    return c.kind === filterKind;
  });

  return (
    <div className="flex flex-col gap-4">
      <Card className="border-border p-4 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base font-semibold tracking-tight text-foreground">测试案例</h3>

          <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/30 p-1">
            <button
              type="button"
              onClick={() => setFilterKind("all")}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                filterKind === "all" ? "bg-card text-foreground shadow-2xs" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              全部 ({allCases.length})
            </button>
            <button
              type="button"
              onClick={() => setFilterKind("deterministic")}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                filterKind === "deterministic" ? "bg-card text-foreground shadow-2xs" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              确定性核 ({allCases.filter((c) => c.kind === "deterministic").length})
            </button>
            <button
              type="button"
              onClick={() => setFilterKind("agent")}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                filterKind === "agent" ? "bg-card text-foreground shadow-2xs" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              模型用例 ({allCases.filter((c) => c.kind === "agent").length})
            </button>
          </div>
        </div>
      </Card>

      {filtered.length === 0 ? (
        <EmptyState
          eyebrow="No Cases"
          title="未找到匹配的测试案例"
          subtitle="可切换筛选器查看其它类型的案例。"
        />
      ) : (
        filtered.map((testCase) => <CaseRow key={testCase.id} testCase={testCase} />)
      )}
    </div>
  );
}
