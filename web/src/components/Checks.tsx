/** 用例断言结果：逐条 ✅ / ❌ + 总判定徽章。 */
import { cn } from "cn";

import type { Check } from "../types";
import { ResultBlock } from "./ResultBlock";
import { ToneBadge } from "./ToneBadge";
import { IconCheck, IconCross } from "./icons";

export function ChecksBlock({ checks, title = "校验结果" }: { checks: Check[]; title?: string }) {
  if (checks.length === 0) {
    return (
      <ResultBlock title={title}>
        <p className="text-[13px] text-muted-foreground">本次运行没有返回断言结果。</p>
      </ResultBlock>
    );
  }

  const failed = checks.filter((check) => !check.ok).length;

  return (
    <ResultBlock
      title={title}
      action={
        <ToneBadge tone={failed === 0 ? "success" : "danger"}>
          {failed === 0 ? "全部通过" : `有失败（${failed}/${checks.length}）`}
        </ToneBadge>
      }
    >
      <ul className="flex flex-col gap-2">
        {checks.map((check, index) => (
          <li key={`${check.name}-${index}`} className="flex items-start gap-2 text-[13px]">
            <span aria-hidden="true" className={cn("mt-0.5 flex-none", check.ok ? "text-ok" : "text-bad")}>
              {check.ok ? <IconCheck width={14} height={14} /> : <IconCross width={14} height={14} />}
            </span>
            <span className="flex min-w-0 flex-col">
              <span>
                {check.name}
                <span className="sr-only">{check.ok ? "：通过" : "：失败"}</span>
              </span>
              {check.detail ? (
                <span className="text-xs break-words text-muted-foreground">{check.detail}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </ResultBlock>
  );
}
