/** 状态药丸：把 labels 的 StatusTone 映射到 shadcn Badge 的配色（对话流与结果区共用同一份映射）。 */
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "cn";

import type { StatusTone } from "../labels";

export const TONE_BADGE: Record<StatusTone, string> = {
  success: "border-ok/40 bg-ok/10 text-ok",
  warning: "border-warn/40 bg-warn/10 text-warn",
  danger: "border-bad/40 bg-bad/10 text-bad",
  neutral: "border-border bg-muted text-muted-foreground",
};

export function ToneBadge({
  tone,
  children,
  title,
  className,
}: {
  tone: StatusTone;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <Badge variant="outline" title={title} className={cn("rounded-full", TONE_BADGE[tone], className)}>
      {children}
    </Badge>
  );
}
