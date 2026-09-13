/** 执行步骤时间线：展示工具调用的中文解释与状态。 */
import { cn } from "cn";

import { toolLabel } from "../labels";
import type { ToolCall } from "../types";
import { IconCheck, IconCross, IconTerminal } from "./icons";

const TOOL_DESCRIPTIONS: Record<string, string> = {
  inspect_template: "分析 Excel 模板结构、表头与可用列",
  inspect_xml_schema: "采样并探测只读测试数据源中的 XML 结构与测试项",
  submit_resolved_plan: "基于探测证据提交结构化回填计划（ResolvedPlan）",
  validate_report_plan: "执行五道 Gate 门禁校验（防公式覆盖、验证键匹配）",
  execute_validated_plan: "通过安全门禁，执行批量回填并进行回读校验",
  get_task_status: "汇总执行产物数量与完成状态",
};

function formatTime(at: string | undefined): string | null {
  if (!at) return null;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

export function ToolTimeline({ tools, busy }: { tools: ToolCall[]; busy: boolean }) {
  if (tools.length === 0) {
    return (
      <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
        <IconTerminal width={14} height={14} className="text-brand" />
        <span>{busy ? "助理正在准备第一步操作…" : "还没有工具调用记录。"}</span>
      </div>
    );
  }

  return (
    <ol className="flex flex-col">
      {tools.map((tool, index) => {
        const pending = tool.ok === undefined;
        const tone = pending ? "pending" : tool.ok ? "ok" : "fail";
        const time = formatTime(tool.at);
        const description = TOOL_DESCRIPTIONS[tool.name];

        return (
          <li
            key={`${tool.name}-${tool.at ?? index}`}
            className="flex gap-3 border-b border-border py-2.5 last:border-b-0"
          >
            <span
              aria-hidden="true"
              className={cn(
                "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-xs transition-all",
                tone === "ok" && "bg-ok/10 text-ok ring-1 ring-ok/30",
                tone === "fail" && "bg-bad/10 text-bad ring-1 ring-bad/30",
                tone === "pending" && "bg-muted text-muted-foreground",
              )}
            >
              {tone === "pending" ? (
                <span className="size-3 animate-spin rounded-full border-[1.5px] border-input border-t-brand" />
              ) : tone === "ok" ? (
                <IconCheck width={12} height={12} strokeWidth={2.5} />
              ) : (
                <IconCross width={12} height={12} strokeWidth={2.5} />
              )}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[13px] font-medium text-foreground">
                  {toolLabel(tool.name)}
                </span>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <code>{tool.name}</code>
                  {time ? <span>· {time}</span> : null}
                  {pending ? (
                    <span className="font-medium text-brand">· 执行中</span>
                  ) : tool.ok === false ? (
                    <span className="font-medium text-bad">· 失败</span>
                  ) : null}
                </div>
              </div>
              {description ? (
                <span className="text-xs text-muted-foreground">{description}</span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
