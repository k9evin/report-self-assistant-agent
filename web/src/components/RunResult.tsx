/** 结果区：状态药丸、五道 Gate、错误/警告、产物、计划与验证 JSON。 */
import { outputFileUrl } from "../api";
import { GATE_ORDER, gateLabel, issueDetail, phaseLabel, phaseTone } from "../labels";
import type { Check, GateValue, RunView, ValidationIssue } from "../types";
import { ChecksBlock } from "./Checks";
import { IconCheck, IconCross, IconDash, IconDownload } from "./icons";
import { Collapsible, StatusPill } from "./States";

const GATE_TEXT: Record<GateValue, string> = {
  pass: "通过",
  fail: "失败",
  not_executed: "未执行",
};

function GateMark({ value }: { value: GateValue }) {
  if (value === "pass") {
    return (
      <span className="gate-value gate-pass">
        <IconCheck width={14} height={14} aria-hidden="true" /> {GATE_TEXT.pass}
      </span>
    );
  }
  if (value === "fail") {
    return (
      <span className="gate-value gate-fail">
        <IconCross width={14} height={14} aria-hidden="true" /> {GATE_TEXT.fail}
      </span>
    );
  }
  return (
    <span className="gate-value gate-skip">
      <IconDash width={14} height={14} aria-hidden="true" /> {GATE_TEXT.not_executed}
    </span>
  );
}

function IssueList({ title, issues }: { title: string; issues: ValidationIssue[] }) {
  return (
    <div className="issue-group">
      <span className="caption">{title}</span>
      {issues.length === 0 ? (
        <p className="muted small">无</p>
      ) : (
        <ul className="issue-list">
          {issues.map((issue, index) => (
            <li key={`${issue.code ?? "issue"}-${index}`}>
              {issue.code ? <code className="code-chip">{issue.code}</code> : null}
              <span>{issueDetail(issue)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function JsonViewer({ title, value }: { title: string; value: unknown }) {
  const empty = value === null || value === undefined;
  return (
    <Collapsible title={title} hint={empty ? "未产出" : undefined}>
      {empty ? (
        <p className="muted small">本次运行没有产出这份 JSON。</p>
      ) : (
        <pre className="code-block">{JSON.stringify(value, null, 2)}</pre>
      )}
    </Collapsible>
  );
}

function formatDuration(run: RunView): string | null {
  if (typeof run.duration_ms !== "number") return null;
  const seconds = run.duration_ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${Math.round(seconds - minutes * 60)} 秒`;
}

export function RunResult({
  runId,
  run,
  phase,
  checks,
}: {
  runId: string;
  run: RunView | null;
  phase: string | null;
  checks: Check[];
}) {
  const validation = run?.validation ?? null;
  const gates = validation?.gates ?? {};
  const errors = Array.isArray(validation?.errors) ? validation.errors : [];
  const warnings = Array.isArray(validation?.warnings) ? validation.warnings : [];
  const extraGates = Object.keys(gates).filter(
    (key) => !(GATE_ORDER as readonly string[]).includes(key),
  );
  const outputs = run?.outputs ?? null;
  const files = Array.isArray(run?.output_files) ? run.output_files : [];
  const duration = run ? formatDuration(run) : null;
  const finalPhase = run?.phase ?? phase;

  return (
    <section className="card result" aria-label="运行结果">
      <div className="block-head">
        <h3>运行结果</h3>
        <div className="result-meta">
          <StatusPill tone={phaseTone(finalPhase)}>{phaseLabel(finalPhase)}</StatusPill>
          {duration ? <span className="caption">{duration}</span> : null}
        </div>
      </div>

      <dl className="meta-grid">
        <div>
          <dt>运行 ID</dt>
          <dd>
            <code>{runId}</code>
          </dd>
        </div>
        {run?.task_id ? (
          <div>
            <dt>任务 ID</dt>
            <dd>
              <code>{run.task_id}</code>
            </dd>
          </div>
        ) : null}
        {run?.dataset_id ? (
          <div>
            <dt>数据集</dt>
            <dd>
              <code>{run.dataset_id}</code>
            </dd>
          </div>
        ) : null}
      </dl>

      <section className="result-block">
        <h4>五道 Gate</h4>
        <table className="gate-table">
          <thead>
            <tr>
              <th scope="col">Gate</th>
              <th scope="col">结果</th>
            </tr>
          </thead>
          <tbody>
            {[...GATE_ORDER, ...extraGates].map((key) => {
              const value: GateValue = gates[key] ?? "not_executed";
              return (
                <tr key={key}>
                  <th scope="row">
                    <span className="gate-name">{gateLabel(key)}</span>
                    <code className="caption">{key}</code>
                  </th>
                  <td>
                    <GateMark value={value} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {validation === null ? (
          <p className="muted small">本次运行没有产出验证 JSON，Gate 一律显示为未执行。</p>
        ) : null}
      </section>

      <section className="result-block">
        <h4>错误与警告</h4>
        <div className="issue-grid">
          <IssueList title="错误（errors）" issues={errors} />
          <IssueList title="警告（warnings）" issues={warnings} />
        </div>
      </section>

      <section className="result-block">
        <h4>产物</h4>
        <div className="stat-grid">
          <div className="stat">
            <span className="stat-value">{outputs?.total ?? 0}</span>
            <span className="caption">总数</span>
          </div>
          <div className="stat">
            <span className="stat-value stat-ok">{outputs?.completed ?? 0}</span>
            <span className="caption">成功</span>
          </div>
          <div className="stat">
            <span className="stat-value stat-warn">{outputs?.completed_with_warnings ?? 0}</span>
            <span className="caption">带警告</span>
          </div>
          <div className="stat">
            <span className="stat-value stat-bad">{outputs?.failed ?? 0}</span>
            <span className="caption">失败</span>
          </div>
        </div>
        {files.length === 0 ? (
          <p className="muted small">没有可下载的产物文件。</p>
        ) : (
          <ul className="file-list">
            {files.map((file) => (
              <li key={file}>
                <a className="file-link" href={outputFileUrl(runId, file)} download>
                  <IconDownload width={14} height={14} aria-hidden="true" />
                  <span>{file}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      {checks.length > 0 ? <ChecksBlock checks={checks} /> : null}

      <section className="result-block">
        <h4>原始 JSON</h4>
        <div className="json-viewers">
          <JsonViewer title="计划 JSON" value={run?.plan ?? null} />
          <JsonViewer title="验证 JSON" value={validation} />
        </div>
      </section>
    </section>
  );
}
