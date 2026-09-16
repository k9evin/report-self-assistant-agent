"use client";

import * as React from "react";
import {
  Bookmark,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import { cn } from "cn";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Dataset, DirectoryEntry, MountRoot } from "../types";

export interface DirectorySelection {
  datasetId?: string;
  mountRootId: string;
  relativePath: string;
  label: string;
}

interface ColumnState {
  path: string; // relativePath
  label: string;
  entries: DirectoryEntry[];
  loading: boolean;
  error: string | null;
}

export function DirectoryTreeSelect({
  roots,
  presets = [],
  value,
  fetchChildren,
  disabled,
  onSelect,
}: {
  roots: MountRoot[];
  presets?: Dataset[];
  value?: DirectorySelection | null;
  fetchChildren: (mountRootId: string, relativePath: string) => Promise<DirectoryEntry[]>;
  disabled?: boolean;
  onSelect: (selection: DirectorySelection | null) => void;
}) {
  const [open, setOpen] = React.useState(false);

  // 内部临时选中的状态
  const [selectedDatasetId, setSelectedDatasetId] = React.useState<string>("");
  const [selectedRootId, setSelectedRootId] = React.useState<string>("");
  const [selectedPath, setSelectedPath] = React.useState<string>("");
  const [selectedLabel, setSelectedLabel] = React.useState<string>("");

  // 当前激活/展开的挂载根与层级路径
  const [activeRootId, setActiveRootId] = React.useState<string>("");
  // 每一级展开的列数据
  const [columns, setColumns] = React.useState<ColumnState[]>([]);
  // 每一层当前高亮选中的相对路径
  const [activeSegmentPaths, setActiveSegmentPaths] = React.useState<string[]>([]);

  // 缓存已读取的目录内容
  const cacheRef = React.useRef<Map<string, DirectoryEntry[]>>(new Map());

  // 同步外部受控的 value
  React.useEffect(() => {
    if (value) {
      setSelectedDatasetId(value.datasetId ?? "");
      setSelectedRootId(value.mountRootId);
      setSelectedPath(value.relativePath);
      setSelectedLabel(value.label);
      if (value.mountRootId) {
        setActiveRootId(value.mountRootId);
      }
    } else {
      setSelectedDatasetId("");
      setSelectedRootId("");
      setSelectedPath("");
      setSelectedLabel("");
    }
  }, [value]);

  // 打开面板时，初始化根节点与第一层
  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      const rootToUse = selectedRootId || (roots.find((r) => r.available)?.mount_root_id ?? "");
      if (rootToUse) {
        selectRoot(rootToUse, false);
      }
    }
  };

  const selectRoot = (rootId: string, markSelected = true) => {
    setActiveRootId(rootId);
    if (markSelected) {
      setSelectedDatasetId("");
      setSelectedRootId(rootId);
      setSelectedPath("");
      const label = `[${rootId}] 根目录`;
      setSelectedLabel(label);
      onSelect({
        datasetId: "",
        mountRootId: rootId,
        relativePath: "",
        label,
      });
    }
    setActiveSegmentPaths([]);

    const rootObj = roots.find((r) => r.mount_root_id === rootId);
    const initialEntries = rootObj?.directories ?? [];
    if (initialEntries.length > 0) {
      cacheRef.current.set(`${rootId}:`, initialEntries);
    }

    setColumns([
      {
        path: "",
        label: rootId,
        entries: initialEntries,
        loading: false,
        error: null,
      },
    ]);

    if (initialEntries.length === 0 && rootObj?.available) {
      void loadLevel(rootId, "", 0);
    }
  };

  const loadLevel = async (rootId: string, relativePath: string, columnIndex: number) => {
    const cacheKey = `${rootId}:${relativePath}`;
    if (cacheRef.current.has(cacheKey)) {
      const cached = cacheRef.current.get(cacheKey)!;
      setColumns((prev) => {
        const next = prev.slice(0, columnIndex + 1);
        next[columnIndex] = {
          path: relativePath,
          label: relativePath.split("/").pop() || rootId,
          entries: cached,
          loading: false,
          error: null,
        };
        return next;
      });
      return;
    }

    setColumns((prev) => {
      const next = prev.slice(0, columnIndex + 1);
      next[columnIndex] = {
        path: relativePath,
        label: relativePath.split("/").pop() || rootId,
        entries: [],
        loading: true,
        error: null,
      };
      return next;
    });

    try {
      const children = await fetchChildren(rootId, relativePath);
      cacheRef.current.set(cacheKey, children);
      setColumns((prev) => {
        const next = [...prev];
        if (next[columnIndex]) {
          next[columnIndex] = {
            ...next[columnIndex],
            entries: children,
            loading: false,
            error: null,
          };
        }
        return next;
      });
    } catch (err) {
      setColumns((prev) => {
        const next = [...prev];
        if (next[columnIndex]) {
          next[columnIndex] = {
            ...next[columnIndex],
            loading: false,
            error: err instanceof Error ? err.message : "加载目录失败",
          };
        }
        return next;
      });
    }
  };

  const handleEntryClick = (entry: DirectoryEntry, columnIndex: number) => {
    const nextActive = [...activeSegmentPaths.slice(0, columnIndex), entry.relative_path];
    setActiveSegmentPaths(nextActive);

    // 点中目录即代表选中，无需多余确认
    const label = `[${activeRootId}] /${entry.relative_path}`;
    setSelectedDatasetId("");
    setSelectedRootId(activeRootId);
    setSelectedPath(entry.relative_path);
    setSelectedLabel(label);
    onSelect({
      datasetId: "",
      mountRootId: activeRootId,
      relativePath: entry.relative_path,
      label,
    });

    const nextColIndex = columnIndex + 1;
    setColumns((prev) => prev.slice(0, nextColIndex));
    void loadLevel(activeRootId, entry.relative_path, nextColIndex);
  };

  const handleChoosePreset = (preset: Dataset) => {
    setSelectedDatasetId(preset.dataset_id);
    setSelectedRootId(preset.mount_root_id ?? "");
    setSelectedPath(preset.relative_path ?? "");
    setSelectedLabel(preset.name);
    onSelect({
      datasetId: preset.dataset_id,
      mountRootId: preset.mount_root_id ?? "",
      relativePath: preset.relative_path ?? "",
      label: preset.name,
    });
    setOpen(false);
  };

  const handleClear = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setSelectedDatasetId("");
    setSelectedRootId("");
    setSelectedPath("");
    setSelectedLabel("");
    onSelect(null);
  };

  // 格式化当前展示的触发按钮文案
  const displayLabel = value?.label
    ? value.label
    : value?.mountRootId
      ? `[${value.mountRootId}] ${value.relativePath ? `/${value.relativePath}` : "（根目录）"}`
      : selectedLabel
        ? selectedLabel
        : selectedRootId
          ? `[${selectedRootId}] ${selectedPath ? `/${selectedPath}` : "（根目录）"}`
          : null;

  // 面包屑分段
  const breadcrumbs: { label: string; onClick: () => void }[] = [];
  if (activeRootId) {
    breadcrumbs.push({
      label: activeRootId,
      onClick: () => {
        setActiveSegmentPaths([]);
        setColumns((prev) => prev.slice(0, 1));
        const label = `[${activeRootId}] 根目录`;
        setSelectedDatasetId("");
        setSelectedRootId(activeRootId);
        setSelectedPath("");
        setSelectedLabel(label);
        onSelect({
          datasetId: "",
          mountRootId: activeRootId,
          relativePath: "",
          label,
        });
      },
    });
    activeSegmentPaths.forEach((path, idx) => {
      const name = path.split("/").pop() || path;
      breadcrumbs.push({
        label: name,
        onClick: () => {
          setActiveSegmentPaths(activeSegmentPaths.slice(0, idx + 1));
          setColumns((prev) => prev.slice(0, idx + 2));
          const label = `[${activeRootId}] /${path}`;
          setSelectedDatasetId("");
          setSelectedRootId(activeRootId);
          setSelectedPath(path);
          setSelectedLabel(label);
          onSelect({
            datasetId: "",
            mountRootId: activeRootId,
            relativePath: path,
            label,
          });
        },
      });
    });
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "group relative flex h-8 min-w-56 max-w-80 items-center justify-between gap-1.5 rounded-lg border border-border bg-card px-2.5 text-xs text-foreground shadow-2xs transition-all hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            displayLabel && "border-brand/40 bg-brand/5 text-brand font-medium"
          )}
          title={displayLabel ? `已选目标：${displayLabel}` : presets.length > 0 ? "选择目标数据集或服务器挂载目录" : "选择服务器挂载目录"}
        >
          <div className="flex items-center gap-1.5 truncate">
            {value?.datasetId || selectedDatasetId ? (
              <Bookmark className="size-3.5 shrink-0 text-brand" />
            ) : (
              <HardDrive className="size-3.5 shrink-0 opacity-70" />
            )}
            <span className="truncate">{displayLabel || (presets.length > 0 ? "选择目标数据集 / 服务器目录" : "选择服务器挂载目录")}</span>
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            {displayLabel && !disabled ? (
              <span
                role="button"
                tabIndex={0}
                onClick={handleClear}
                className="rounded p-0.5 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                title="清除已选"
              >
                <X className="size-3" />
              </span>
            ) : null}
            <ChevronDown className="size-3.5 text-muted-foreground opacity-60" />
          </div>
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={6}
        collisionPadding={16}
        className="w-[min(44rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] p-0 overflow-hidden shadow-2xl"
      >
        {/* 顶部标题与面包屑导航 */}
        <div className="flex flex-col gap-1.5 border-b border-border bg-muted/30 px-3.5 py-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <FolderOpen className="size-4 text-brand" />
              <span>{presets.length > 0 ? "目标数据集与服务器目录级联选择器" : "服务器挂载目录级联选择器"}</span>
            </div>
            <span className="text-[11px] text-muted-foreground">
              {presets.length > 0
                ? "支持预设快捷数据集，也可按挂载逐级展开选用"
                : "请在左侧选择挂载共享，逐级展开并点击「选择」确定目标目录"}
            </span>
          </div>

          {/* 面包屑 */}
          <div className="flex items-center gap-1 text-xs text-muted-foreground overflow-x-auto py-0.5">
            <span className="text-[11px] font-medium text-foreground/70 shrink-0">当前浏览:</span>
            {breadcrumbs.length === 0 ? (
              <span className="text-muted-foreground/60 italic">（请在左侧选择挂载共享）</span>
            ) : (
              breadcrumbs.map((crumb, i) => (
                <React.Fragment key={`${crumb.label}-${i}`}>
                  {i > 0 && <span className="opacity-40">/</span>}
                  <button
                    type="button"
                    onClick={crumb.onClick}
                    className="hover:text-brand hover:underline font-mono text-[11px] truncate max-w-36"
                  >
                    {crumb.label}
                  </button>
                </React.Fragment>
              ))
            )}
          </div>
        </div>

        {/* 级联分栏主体（Miller Columns） */}
        <div className="flex divide-x divide-border overflow-x-auto h-72 bg-card">
          {/* 第 0 列：预设数据集 + 挂载根 */}
          <div className="flex flex-col w-52 shrink-0">
            <div className="flex-1 overflow-y-auto p-1 space-y-2">
              {/* 预设数据集区域 */}
              {presets.length > 0 ? (
                <div>
                  <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground tracking-wider uppercase">
                    预置数据集
                  </div>
                  <div className="space-y-0.5">
                    {presets.map((preset) => {
                      const isSelected = selectedDatasetId === preset.dataset_id;

                      return (
                        <div
                          key={preset.dataset_id}
                          onClick={() => preset.available && handleChoosePreset(preset)}
                          className={cn(
                            "group flex items-center justify-between rounded-md px-2 py-1.5 text-xs transition-colors cursor-pointer",
                            !preset.available && "opacity-50 cursor-not-allowed",
                            isSelected
                              ? "bg-brand/15 text-brand font-medium border border-brand/30"
                              : "hover:bg-muted/60 text-muted-foreground hover:text-foreground"
                          )}
                          title={preset.available ? preset.name : `不可用：${preset.problem?.message ?? ""}`}
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            <Bookmark className="size-3.5 shrink-0 text-brand" />
                            <span className="truncate text-[11px]">{preset.name}</span>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {isSelected ? (
                              <Check className="size-3 text-brand" />
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {/* 服务器挂载根区域 */}
              <div>
                <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground tracking-wider uppercase">
                  服务器挂载根 / 共享
                </div>
                <div className="space-y-0.5">
                  {roots.length === 0 ? (
                    <div className="p-2 text-center text-xs text-muted-foreground">暂无挂载</div>
                  ) : (
                    roots.map((root) => {
                      const isActive = activeRootId === root.mount_root_id;
                      const isSelected =
                        !selectedDatasetId &&
                        selectedRootId === root.mount_root_id &&
                        selectedPath === "";

                      return (
                        <div
                          key={root.mount_root_id}
                          onClick={() => root.available && selectRoot(root.mount_root_id, true)}
                          className={cn(
                            "group flex items-center justify-between rounded-md px-2 py-1.5 text-xs transition-colors cursor-pointer",
                            !root.available && "opacity-50 cursor-not-allowed",
                            isSelected
                              ? "bg-brand/15 text-brand font-medium border border-brand/30"
                              : isActive
                                ? "bg-muted font-medium text-foreground"
                                : "hover:bg-muted/60 text-muted-foreground hover:text-foreground"
                          )}
                          title={root.available ? `选用 [${root.mount_root_id}] 根目录` : "挂载不可用"}
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            <HardDrive className={cn("size-3.5 shrink-0", isSelected ? "text-brand" : "text-muted-foreground")} />
                            <span className="truncate font-mono text-[11px]">{root.mount_root_id}</span>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {!root.available ? (
                              <span className="text-[10px] text-destructive">不可用</span>
                            ) : isSelected ? (
                              <Check className="size-3 text-brand" />
                            ) : null}
                            <ChevronRight className="size-3.5 text-muted-foreground/60" />
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* 后续列：各级子目录 (Level 1, 2, ...) */}
          {columns.map((col, colIndex) => {
            const activePathForThisCol = activeSegmentPaths[colIndex];

            return (
              <div key={`${col.path}-${colIndex}`} className="flex flex-col w-52 shrink-0">
                <div className="flex items-center justify-between border-b border-border bg-muted/20 px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">
                  <span className="truncate font-mono">{col.label || "子目录"}</span>
                  {col.loading ? <Loader2 className="size-3 animate-spin text-brand" /> : null}
                </div>

                <div className="flex-1 overflow-y-auto p-1 space-y-0.5">
                  {col.loading ? (
                    <div className="flex items-center justify-center gap-1.5 p-6 text-xs text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin text-brand" />
                      <span>读取目录中…</span>
                    </div>
                  ) : col.error ? (
                    <div className="p-3 text-center text-xs text-destructive flex flex-col items-center gap-1.5">
                      <span>{col.error}</span>
                      <button
                        type="button"
                        onClick={() => void loadLevel(activeRootId, col.path, colIndex)}
                        className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
                      >
                        <RefreshCw className="size-3" /> 重试
                      </button>
                    </div>
                  ) : col.entries.length === 0 ? (
                    <div className="p-4 text-center text-xs text-muted-foreground flex flex-col items-center gap-1.5">
                      <FolderOpen className="size-4 text-muted-foreground/40 mb-1" />
                      <span>无子目录</span>
                      <span className="text-[11px] font-medium text-brand">已选当前目录</span>
                    </div>
                  ) : (
                    col.entries.map((entry) => {
                      const isActive = activePathForThisCol === entry.relative_path;
                      const isSelected =
                        !selectedDatasetId &&
                        selectedRootId === activeRootId &&
                        selectedPath === entry.relative_path;

                      return (
                        <div
                          key={entry.relative_path}
                          onClick={() => handleEntryClick(entry, colIndex)}
                          className={cn(
                            "group flex items-center justify-between rounded-md px-2 py-1.5 text-xs transition-colors cursor-pointer",
                            isSelected
                              ? "bg-brand/15 text-brand font-medium border border-brand/30"
                              : isActive
                                ? "bg-muted font-medium text-foreground"
                                : "hover:bg-muted/60 text-muted-foreground hover:text-foreground"
                          )}
                          title={`选中目录: ${entry.name}`}
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            <Folder
                              className={cn(
                                "size-3.5 shrink-0",
                                isSelected || isActive ? "text-brand" : "text-muted-foreground"
                              )}
                            />
                            <span className="truncate font-mono text-[11px]">{entry.name}</span>
                          </div>

                          <div className="flex items-center gap-1 shrink-0">
                            {isSelected ? <Check className="size-3 text-brand" /> : null}
                            <ChevronRight className="size-3.5 text-muted-foreground/60" />
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* 底部控制栏 */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/20 px-3.5 py-2.5">
          <div className="flex items-center gap-2 text-xs truncate max-w-[75%]">
            <span className="font-semibold text-foreground shrink-0">当前选中:</span>
            {selectedLabel || selectedRootId ? (
              <span className="font-mono text-brand font-medium truncate bg-brand/10 px-2 py-0.5 rounded border border-brand/20">
                {selectedLabel || `[${selectedRootId}] ${selectedPath ? `/${selectedPath}` : "（根目录）"}`}
              </span>
            ) : (
              <span className="text-muted-foreground italic">
                {presets.length > 0 ? "未选择任何数据集或目录" : "未选择任何挂载目录"}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {selectedRootId || selectedDatasetId ? (
              <button
                type="button"
                onClick={handleClear}
                className="rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-all"
              >
                清除
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="flex items-center gap-1 rounded-lg bg-brand px-3.5 py-1 text-xs font-semibold text-brand-foreground shadow-2xs hover:bg-brand/90 transition-all"
            >
              完成
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
