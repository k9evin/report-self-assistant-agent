/** 执行步骤时间线：tool_start / tool_end 的中文呈现（对话「执行过程」的展开内容）。 */
import { cn } from "cn";

import { toolLabel } from "../labels";
import type { ToolCall } from "../types";
import { IconCheck, IconCross } from "./icons";

function formatTime(at: string | undefined): string | null {
  if (!at) return null;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

export function ToolTimeline({ tools, busy }: { tools: ToolCall[]; busy: boolean }) {
  if (tools.length === 0) {
    return (
      <p className="py-2 text-xs text-muted-foreground">
        {busy ? "正在准备第一步…" : "还没有工具调用记录。"}
      </p>
    );
  }

  return (
    <ol className="flex flex-col">
      {tools.map((tool, index) => {
        const pending = tool.ok === undefined;
        const tone = pending ? "pending" : tool.ok ? "ok" : "fail";
        const time = formatTime(tool.at);
        return (
          <li
            key={`${tool.name}-${tool.at ?? index}`}
            className="flex gap-2.5 border-b border-border py-2 last:border-b-0"
          >
            <span
              aria-hidden="true"
              className={cn(
                "mt-0.5 grid size-[18px] shrink-0 place-items-center rounded-full",
                tone === "ok" && "text-ok",
                tone === "fail" && "text-bad",
                tone === "pending" && "text-muted-foreground",
              )}
            >
              {tone === "pending" ? (
                <span className="size-3 animate-spin rounded-full border-[1.5px] border-input border-t-brand" />
              ) : tone === "ok" ? (
                <IconCheck width={12} height={12} />
              ) : (
                <IconCross width={12} height={12} />
              )}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-sm">{toolLabel(tool.name)}</span>
              <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <code>{tool.name}</code>
                {time ? <span>· {time}</span> : null}
                {pending ? (
                  <span>· 进行中</span>
                ) : tool.ok === false ? (
                  <span className="text-bad">· 失败</span>
                ) : null}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
