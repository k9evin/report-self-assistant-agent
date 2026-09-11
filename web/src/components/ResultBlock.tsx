/** 结果区的小节：分隔线 + 标题（可带右侧动作），结果区各块共用。 */
import type { ReactNode } from "react";

import { cn } from "cn";

export function ResultBlock({
  title,
  children,
  action,
  className,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mt-4 border-t border-border pt-4", className)}>
      {action ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h4 className="text-sm font-semibold">{title}</h4>
          {action}
        </div>
      ) : (
        <h4 className="mb-3 text-sm font-semibold">{title}</h4>
      )}
      {children}
    </section>
  );
}
