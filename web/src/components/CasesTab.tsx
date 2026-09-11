/** 页签 2：测试案例 —— 用例清单 + 逐行运行 + 行内结果。 */
import { useCallback, useEffect, useState } from "react";

import { errorMessage, fetchCases } from "../api";
import { expectSummary, kindLabel, phaseLabel, phaseTone } from "../labels";
import type { TestCase } from "../types";
import { useRunStream } from "../useRunStream";
import { Collapsible, EmptyState, ErrorBox, LoadingDots, StatusPill } from "./States";
import { RunResult } from "./RunResult";

function CaseRow({ testCase }: { testCase: TestCase }) {
  const { state, startCase, reset } = useRunStream();
  const running = state.busy;
  const isAgent = testCase.kind !== "deterministic";

  return (
    <article className="card case-row">
      <div className="block-head">
        <div className="case-title">
          <h3>{testCase.title || testCase.id}</h3>
          <StatusPill tone={isAgent ? "neutral" : "success"} title={`用例类型：${testCase.kind}`}>
            {kindLabel(testCase.kind)}
          </StatusPill>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void startCase(testCase.id)}
          disabled={running}
        >
          {running ? "运行中…" : "运行此用例"}
        </button>
      </div>

      <p className="muted small case-desc">{testCase.description ?? "——"}</p>

      <dl className="case-meta">
        <div>
          <dt>用例 ID</dt>
          <dd>
            <code>{testCase.id}</code>
          </dd>
        </div>
        {testCase.dataset_id ? (
          <div>
            <dt>数据集</dt>
            <dd>
              <code>{testCase.dataset_id}</code>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>写入</dt>
          <dd>{testCase.auto_execute ? "会写入文件" : "只做预演"}</dd>
        </div>
      </dl>

      <p className="expect">
        <span className="caption">期望</span>
        <span>{expectSummary(testCase.expect)}</span>
      </p>

      {testCase.request ? (
        <Collapsible title="用例请求原文">
          <pre className="code-block">{testCase.request}</pre>
        </Collapsible>
      ) : null}

      {state.error ? (
        <ErrorBox message={state.error} title="用例运行出错" onRetry={() => reset()} retryLabel="清除" />
      ) : null}

      {state.started || state.run ? (
        <div className="case-run">
          <div className="block-head">
            <span className="caption">
              本次运行
              {state.runId ? (
                <>
                  {" · "}
                  <code>{state.runId}</code>
                </>
              ) : null}
            </span>
            <div className="result-meta">
              <StatusPill tone={phaseTone(state.phase)}>{phaseLabel(state.phase)}</StatusPill>
              {running ? <span className="caption">进行中</span> : null}
            </div>
          </div>

          {state.tools.length > 0 ? (
            <p className="caption case-tools">
              调用过的工具：
              {state.tools.map((tool) => tool.name).join(" → ")}
            </p>
          ) : null}

          {state.reply ? <pre className="code-block case-reply">{state.reply}</pre> : null}

          {/* 与「运行任务」页签同一套结果区：Gate 表、错误/警告、产物下载、计划与验证 JSON、断言清单。 */}
          {state.finished && state.runId ? (
            <RunResult runId={state.runId} run={state.run} phase={state.phase} checks={state.checks} />
          ) : null}
        </div>
      ) : null}
    </article>
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
      <section className="card">
        <LoadingDots label="正在读取测试案例…" />
      </section>
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
    <div className="stack">
      <section className="card case-intro">
        <div className="block-head">
          <h3>测试案例</h3>
          <span className="caption">{cases?.length ?? 0} 个用例</span>
        </div>
        <p className="muted small">
          每个用例是一组固定输入与期望断言；「模型用例」会调用模型，「确定性用例」只跑确定性核，不花 token。
          运行结果会展开在对应用例的下方。
        </p>
      </section>

      {(cases ?? []).map((testCase) => (
        <CaseRow key={testCase.id} testCase={testCase} />
      ))}
    </div>
  );
}
