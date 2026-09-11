/** 用例断言结果：逐条 ✅ / ❌ + 总判定徽章。 */
import type { Check } from "../types";
import { IconCheck, IconCross } from "./icons";
import { StatusPill } from "./States";

export function ChecksBlock({ checks, title = "校验结果" }: { checks: Check[]; title?: string }) {
  if (checks.length === 0) {
    return (
      <section className="result-block">
        <h4>{title}</h4>
        <p className="muted small">本次运行没有返回断言结果。</p>
      </section>
    );
  }

  const failed = checks.filter((check) => !check.ok).length;

  return (
    <section className="result-block">
      <div className="block-head">
        <h4>{title}</h4>
        <StatusPill tone={failed === 0 ? "success" : "danger"}>
          {failed === 0 ? "全部通过" : `有失败（${failed}/${checks.length}）`}
        </StatusPill>
      </div>
      <ul className="check-list">
        {checks.map((check, index) => (
          <li key={`${check.name}-${index}`} className={check.ok ? "check-ok" : "check-fail"}>
            <span className="check-icon" aria-hidden="true">
              {check.ok ? <IconCheck width={14} height={14} /> : <IconCross width={14} height={14} />}
            </span>
            <span className="check-main">
              <span className="check-name">
                {check.name}
                <span className="sr-only">{check.ok ? "：通过" : "：失败"}</span>
              </span>
              {check.detail ? <span className="check-detail caption">{check.detail}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
