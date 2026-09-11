/**
 * 助理汇报：把模型惯用的少量行内标记（`##` 标题、`**加粗**`、行内代码、列表、分割线）
 * 渲染成排版，其余按纯文本原样显示。全程用 React 节点拼装，不做 HTML 注入。
 */
import type { ReactNode } from "react";

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
        <code key={`${keyPrefix}-c${seq}`} className="rounded border border-border bg-muted px-1 py-0.5 text-[13px]">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      nodes.push(
        <strong key={`${keyPrefix}-b${seq}`} className="font-semibold">
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
        className: `text-sm font-semibold ${gap}`,
        content: inlineNodes(text.replace(/^#{1,6}\s+/, ""), key),
      });
    } else if (text.startsWith("|")) {
      blocks.push({
        key,
        className: `font-mono text-[13px] ${gap}`,
        content: inlineNodes(text, key),
      });
    } else if (/^[-*]\s+/.test(text)) {
      blocks.push({
        key,
        className: `flex gap-2 pl-1 ${gap}`,
        content: (
          <>
            <span aria-hidden="true" className="text-muted-foreground">
              ·
            </span>
            <span>{inlineNodes(text.replace(/^[-*]\s+/, ""), key)}</span>
          </>
        ),
      });
    } else {
      blocks.push({ key, className: `${gap}`, content: inlineNodes(text, key) });
    }

    blankBefore = false;
  });

  return blocks;
}

export function ReportPanel({ reply, busy }: { reply: string; busy: boolean }) {
  if (!reply) {
    return busy ? (
      <p className="text-sm text-muted-foreground">
        助理正在工作
        <Cursor />
      </p>
    ) : (
      <p className="text-xs text-muted-foreground">本次运行没有产生文字汇报。</p>
    );
  }

  const blocks = toBlocks(reply);
  if (busy && blocks.length > 0) {
    // 流式光标跟在最后一段文字后面。
    const last = blocks[blocks.length - 1];
    if (last) last.content = (
      <>
        {last.content}
        <Cursor />
      </>
    );
  }

  return (
    <div className="text-sm leading-7 break-words whitespace-pre-wrap">
      {blocks.map((block) => (
        <p key={block.key} className={block.className}>
          {block.content}
        </p>
      ))}
    </div>
  );
}
