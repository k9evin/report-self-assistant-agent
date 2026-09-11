/** 页签 2：测试案例 —— 用例清单 + 逐行运行 + 行内结果（shadcn 组件 + 设计令牌）。 */
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

import { errorMessage, fetchCases } from "../api";
import { expectSummary, kindLabel, phaseLabel, phaseTone } from "../labels";
import type { TestCase } from "../types";
import { useRunStream } from "../useRunStream";
import { RunResult } from "./RunResult";
import { EmptyState, ErrorBox, LoadingDots } from "./States";
import { ToneBadge } from "./ToneBadge";
import { IconChevron } from "./icons";

function CaseRow({ testCase }: { testCase: TestCase }) {
  const { state, startCase, reset } = useRunStream();
  const running = state.busy;
  const isAgent = testCase.kind !== "deterministic";

  return (
    <Card className="gap-2.5 border-border px-6 py-6 shadow-none">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <h3 className="text-base font-semibold tracking-tight">{testCase.title || testCase.id}</h3>
          <ToneBadge tone={isAgent ? "neutral" : "success"} title={`用例类型：${testCase.kind}`}>
            {kindLabel(testCase.kind)}
          </ToneBadge>
        </div>
        <Button type="button" size="lg" onClick={() => void startCase(testCase.id)} disabled={running}>
          {running ? "运行中…" : "运行此用例"}
        </Button>
      </div>

      <p className="-mt-1 text-[13px] text-muted-foreground">{testCase.description ?? "——"}</p>

      <dl className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-x-4 gap-y-2">
        <div>
          <dt className="text-xs text-faint">用例 ID</dt>
          <dd className="mt-0.5 text-[13px] break-all">
            <code>{testCase.id}</code>
          </dd>
        </div>
        {testCase.dataset_id ? (
          <div>
            <dt className="text-xs text-faint">数据集</dt>
            <dd className="mt-0.5 text-[13px] break-all">
              <code>{testCase.dataset_id}</code>
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="text-xs text-faint">写入</dt>
          <dd className="mt-0.5 text-[13px] break-all">{testCase.auto_execute ? "会写入文件" : "只做预演"}</dd>
        </div>
      </dl>

      <p className="flex flex-wrap items-baseline gap-2 border-l-2 border-brand-100 pl-2.5 text-[13px] dark:border-[#1f2937]">
        <span className="text-xs text-faint">期望</span>
        <span>{expectSummary(testCase.expect)}</span>
      </p>

      {testCase.request ? (
        <Collapsible>
          <CollapsibleTrigger className="flex min-h-10 w-full items-center gap-2 rounded-md border border-border bg-muted px-3 py-1.5 text-left text-[13px] hover:text-brand [&[data-state=open]>svg]:rotate-180">
            <IconChevron width={16} height={16} aria-hidden="true" className="transition-transform" />
            <span className="font-medium">用例请求原文</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="max-h-[420px] overflow-auto border-t border-border bg-muted p-3 font-mono text-[13px] leading-[1.85] break-words whitespace-pre-wrap">
              {testCase.request}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      {state.error ? (
        <ErrorBox message={state.error} title="用例运行出错" onRetry={() => reset()} retryLabel="清除" />
      ) : null}

      {state.started || state.run ? (
        <div className="flex flex-col gap-2.5 border-t border-border pt-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-faint">
              本次运行
              {state.runId ? (
                <>
                  {" · "}
                  <code>{state.runId}</code>
                </>
              ) : null}
            </span>
            <div className="flex items-center gap-2">
              <ToneBadge tone={phaseTone(state.phase)}>{phaseLabel(state.phase)}</ToneBadge>
              {running ? <span className="text-xs text-faint">进行中</span> : null}
            </div>
          </div>

          {state.tools.length > 0 ? (
            <p className="text-xs break-all text-faint">
              调用过的工具：
              {state.tools.map((tool) => tool.name).join(" → ")}
            </p>
          ) : null}

          {state.reply ? (
            <pre className="max-h-[260px] overflow-auto rounded-md border border-border bg-muted p-3 font-mono text-[13px] leading-[1.85] break-words whitespace-pre-wrap">
              {state.reply}
            </pre>
          ) : null}

          {/* 与「运行任务」页签同一套结果区：Gate 表、错误/警告、产物下载、计划与验证 JSON、断言清单。 */}
          {state.finished && state.runId ? (
            <RunResult
              runId={state.runId}
              run={state.run}
              phase={state.phase}
              checks={state.checks}
              className="mt-0 gap-0 rounded-none border-0 bg-transparent px-0 py-0"
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
      <Card className="gap-0 border-border px-6 py-6 shadow-none">
        <LoadingDots label="正在读取测试案例…" />
      </Card>
    );
  }

  if (error) {
    return <ErrorBox message={error} title="测试案例加载失败" onRetry={() => void load()} />;
  }

  if ((cases ?? []).length === 0) {
    return (
      <EmptyState
        eyebrow="Cases"
        title="没有可用的测试案例"
        subtitle="后端返回了空列表，先确认 cases 配置是否已加载。"
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Card className="gap-0 border-border px-6 py-6 shadow-none">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base font-semibold tracking-tight">测试案例</h3>
          <span className="text-xs text-faint">{cases?.length ?? 0} 个用例</span>
        </div>
        <p className="-mt-1 text-[13px] text-muted-foreground">
          每个用例是一组固定输入与期望断言；「模型用例」会调用模型，「确定性用例」只跑确定性核，不花 token。
          运行结果会展开在对应用例的下方。
        </p>
      </Card>

      {(cases ?? []).map((testCase) => (
        <CaseRow key={testCase.id} testCase={testCase} />
      ))}
    </div>
  );
}
