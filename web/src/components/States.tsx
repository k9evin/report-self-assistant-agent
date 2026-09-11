/** 通用状态件：加载中 / 错误 / 空状态 / 状态药丸 / 折叠块。 */
import type { ReactNode } from "react";
import { useState } from "react";

import type { StatusTone } from "../labels";
import { IconAlert, IconChevron } from "./icons";

export function LoadingDots({ label }: { label: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="muted">{label}</span>
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
    <div className="error-box" role="alert">
      <span className="error-icon" aria-hidden="true">
        <IconAlert width={16} height={16} />
      </span>
      <div className="error-body">
        <strong>{title}</strong>
        <p>{message}</p>
        {onRetry ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
            {retryLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function StatusPill({
  tone,
  children,
  title,
}: {
  tone: StatusTone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`pill pill-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Collapsible({
  title,
  hint,
  children,
  defaultOpen = false,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="collapse">
      <button
        type="button"
        className="collapse-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`chevron ${open ? "chevron-open" : ""}`} aria-hidden="true">
          <IconChevron width={16} height={16} />
        </span>
        <span className="collapse-title">{title}</span>
        {hint ? <span className="caption">{hint}</span> : null}
      </button>
      {open ? <div className="collapse-body">{children}</div> : null}
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
    <div className="empty">
      <div className="empty-grid" aria-hidden="true" />
      <div className="empty-content">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h2>{title}</h2>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
        {children}
      </div>
    </div>
  );
}
