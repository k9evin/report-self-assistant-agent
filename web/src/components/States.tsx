/** 通用状态件：加载中 / 错误 / 空状态（Tailwind + 设计令牌，与 shadcn 组件共用同一套颜色）。 */
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

import { IconAlert } from "./icons";

export function LoadingDots({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2.5 text-xs text-muted-foreground" role="status" aria-live="polite">
      <span className="inline-flex gap-1" aria-hidden="true">
        <i className="size-1.5 animate-pulse rounded-full bg-foreground/40" />
        <i className="size-1.5 animate-pulse rounded-full bg-foreground/40 [animation-delay:150ms]" />
        <i className="size-1.5 animate-pulse rounded-full bg-foreground/40 [animation-delay:300ms]" />
      </span>
      <span>{label}</span>
    </div>
  );
}

export function ErrorBox({
  message,
  title = "出错了",
  onRetry,
  retryLabel = "重试",
}: {
  message: string;
  title?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div
      className="flex gap-2.5 rounded-md border border-bad/40 bg-bad/10 px-3.5 py-3 text-[13px] text-bad"
      role="alert"
    >
      <span className="mt-px flex-none" aria-hidden="true">
        <IconAlert width={16} height={16} />
      </span>
      <div className="min-w-0">
        <strong className="mb-0.5 block font-semibold">{title}</strong>
        <p className="break-words">{message}</p>
        {onRetry ? (
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onRetry}>
            {retryLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function EmptyState({
  eyebrow,
  title,
  subtitle,
  children,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  children?: ReactNode;
}) {
  return (
    <Card className="relative gap-0 overflow-hidden px-6 py-12 text-center shadow-none">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(rgb(26_115_232/0.14)_1px,transparent_1px)] bg-[size:22px_22px] [mask-image:linear-gradient(to_bottom,black,transparent_75%)]"
      />
      <div className="relative mx-auto flex max-w-[620px] flex-col items-center gap-2">
        {eyebrow ? <p className="text-xs font-semibold tracking-[0.08em] text-brand uppercase">{eyebrow}</p> : null}
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
        {children}
      </div>
    </Card>
  );
}
