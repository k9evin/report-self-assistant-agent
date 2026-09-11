/** 页签 1：运行任务 —— 对话式布局：输入固定在底部，过程与结果留在对话流里。 */
import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { errorMessage, fetchDatasets } from "../api";
import type { Dataset } from "../types";
import { turnViews, useRunStream } from "../useRunStream";
import { Composer } from "./Composer";
import { AssistantTurn, UserTurn } from "./Conversation";
import { RunResult } from "./RunResult";
import { EmptyState, ErrorBox, LoadingDots } from "./States";
import { IconCheck, IconSpark } from "./icons";

const DEFAULT_REQUEST = `每个 SN 下面找到 test report 文件。
模板每个 Sheet 的 P 列保存 Case 名称，根据 P 列匹配 XML 中 task 的 name。
提取对应 task 下面 item 的 ge、gr、te、nf，分别写入模板同一行的 F、H、J、L 列。
每个 SN 生成一个独立的 Excel 文件。`;

const HINT = (
  <>
    <kbd>Enter</kbd> 发送 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行
  </>
);

export function RunTab() {
  const [datasets, setDatasets] = useState<Dataset[] | null>(null);
  const [datasetsError, setDatasetsError] = useState<string | null>(null);
  const [loadingDatasets, setLoadingDatasets] = useState(true);
  const [datasetId, setDatasetId] = useState("");
  const [text, setText] = useState(DEFAULT_REQUEST);
  const [dryRun, setDryRun] = useState(false);

  const { state, startRun, ask, reset } = useRunStream();
  const turns = turnViews(state);
  const { started, busy, finished, runId } = state;
  const selectedDataset = (datasets ?? []).find((entry) => entry.dataset_id === datasetId);

  const loadDatasets = useCallback(async () => {
    setLoadingDatasets(true);
    setDatasetsError(null);
    try {
      const body = await fetchDatasets();
      setDatasets(body.datasets);
      const firstAvailable = body.datasets.find((entry) => entry.available);
      setDatasetId((current) => current || firstAvailable?.dataset_id || "");
    } catch (cause) {
      setDatasetsError(errorMessage(cause));
      setDatasets([]);
    } finally {
      setLoadingDatasets(false);
    }
  }, []);

  useEffect(() => {
    void loadDatasets();
  }, [loadDatasets]);

  // 跟随滚动：只跟随最新内容；用户向上翻阅时不再打断。
  const pinnedRef = useRef(true);
  useEffect(() => {
    const onScroll = () => {
      const doc = document.documentElement;
      pinnedRef.current = window.innerHeight + window.scrollY >= doc.scrollHeight - 96;
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!pinnedRef.current) return;
    window.scrollTo(0, document.documentElement.scrollHeight);
  }, [state.reply, state.tools.length, state.started, state.finished, state.runId]);

  /** 首次提交是运行，之后每次提交都算追问。 */
  const canSend = !busy && text.trim().length > 0 && (started || datasetId !== "");

  const submit = () => {
    const message = text.trim();
    if (!canSend || !message) return;
    setText("");
    if (started) {
      void ask(message);
      return;
    }
    void startRun({ request: message, dataset_id: datasetId, auto_execute: !dryRun });
  };

  const startNewTask = () => {
    setText(turns[0]?.prompt ?? DEFAULT_REQUEST);
    reset();
  };

  const datasetRow = (
    <>
      <span className="text-xs text-muted-foreground">数据集</span>
      {loadingDatasets ? (
        <LoadingDots label="正在读取数据集…" />
      ) : datasetsError ? (
        <ErrorBox message={datasetsError} title="数据集加载失败" onRetry={() => void loadDatasets()} />
      ) : (datasets ?? []).length === 0 ? (
        <span className="text-xs text-muted-foreground">后端没有返回任何数据集，请联系管理员检查挂载配置。</span>
      ) : (
        <Select value={datasetId} onValueChange={setDatasetId} disabled={busy}>
          <SelectTrigger size="sm" className="min-w-52" aria-label="数据集">
            <SelectValue placeholder="请选择数据集" />
          </SelectTrigger>
          <SelectContent>
            {(datasets ?? []).map((entry) => (
              <SelectItem key={entry.dataset_id} value={entry.dataset_id} disabled={!entry.available}>
                {entry.name}
                {entry.available
                  ? typeof entry.sn_count === "number"
                    ? `（${entry.sn_count} 个 SN）`
                    : ""
                  : `（不可用：${entry.problem?.message ?? "原因未知"}）`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
        <Checkbox
          checked={dryRun}
          onCheckedChange={(checked) => setDryRun(checked === true)}
          disabled={busy}
          aria-label="只做预演（Dry-Run），不写入文件"
        />
        只做预演（Dry-Run），不写入文件
      </label>
      {selectedDataset ? (
        <p className="w-full text-xs break-all text-muted-foreground">
          <code>{selectedDataset.dataset_id}</code>
          {selectedDataset.resolved_path ? <span> · {selectedDataset.resolved_path}</span> : null}
          {selectedDataset.writable_by_process ? <span> · 该挂载当前可写（生产环境应只读）</span> : null}
        </p>
      ) : null}
    </>
  );

  const askRow = (
    <>
      <span className="text-xs text-muted-foreground">本次运行</span>
      <code className="rounded border border-border px-1.5 py-0.5 text-xs">
        {turns[0]?.datasetId ?? "—"}
      </code>
      <Badge variant="outline" className="rounded-full font-normal text-muted-foreground">
        {turns[0]?.autoExecute ? "会写入文件" : "只做预演"}
      </Badge>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="ml-auto gap-1.5"
        onClick={startNewTask}
        disabled={busy}
      >
        <IconSpark width={14} height={14} />
        新建任务
      </Button>
    </>
  );

  return (
    <div className="mx-auto flex min-h-[calc(100vh-13rem)] w-full max-w-3xl flex-col gap-6">
      <div className="flex flex-1 flex-col gap-8">
        {!started ? (
          <div className="flex flex-1 items-center">
            <EmptyState
              eyebrow="Ready"
              title="选一个数据集，写下需求"
              subtitle="助手会依次探测模板与 XML 结构、提交计划、预演校验，再决定是否写入。整个过程会实时显示在这里。"
            >
              <ul className="mt-4 grid gap-2 text-left text-[13px] text-muted-foreground">
                <li className="flex items-start gap-2 rounded-md border border-border px-3 py-2.5">
                  <span className="mt-0.5 flex-none text-brand" aria-hidden="true">
                    <IconSpark width={14} height={14} />
                  </span>
                  预演（Dry-Run）不会改动任何文件，适合先确认匹配是否正确
                </li>
                <li className="flex items-start gap-2 rounded-md border border-border px-3 py-2.5">
                  <span className="mt-0.5 flex-none text-brand" aria-hidden="true">
                    <IconSpark width={14} height={14} />
                  </span>
                  五道 Gate 决定是否允许写入，任一失败都会被拦住
                </li>
                <li className="flex items-start gap-2 rounded-md border border-border px-3 py-2.5">
                  <span className="mt-0.5 flex-none text-brand" aria-hidden="true">
                    <IconSpark width={14} height={14} />
                  </span>
                  跑完后可以在下方继续追问，助手带着上下文接着改
                </li>
              </ul>
            </EmptyState>
          </div>
        ) : (
          turns.map((turn, index) => (
            <section key={`${turn.at}-${index}`} className="flex flex-col gap-3">
              <UserTurn
                prompt={turn.prompt}
                chips={
                  index === 0 ? (
                    <>
                      <code>{turn.datasetId ?? "—"}</code>
                      <span aria-hidden="true">·</span>
                      <span>{turn.autoExecute ? "会写入文件" : "只做预演"}</span>
                    </>
                  ) : null
                }
              />
              <AssistantTurn turn={turn} phase={state.phase} busy={busy} />
            </section>
          ))
        )}

        {state.error ? <ErrorBox message={state.error} title="运行出错" /> : null}

        {finished && runId ? (
          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span
                aria-hidden="true"
                className="grid size-7 shrink-0 place-items-center rounded-full border border-border bg-card text-ok"
              >
                <IconCheck width={14} height={14} />
              </span>
              <span className="text-sm font-semibold">结果</span>
              <span className="text-xs text-muted-foreground">
                最新一次运行 · <code>{runId}</code>
              </span>
            </div>
            <RunResult runId={runId} run={state.run} phase={state.phase} checks={state.checks} />
          </section>
        ) : null}
      </div>

      <Composer
        value={text}
        onChange={setText}
        onSubmit={submit}
        disabled={busy}
        canSend={canSend}
        busy={busy}
        rows={started ? 2 : 6}
        placeholder={
          started
            ? "继续追问这次运行，例如：inp21 那行留空就行"
            : "用自然语言描述要做的报告回填：改哪些列、怎么匹配、产物怎么分文件……"
        }
        submitLabel={started ? "追问" : "开始运行"}
        busyLabel={started ? "追问中…" : "运行中…"}
        top={started ? askRow : datasetRow}
        hint={HINT}
        note={
          started
            ? "追问会在同一次运行上继续处理，下面的结果区会更新为最新一次运行。"
            : "预演不会改动任何文件；五道 Gate 任一失败都会被拦住。"
        }
      />
    </div>
  );
}
