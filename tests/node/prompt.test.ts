import assert from "node:assert/strict";
import test from "node:test";

import { buildTaskPrompt } from "../../src/planner.ts";
import type { TaskRecord } from "../../src/tasks.ts";

const fakeTask: TaskRecord = {
  task_id: "test-task",
  dataset_id: "ds-1",
  request_text: "extract data",
  template_path: "/tmp/template.xlsx",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  status: "CREATED",
};

test("buildTaskPrompt 根据 responseLanguage 注入规范", () => {
  const zh = buildTaskPrompt(fakeTask, { autoExecute: true, responseLanguage: "zh" });
  assert.match(zh, /语言要求：请全程使用中文回答与汇报/);

  const en = buildTaskPrompt(fakeTask, { autoExecute: true, responseLanguage: "en" });
  assert.match(en, /Language requirement: Please reply and report entirely in English/);

  const auto = buildTaskPrompt(fakeTask, { autoExecute: true, responseLanguage: "auto" });
  assert.match(auto, /根据用户输入所使用的语言进行回答与汇报/);
});
