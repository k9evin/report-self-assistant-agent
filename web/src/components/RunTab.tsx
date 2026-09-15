/** 页签 1：运行任务 —— 任务配置、对话执行与结果展示。 */
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import {
  errorMessage,
  fetchDatasets,
  fetchDirectories,
  fetchMountRoots,
  fetchTemplateInfo,
  resetTemplate,
  templateDownloadUrl,
  updateRun,
  uploadTemplate,
} from "../api";
import type { AppMode } from "../mode";
import type { Dataset, MountRoot, TemplateInfo } from "../types";
import { turnViews, useRunStream } from "../useRunStream";
import { Composer } from "./Composer";
import { DirectoryTreeSelect } from "./DirectoryTreeSelect";
import { AssistantTurn, UserTurn } from "./Conversation";
import { RunResult } from "./RunResult";
import { ErrorBox, LoadingDots } from "./States";
import { IconCheck, IconSpark } from "./icons";

const DEFAULT_REQUEST = `每个 SN 下面找到 test report 文件。
模板每个 Sheet 的 P 列保存 Case 名称，根据 P 列匹配 XML 中 task 的 name。
提取对应 task 下面 item 的 ge、gr、te、nf，分别写入模板同一行的 F、H、J、L 列。
每个 SN 生成一个独立的 Excel 文件。`;

const HINT = (
  <>
    <kbd className="rounded border border-border/60 bg-muted px-1 py-0.5 font-mono text-[10px]">Enter</kbd> 发送 ·{" "}
    <kbd className="rounded border border-border/60 bg-muted px-1 py-0.5 font-mono text-[10px]">Shift</kbd>+
    <kbd className="rounded border border-border/60 bg-muted px-1 py-0.5 font-mono text-[10px]">Enter</kbd> 换行
  </>
);

