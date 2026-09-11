# 控制面 API 契约（v1）

服务：`npm run serve` → 默认 `http://127.0.0.1:8787`（`REPORT_PORT` 可改；端口被占会自动往后找）。
同一个端口既提供 API，也提供构建好的前端（`GET /`）。

所有请求与响应都是 JSON（`Content-Type: application/json; charset=utf-8`），除下载端点外。
错误统一为 `{ "error": { "code": "...", "message": "..." } }` + 相应的 4xx/5xx。

---

## 健康与元信息

### `GET /api/health`

```json
{ "ok": true, "version": "1.0", "provider": "deepseek", "model_id": "deepseek-v4-pro",
  "python": "python3", "work_dir": "/abs/path/work", "has_credentials": true }
```

### `GET /api/datasets`

```json
{ "datasets": [
  { "dataset_id": "ds_dev_fixture", "name": "本地夹具", "access": "read_only",
    "mount_root_id": "dev", "mount_root": "/tmp/report-fixture",
    "resolved_path": "/private/tmp/report-fixture/TD28",
    "available": true, "problem": null, "sn_count": 3, "writable_by_process": true }
] }
```

`available=false` 时 `problem` 为 `{ "code": "MOUNT_NOT_FOUND" | "DATASET_NOT_FOUND" | "DATASET_OUTSIDE_MOUNT_ROOT" | "DATASET_NOT_READABLE" | "DATASET_NOT_DIRECTORY", "message": "..." }`。
`writable_by_process=true` 表示这份挂载当前可写——是告警而不是许可（生产用 `:ro`）。

### `GET /api/cases`

```json
{ "cases": [ {
  "id": "case-01-four-fields", "title": "四字段回填（基准）", "description": "...",
  "kind": "agent",                        // "agent" 需要模型；"deterministic" 只跑确定性核，不花 token
  "dataset_id": "ds_dev_fixture", "auto_execute": true,
  "request": "每个 SN 下面找到 test report 文件…",
  "expect": {
    "status": ["COMPLETED", "COMPLETED_WITH_WARNINGS"],
    "execution_allowed": true,
    "gates": "all_pass",                  // "all_pass" | "not_all_pass"
    "error_codes": [],                    // 必须出现的错误码；空数组表示不允许有任何阻断项
    "output_xlsx": 3,                     // 期望的 xlsx 文件个数（null 表示不检查）
    "tool_calls": ["inspect_xml_schema", "submit_resolved_plan"]
  } } ] }
```

---

## 运行任务

### `POST /api/runs`

自由需求。

```json
{ "request": "每个 SN …", "dataset_id": "ds_dev_fixture", "auto_execute": true }
```

→ `202 { "run_id": "run-..." }`

### `POST /api/runs/case`

```json
{ "case_id": "case-02-formula-overwrite" }
```

→ `202 { "run_id": "run-..." }`

### `GET /api/runs/:id`

```json
{ "run_id": "run-...", "kind": "case", "case_id": "case-01-four-fields",
  "state": "running",              // running | done | error
  "task_id": "task-...",           // 确定性用例没有任务目录，为 null
  "artifact_dir": "/abs/path",     // 计划/验证/outputs 所在目录（模型用例是任务目录，确定性用例是草稿目录）
  "dataset_id": "ds_dev_fixture", "request": "…",
  "phase": "VALIDATING",           // 任务状态机：CREATED/INSPECTING/PLANNING/VALIDATING/NEEDS_REPLAN/BLOCKED/READY/RUNNING/COMPLETED/…
  "tool_calls": [ { "name": "inspect_xml_schema", "ok": true, "at": "2026-09-10T13:17:41Z" } ],
  "reply": "……",                    // 模型给用户看的汇报（流式累积）
  "plan": { }, "validation": { },   // plan.json / validation.json 的内容，未产出时为 null
  "outputs": { "directory": "…", "total": 3, "completed": 0, "completed_with_warnings": 3, "failed": 0 },
  "output_files": ["K7893981_FIR.xlsx", "validation_report.json"],
  "checks": [ { "name": "五道 Gate 全通过", "ok": true, "detail": "pass,pass,pass,pass,pass" } ],
  "error": null, "started_at": "…", "finished_at": null, "duration_ms": null }
```

`checks` 只在 `kind="case"` 时有值，是后端按 `expect` 逐条断言的结果。

### `GET /api/runs/:id/stream`（SSE）

`text/event-stream`，每条 `data: <JSON>`：

| `type` | 载荷 | 含义 |
|---|---|---|
| `snapshot` | 完整 RunView | 连接建立时先发一次当前状态 |
| `status` | `{ phase }` | 任务状态机变化 |
| `tool_start` / `tool_end` | `{ name, ok?, at }` | 工具调用开始/结束 |
| `text` | `{ delta }` | 模型汇报的流式片段 |
| `check` | `{ name, ok, detail }` | 用例断言结果 |
| `done` | `{ run }` | 结束，`run` 是终态 RunView |
| `error` | `{ message }` | 失败 |

每 15 秒发一次注释行 `: keep-alive` 保活；客户端断开即取消订阅。

### `POST /api/runs/:id/ask`

```json
{ "message": "inp21 那行留空就行" }
```

→ `202 { "ok": true }`；结果通过同一个 `/stream` 推送（`run.state` 回到 `running`）。

---

## 产物

| 端点 | 内容 |
|---|---|
| `GET /api/runs/:id/artifact?name=plan.json` | 计划 / 验证 / 探测证据（`validation.json`、`template-inspection.json`、`xml-inspection.json`），未产出返回 404 |
| `GET /api/runs/:id/events` | 审计事件数组（`events.jsonl`） |
| `GET /api/runs/:id/outputs/:file` | 下载产物文件（`Content-Disposition: attachment`），文件名里的 `/` 一律拒绝 |
| `GET /api/template` | 下载演示模板 `template.xlsx` |
