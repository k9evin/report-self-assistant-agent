/**
 * 助理汇报：把模型惯用的少量行内标记（`##` 标题、`**加粗**`、行内代码、列表、分割线）
 * 渲染成高可读性排版，并支持一键复制汇报。全程用 React 节点拼装，不做 HTML 注入。
 */
import type { ReactNode } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { IconCheck, IconCopy } from "./icons";

function Cursor() {
  return (
    <span
      aria-hidden="true"
      className="ml-0.5 inline-block h-[15px] w-[7px] translate-y-[2px] animate-pulse bg-brand"
    />
  );
}

/** 行内标记：反引号代码、**加粗**。 */
function inlineNodes(line: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let seq = 0;

  while ((match = pattern.exec(line)) !== null) {
    if (match.index > cursor) nodes.push(line.slice(cursor, match.index));
    const token = match[0];
    seq += 1;
    if (token.startsWith("`")) {
      nodes.push(
        <code key={`${keyPrefix}-c${seq}`} className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[12px] text-foreground">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      nodes.push(
        <strong key={`${keyPrefix}-b${seq}`} className="font-semibold text-foreground">
          {token.slice(2, -2)}
        </strong>,
      );
    }
    cursor = match.index + token.length;
  }

  if (cursor < line.length) nodes.push(line.slice(cursor));
  return nodes;
}

interface Block {
  key: string;
  className: string;
  content: ReactNode;
}

/** 逐行排版：空行分段，`##` 作小标题，`-`/`*` 作无序列表，`---` 作分割线，`|` 表格行用等宽字。 */
function toBlocks(reply: string): Block[] {
  const blocks: Block[] = [];
  let blankBefore = true;
  let seq = 0;

  reply.split("\n").forEach((line) => {
    const text = line.trim();
    if (!text) {
      blankBefore = true;
      return;
    }
    // Markdown 表格的分隔行（|---|---|）只是排版噪声，丢掉；`---` 分割线仍照常渲染。
    if (text.includes("|") && text.includes("-") && /^[\s|:-]+$/.test(text)) {
      return;
    }

    seq += 1;
    const key = `l${seq}`;
    const gap = blocks.length === 0 ? "" : blankBefore ? "mt-3" : "mt-1";

    if (/^-{3,}$/.test(text)) {
      blocks.push({ key, className: "my-3 border-t border-border", content: null });
    } else if (/^#{1,6}\s+/.test(text)) {
      blocks.push({
        key,
        className: `text-sm font-semibold text-foreground ${gap}`,
        content: inlineNodes(text.replace(/^#{1,6}\s+/, ""), key),
      });
    } else if (text.startsWith("|")) {
      blocks.push({
        key,
        className: `font-mono text-[13px] bg-muted/40 px-2 py-0.5 rounded ${gap}`,
        content: inlineNodes(text, key),
      });
    } else if (/^[-*]\s+/.test(text)) {
      blocks.push({
        key,
        className: `flex items-start gap-2 pl-1 text-[13px] leading-6 ${gap}`,
        content: (
          <>
            <span aria-hidden="true" className="select-none text-brand font-bold">
              •
            </span>
            <span>{inlineNodes(text.replace(/^[-*]\s+/, ""), key)}</span>
          </>
        ),
      });
    } else {
      blocks.push({ key, className: `text-[13px] leading-6 text-foreground/90 ${gap}`, content: inlineNodes(text, key) });
    }

    blankBefore = false;
  });

  return blocks;
}

export function ReportPanel({ reply, busy }: { reply: string; busy: boolean }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    if (!reply) return;
    void navigator.clipboard.writeText(reply).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (!reply) {
    return busy ? (
      <div className="flex items-center gap-2 rounded-lg border border-border/80 bg-card p-4 text-sm text-muted-foreground">
        <span>助理正在分析需求并生成执行报告</span>
        <Cursor />
      </div>
    ) : (
      <p className="text-xs text-muted-foreground">本次运行没有产生文字汇报。</p>
    );
  }

  const blocks = toBlocks(reply);
  if (busy && blocks.length > 0) {
    const last = blocks[blocks.length - 1];
    if (last) {
      last.content = (
        <>
          {last.content}
          <Cursor />
        </>
      );
    }
  }

  return (
    <div className="group relative rounded-lg border border-border bg-card p-4 shadow-xs">
      <div className="mb-2 flex items-center justify-end border-b border-border/40 pb-1.5">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={copy}
          title="复制汇报内容"
        >
          {copied ? (
            <>
              <IconCheck width={12} height={12} className="text-ok" />
              <span className="text-ok">已复制</span>
            </>
          ) : (
            <>
              <IconCopy width={12} height={12} />
              <span>复制</span>
            </>
          )}
        </Button>
      </div>
      <div className="text-[13px] leading-relaxed break-words whitespace-pre-wrap">
        {blocks.map((block) => (
          <div key={block.key} className={block.className}>
            {block.content}
          </div>
        ))}
      </div>
    </div>
  );
}