export function RunTab({
  selectedRunId,
  mode = "prod",
  onRunCreated,
  onNewSession,
}: {
  selectedRunId?: string | null;
  mode?: AppMode;
  onRunCreated?: (runId: string) => void;
  onNewSession?: () => void;
}) {
  const [datasets, setDatasets] = useState<Dataset[] | null>(null);
  const [datasetsError, setDatasetsError] = useState<string | null>(null);
  const [loadingDatasets, setLoadingDatasets] = useState(true);
  const [datasetId, setDatasetId] = useState("");
  const [mountRoots, setMountRoots] = useState<MountRoot[]>([]);
  const [mountRootId, setMountRootId] = useState("");
  const [directoryPath, setDirectoryPath] = useState("");

  // 上线模式中不预填 prompt，仅开发模式预置测试输入
  const [text, setText] = useState(() => (mode === "dev" ? DEFAULT_REQUEST : ""));

  // 模板信息与上传支持
  const [templateInfo, setTemplateInfo] = useState<TemplateInfo | null>(null);
  const [uploadingTemplate, setUploadingTemplate] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { state, startRun, ask, loadRun, reconnect, reset } = useRunStream();
  const turns = turnViews(state);

  const [localPinned, setLocalPinned] = useState<boolean | null>(null);

  useEffect(() => {
    setLocalPinned(null);
  }, [state.runId, selectedRunId]);

  const isPinned = localPinned !== null ? localPinned : Boolean(state.run?.pinned);

  useEffect(() => {
    if (selectedRunId && selectedRunId !== state.runId) loadRun(selectedRunId);
    else if (!selectedRunId && state.runId) reset();
  }, [loadRun, reset, selectedRunId, state.runId]);

  const { started, busy, finished, runId } = state;
  const selectedDataset = (datasets ?? []).find((entry) => entry.dataset_id === datasetId);

  const loadTemplate = useCallback(async () => {
    try {
      const info = await fetchTemplateInfo(mode, datasetId);
      setTemplateInfo(info);
    } catch {
      /* ignore */
    }
  }, [mode, datasetId]);

  const loadDatasets = useCallback(async () => {
    setLoadingDatasets(true);
    setDatasetsError(null);
    try {
      const [body, roots] = await Promise.all([fetchDatasets(), fetchMountRoots()]);
      setDatasets(body.datasets);
      setMountRoots(roots.mount_roots);
      if (mode === "dev") {
        const devDefault = body.datasets.find((entry) => entry.dataset_id === "ds_dev_fixture" && entry.available);
        const firstAvailable = body.datasets.find((entry) => entry.available);
        setDatasetId((current) => current || devDefault?.dataset_id || firstAvailable?.dataset_id || "");
      } else {
        const prodAvailable = body.datasets.find((entry) => entry.available && entry.mount_root_id !== "dev");
        setDatasetId((current) => (current && current !== "ds_dev_fixture" ? current : prodAvailable?.dataset_id || ""));
      }
    } catch (cause) {
      setDatasetsError(errorMessage(cause));
      setDatasets([]);
    } finally {
      setLoadingDatasets(false);
    }
  }, [mode]);

  useEffect(() => {
    void loadDatasets();
    void loadTemplate();
  }, [loadDatasets, loadTemplate]);

  // 当模式切换时，联动默认配置：
  // 1. 开发模式：预置默认测试 Prompt、默认测试夹具数据集以及默认模板
  // 2. 生产模式：若当前为测试默认 Prompt 则清空；若选中的是开发夹具则清空
  useEffect(() => {
    if (mode === "dev") {
      if (!text.trim()) {
        setText(DEFAULT_REQUEST);
      }
      setDatasetId((curr) => (!curr || curr === "" ? "ds_dev_fixture" : curr));
    } else {
      if (text === DEFAULT_REQUEST) {
        setText("");
      }
      setDatasetId((curr) => (curr === "ds_dev_fixture" ? "" : curr));
    }
  }, [mode]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingTemplate(true);
    try {
      await uploadTemplate(file);
      await loadTemplate();
    } catch (err) {
      alert(`上传模板失败: ${errorMessage(err)}`);
    } finally {
      setUploadingTemplate(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleResetTemplate = async () => {
    try {
      await resetTemplate();
      await loadTemplate();
    } catch (err) {
      alert(`清除模板失败: ${errorMessage(err)}`);
    }
  };

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

  const hasTemplate = Boolean(templateInfo?.has_template);
  const canSend = !busy && text.trim().length > 0 && (started || datasetId !== "" || (mountRootId !== "" && directoryPath !== ""));

  const submit = async () => {
    const message = text.trim();
    if (!message || busy) return;
    if (!started && !hasTemplate) {
      fileInputRef.current?.click();
      return;
    }
    if (!canSend) return;
    setText("");
    if (started) {
      void ask(message);
      return;
    }
    const newRunId = await startRun(datasetId
      ? { request: message, dataset_id: datasetId, auto_execute: true, mode }
      : { request: message, mount_root_id: mountRootId, relative_path: directoryPath, auto_execute: true, mode });
    if (newRunId) {
      onRunCreated?.(newRunId);
    }
  };

  const startNewTask = () => {
    setText(mode === "dev" ? (turns[0]?.prompt ?? DEFAULT_REQUEST) : "");
    if (mode === "dev") {
      setDatasetId("ds_dev_fixture");
    } else {
      setDatasetId("");
    }
    setMountRootId("");
    setDirectoryPath("");
    reset();
    onNewSession?.();
  };

  const datasetRow = (
    <div className="flex w-full flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-xs font-semibold text-foreground">目标数据集</span>
        {loadingDatasets ? (
          <LoadingDots label="正在读取数据源…" />
        ) : datasetsError ? (
          <ErrorBox message={datasetsError} title="数据集加载失败" onRetry={() => void loadDatasets()} />
        ) : (datasets ?? []).length === 0 ? (
          <span className="text-xs text-muted-foreground">后端无数据集配置，请检查挂载。</span>
        ) : (
          <Select value={datasetId} onValueChange={(value) => { setDatasetId(value); setMountRootId(""); setDirectoryPath(""); }} disabled={busy}>
            <SelectTrigger size="sm" className="min-w-44 bg-card rounded-lg" aria-label="选择测试数据集">
              <SelectValue placeholder="请选择测试数据集" />
            </SelectTrigger>
            <SelectContent>
              {(datasets ?? []).map((entry) => (
                <SelectItem key={entry.dataset_id} value={entry.dataset_id} disabled={!entry.available}>
                  {entry.name}
                  {entry.available
                    ? typeof entry.sn_count === "number"
                      ? `（${entry.sn_count} 个 SN · 只读）`
                      : ""
                    : `（不可用：${entry.problem?.message ?? "原因未知"}）`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <DirectoryTreeSelect
          roots={mountRoots}
          value={mountRootId ? { mountRootId, relativePath: directoryPath } : null}
          fetchChildren={fetchDirectories}
          disabled={busy}
          onSelect={(selection) => {
            if (selection) {
              setDatasetId("");
              setMountRootId(selection.mountRootId);
              setDirectoryPath(selection.relativePath);
            } else {
              setMountRootId("");
              setDirectoryPath("");
            }
          }}
        />

        {/* 开发模式下提供一键填入/恢复默认测试配置 */}
        {mode === "dev" && !busy ? (
          <button
            type="button"
            onClick={() => {
              setText(DEFAULT_REQUEST);
              setDatasetId("ds_dev_fixture");
              setMountRootId("");
              setDirectoryPath("");
            }}
            className="flex items-center gap-1 rounded-full border border-brand/30 bg-brand/10 px-2.5 py-0.5 text-xs font-medium text-brand hover:bg-brand/20 transition-all cursor-pointer shadow-2xs"
            title="一键填入开发模式默认测试需求与夹具数据集"
          >
            <IconSpark width={12} height={12} />
            <span>填入测试默认</span>
          </button>
        ) : null}
      </div>

      {selectedDataset ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono bg-muted/60 px-2 py-0.5 rounded text-[11px]">
            {selectedDataset.dataset_id}
          </span>
          {typeof selectedDataset.sn_count === "number" ? (
            <span>· {selectedDataset.sn_count} 个 SN</span>
          ) : null}
          {selectedDataset.writable_by_process ? (
            <span className="text-warn font-medium">· ⚠️ 挂载可写</span>
          ) : null}
        </div>
      ) : mountRootId ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono bg-brand/10 text-brand px-2 py-0.5 rounded text-[11px] border border-brand/20">
            {mountRootId}:{directoryPath || "."}
          </span>
          <span>· 服务器共享目录（只读探测）</span>
        </div>
      ) : null}
    </div>
  );

  const askRow = (
    <div className="flex w-full flex-wrap items-center gap-3">
      <span className="text-xs text-muted-foreground">任务运行中</span>
      <code className="rounded border border-border bg-muted/40 px-2 py-0.5 text-xs font-mono">
        {turns[0]?.datasetId ?? "—"}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="ml-auto gap-1.5 text-xs text-muted-foreground hover:text-foreground rounded-full cursor-pointer"
        onClick={startNewTask}
        disabled={busy}
      >
        <IconSpark width={14} height={14} />
        新建任务
      </Button>
    </div>
  );

  return (
    <div className="mx-auto flex min-h-[calc(100vh-7rem)] w-full max-w-3xl flex-col justify-between gap-6 pb-4">
      {/* 隐藏的文件输入组件，由输入框内的上传模板按钮触发 */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xlsm"
        onChange={handleFileUpload}
        className="hidden"
        aria-label="上传 Excel 模板"
      />

      <div className="flex flex-1 flex-col gap-8">
        {!started ? (
          <div className="flex flex-1 flex-col justify-center py-10 sm:py-20">
            {/* 硬件双边框主展示卡：纯净展示，已移除卡片内的按钮 */}
            <div className="relative rounded-[2rem] p-1.5 border border-border/80 bg-muted/20 backdrop-blur-xl shadow-lg">
              <div className="relative rounded-[calc(2rem-0.375rem)] border border-border/40 bg-card p-8 sm:p-14 overflow-hidden flex flex-col items-center text-center shadow-[inset_0_1px_1px_rgba(255,255,255,0.08)]">
                {/* 微妙背景光晕 */}
                <div className="pointer-events-none absolute -top-24 -left-24 size-64 rounded-full bg-brand/10 blur-3xl" />
                <div className="pointer-events-none absolute -bottom-24 -right-24 size-64 rounded-full bg-ok/10 blur-3xl" />

                {/* Eyebrow Tag */}
                <div className="inline-flex items-center gap-2 rounded-full border border-brand/30 bg-brand/10 px-3.5 py-1 text-[11px] font-semibold text-brand tracking-widest uppercase">
                  <span className="size-1.5 rounded-full bg-brand animate-pulse" />
                  <span>5-GATE 确定性安全执行引擎</span>
                </div>

                {/* 主标题 */}
                <h1 className="mt-5 text-2xl sm:text-3xl font-bold tracking-tight text-foreground">
                  自动化测试报告智能助理
                </h1>

                {/* 深度优化的描述语 */}
                <p className="mt-3.5 max-w-xl text-sm leading-relaxed text-muted-foreground">
                  基于测试规范与物理只读数据源，自动解析并对齐 XML 字段；受控于公式防覆写、Key 冲突等五重刚性门禁，零差错批量交付生产级 Excel 报表。
                </p>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* 顶栏：会话标识与标记卡片 */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/70 bg-card/60 px-4 py-2.5 backdrop-blur-xl shadow-xs">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="size-2 rounded-full bg-ok animate-pulse" />
                <span className="text-xs font-semibold text-foreground">会话</span>
                <code className="font-mono text-xs text-muted-foreground bg-muted/60 px-2 py-0.5 rounded border border-border/50">
                  {runId || state.runId}
                </code>
                {state.run?.tag ? (
                  <span className="rounded-full bg-brand/10 border border-brand/20 text-brand px-2.5 py-0.5 text-[11px] font-medium shrink-0">
                    🏷️ {state.run.tag}
                  </span>
                ) : selectedDataset ? (
                  <span className="rounded-full bg-brand/10 border border-brand/20 text-brand px-2.5 py-0.5 text-[11px] font-medium shrink-0">
                    🏷️ {selectedDataset.name.replace(/（.*）/, "").trim()}
                  </span>
                ) : null}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    const targetId = runId || state.runId;
                    if (!targetId) return;
                    const nextPinned = !isPinned;
                    setLocalPinned(nextPinned);
                    try {
                      await updateRun(targetId, { pinned: nextPinned });
                      if (state.run) state.run.pinned = nextPinned;
                    } catch {
                      setLocalPinned(!nextPinned);
                    }
                  }}
                  className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium border transition-all cursor-pointer ${
                    isPinned
                      ? "border-amber-500/40 bg-amber-500/15 text-amber-500 font-semibold"
                      : "border-border/70 bg-card text-muted-foreground hover:text-amber-500 hover:border-amber-500/30"
                  }`}
                  title={isPinned ? "取消会话标记" : "为当前会话添加标记"}
                >
                  <span>{isPinned ? "★ 已标记" : "☆ 添加标记"}</span>
                </button>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="gap-1 text-xs text-muted-foreground hover:text-foreground rounded-full cursor-pointer h-7"
                  onClick={startNewTask}
                  disabled={busy}
                >
                  <IconSpark width={12} height={12} />
                  <span>新建会话</span>
                </Button>
              </div>
            </div>

            {turns.map((turn, index) => (
              <section key={`${turn.at}-${index}`} className="flex flex-col gap-4">
                <UserTurn
                  prompt={turn.prompt}
                  chips={
                    index === 0 ? (
                      <code>{turn.datasetId ?? "—"}</code>
                    ) : null
                  }
                />
                <AssistantTurn turn={turn} phase={state.phase} busy={busy} />
              </section>
            ))}
          </>
        )}

        {state.reconnecting ? (
          <div className="flex items-center gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-600 dark:text-amber-400">
            <span className="relative flex size-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-amber-500" />
            </span>
            <span className="font-medium">实时连接暂时中断，正在自动尝试恢复与同步最新进度…</span>
          </div>
        ) : null}

        {state.error ? (
          <ErrorBox
            message={state.error}
            title="任务执行异常"
            onRetry={state.runId || selectedRunId ? () => void reconnect() : undefined}
            retryLabel="重新连接"
          />
        ) : null}

        {finished && runId ? (
          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span
                aria-hidden="true"
                className="grid size-7 shrink-0 place-items-center rounded-full border border-border bg-card text-ok"
              >
                <IconCheck width={14} height={14} strokeWidth={2.5} />
              </span>
              <span className="text-sm font-semibold">运行结果</span>
              <span className="text-xs text-muted-foreground">
                <code>{runId}</code>
              </span>
            </div>
            <RunResult
              runId={runId}
              run={state.run}
              phase={state.phase}
              checks={state.checks}
              devMode={mode === "dev"}
            />
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
        rows={started ? 2 : 4}
        placeholder={
          started
            ? "在当前任务上继续追问，如：将特定列留空，或调整输出指标..."
            : mode === "dev"
              ? "输入回填需求（开发模式已预置默认测试需求，直接发送即可运行）..."
              : "输入回填需求，如：模板 P 列匹配 task name，提取 ge/gr/te/nf 填入 F/H/J/L 列，一 SN 一文件"
        }
        submitLabel="发送"
        busyLabel={started ? "处理中…" : "执行中…"}
        top={started ? askRow : datasetRow}
        hint={HINT}
        note={null}
        templateInfo={templateInfo}
        uploadingTemplate={uploadingTemplate}
        onUploadTemplate={() => fileInputRef.current?.click()}
        onResetTemplate={handleResetTemplate}
        downloadTemplateUrl={templateDownloadUrl(mode, datasetId)}
      />
    </div>
  );
}
