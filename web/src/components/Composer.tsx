/** 底部输入区（Penguin WebUI 式的 composer）：上方运行配置行 + 无边框输入 + 提交行。 */
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  canSend,
  busy,
  placeholder,
  submitLabel,
  busyLabel,
  top,
  hint,
  note,
  rows,
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
  submitLabel: string;
  busyLabel: string;
  top?: ReactNode;
  hint: ReactNode;
  note: ReactNode;
  rows?: number;
}) {
  const send = () => {
    if (disabled || !canSend) return;
    onSubmit();
  };

  return (
    <div className="sticky bottom-0 z-10 bg-linear-to-b from-transparent to-background pt-6">
      <form
        className="flex flex-col rounded-xl border border-border bg-card transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        {top ? (
          <div className="flex w-full flex-wrap items-center gap-3 border-b border-border px-3.5 py-2.5">
            {top}
          </div>
        ) : null}

        <Textarea
          value={value}
          rows={rows}
          placeholder={placeholder}
          aria-label={placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            // 中文/日文/韩文输入法组字中，Enter 只是上屏，不能当发送。
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            send();
          }}
          className="max-h-64 min-h-[72px] resize-y border-0 bg-transparent px-3.5 py-3 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
        />

        <div className="flex items-center justify-between gap-3 px-3.5 pb-2.5">
          <span className="hidden text-xs text-muted-foreground sm:block">{hint}</span>
          <Button type="submit" size="lg" className="ml-auto h-10 rounded-lg px-5" disabled={disabled || !canSend}>
            {busy ? busyLabel : submitLabel}
          </Button>
        </div>
      </form>

      <p className="pt-2 text-center text-xs text-muted-foreground">{note}</p>
    </div>
  );
}
