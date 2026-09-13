/** 底部输入区（Composer）：双边框硬件架构 + 输入框内模板上传/管理 + 发送按钮。 */
import type { ReactNode } from "react";

import type { TemplateInfo } from "../types";
import {
  IconArrowRight,
  IconDownload,
  IconFileSpreadsheet,
  IconPaperclip,
  IconTrash,
} from "./icons";

export function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  canSend,
  busy,
  placeholder,
  submitLabel = "发送",
  busyLabel = "处理中…",
  top,
  hint,
  note,
  rows,
  templateInfo,
  uploadingTemplate,
  onUploadTemplate,
  onResetTemplate,
  downloadTemplateUrl,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** 输入框是否禁用（运行期间不可改）。 */
  disabled: boolean;
  /** 是否可提交。 */
  canSend: boolean;
  busy: boolean;
  placeholder: string;
  submitLabel?: string;
  busyLabel?: string;
  top?: ReactNode;
  hint?: ReactNode;
  note?: ReactNode;
  rows?: number;
  templateInfo?: TemplateInfo | null;
  uploadingTemplate?: boolean;
  onUploadTemplate?: () => void;
  onResetTemplate?: () => void;
  downloadTemplateUrl?: string;
}) {
  const send = () => {
    if (disabled || !canSend) return;
    onSubmit();
  };

  const hasTemplate = Boolean(templateInfo?.has_template);

  return (
    <div className="sticky bottom-0 z-20 bg-gradient-to-t from-background via-background/95 to-transparent pt-6 pb-4">
      {/* 双边框嵌套硬件结构 (Double-Bezel Architecture) */}
      <div className="rounded-[1.75rem] p-1.5 border border-border/70 bg-muted/20 backdrop-blur-xl shadow-lg transition-all duration-300 focus-within:border-brand/40 focus-within:ring-4 focus-within:ring-brand/10">
        <form
          className="flex flex-col rounded-[calc(1.75rem-0.375rem)] bg-card border border-border/40 overflow-hidden shadow-[inset_0_1px_1px_rgba(255,255,255,0.08)]"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          {/* 顶栏：数据源与环境指示 */}
          {top ? (
            <div className="flex w-full flex-wrap items-center justify-between gap-3 border-b border-border/60 bg-muted/20 px-4 py-2.5">
              {top}
            </div>
          ) : null}

          {/* 输入框内置模板附件条 */}
          {hasTemplate && templateInfo ? (
            <div className="flex items-center justify-between gap-3 border-b border-border/40 bg-card/40 px-4 py-2 text-xs">
              <div className="flex items-center gap-2 min-w-0">
                <IconFileSpreadsheet width={15} height={15} className="text-ok shrink-0" />
                <span className="font-medium text-foreground truncate max-w-44 sm:max-w-72" title={templateInfo.filename ?? "template.xlsx"}>
                  {templateInfo.filename ?? "template.xlsx"}
                </span>
                {templateInfo.size ? (
                  <span className="text-[11px] text-muted-foreground font-mono shrink-0">
                    ({(templateInfo.size / 1024).toFixed(1)} KB)
                  </span>
                ) : null}
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {downloadTemplateUrl ? (
                  <a
                    href={downloadTemplateUrl}
                    download={templateInfo.filename ?? "template.xlsx"}
                    className="flex size-6 items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                    title="下载当前模板"
                  >
                    <IconDownload width={13} height={13} />
                  </a>
                ) : null}
                {templateInfo.is_custom && onResetTemplate ? (
                  <button
                    type="button"
                    onClick={onResetTemplate}
                    disabled={disabled}
                    className="flex size-6 items-center justify-center rounded-md hover:bg-bad/10 text-muted-foreground hover:text-bad transition-colors cursor-pointer"
                    title="移除模板"
                  >
                    <IconTrash width={13} height={13} />
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          <textarea
            value={value}
            rows={rows ?? 3}
            placeholder={placeholder}
            aria-label={placeholder}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return;
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              event.preventDefault();
              send();
            }}
            className="max-h-64 min-h-[76px] w-full resize-y border-0 bg-transparent px-4 py-3 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/60 outline-none focus:ring-0"
          />

          {/* 底部工具栏：上传模板按钮 + 快捷提示 + 发送按钮 */}
          <div className="flex items-center justify-between gap-3 border-t border-border/40 bg-muted/10 px-4 py-2">
            <div className="flex items-center gap-2.5">
              {/* 输入框内置模板上传按钮 */}
              {onUploadTemplate ? (
                <button
                  type="button"
                  onClick={onUploadTemplate}
                  disabled={disabled || uploadingTemplate}
                  className="flex items-center gap-1.5 rounded-full border border-border/70 bg-card/80 px-3 py-1 text-xs font-medium text-muted-foreground transition-all duration-200 hover:border-brand/40 hover:bg-muted hover:text-foreground active:scale-95 cursor-pointer shadow-2xs"
                  title="上传或更换待回填的 Excel 模板 (.xlsx)"
                >
                  <IconPaperclip width={13} height={13} className="text-brand" />
                  <span>{uploadingTemplate ? "上传中…" : hasTemplate ? "更换模板" : "添加 Excel 模板"}</span>
                </button>
              ) : null}
              <span className="hidden text-xs text-muted-foreground/80 md:block">{hint}</span>
            </div>

            {/* 嵌套式胶囊发送按钮 (Button-in-Button Trailing Icon) */}
            <button
              type="submit"
              disabled={disabled || !canSend}
              className="group ml-auto flex items-center gap-2.5 rounded-full bg-primary px-5 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition-all duration-200 hover:opacity-95 active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
            >
              <span>{busy ? busyLabel : submitLabel}</span>
              <span className="flex size-5 items-center justify-center rounded-full bg-primary-foreground/15 text-primary-foreground transition-transform duration-200 group-hover:translate-x-0.5">
                {busy ? (
                  <span className="size-2.5 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
                ) : (
                  <IconArrowRight width={11} height={11} />
                )}
              </span>
            </button>
          </div>
        </form>
      </div>

      {note ? <p className="pt-2 text-center text-xs text-muted-foreground/70">{note}</p> : null}
    </div>
  );
}
