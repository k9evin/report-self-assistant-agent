import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HistoryStore } from "../../src/history.ts";

test("dev 历史在重新打开 SQLite 后仍可读取，prod 不可见", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-history-"));
  const file = path.join(dir, "history.sqlite");
  const run = { run_id: "run-test", environment: "dev" as const, request: "填报", started_at: "2026-01-01T00:00:00.000Z", tag: "测试", pinned: true };
  const first = new HistoryStore(file);
  first.createRun(run);
  first.appendTurn(run.run_id, "assistant", "已完成");
  first.saveRun(run);

  const restarted = new HistoryStore(file);
  assert.equal(restarted.listRuns("dev").length, 1);
  assert.equal(restarted.getRun("run-test", "dev")?.tag, "测试");
  assert.equal(restarted.listRuns("prod").length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
