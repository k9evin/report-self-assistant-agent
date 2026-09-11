/**
 * 无人值守端到端冒烟：真实模型 + 真实工具 + 只读数据集，中间没有任何人工审批。
 *
 *   npm run smoke                 # 探测 → 计划 → Dry-Run → 执行 → 汇报
 *   SMOKE_EXECUTE=0 npm run smoke # 只到 Dry-Run
 *   FIXTURE_DIR=/tmp/report-fixture npm run smoke
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const fixtureDir = process.env.FIXTURE_DIR ?? "/tmp/report-fixture";
const autoExecute = process.env.SMOKE_EXECUTE !== "0";

if (!process.env.REPORT_MOUNT_ROOT_DEV) process.env.REPORT_MOUNT_ROOT_DEV = fixtureDir;
if (!process.env.DEEPSEEK_API_KEY && !process.env.REPORT_LLM_API_KEY) {
  console.error("缺少模型凭据：设置 DEEPSEEK_API_KEY 或 REPORT_LLM_API_KEY / REPORT_LLM_BASE_URL");
  process.exit(2);
}

const { loadConfig } = await import("./config.ts");
const { createPlanner } = await import("./planner.ts");
const { createTask, readEvents } = await import("./tasks.ts");

// 1) 夹具（跳过真实产线数据，验证的是链路而不是数据源内容）
execFileSync("python3", [path.join(import.meta.dirname, "..", "tests", "make_fixture.py"), fixtureDir], {
  stdio: "inherit",
});

const config = loadConfig();
const template = path.join(fixtureDir, "template.xlsx");

const REQUEST = [
  "每个 SN 下面找到 test report 文件。",
  "模板每个 Sheet 的 P 列保存 Case 名称，根据 P 列匹配 XML 中 task 的 name。",
  "提取对应 task 下面 item 的 ge、gr、te、nf，分别写入模板同一行的 F、H、J、L 列。",
  "每个 SN 生成一个 Excel 文件。",
].join("\n");

const task = createTask(config, { requestText: REQUEST, datasetId: "ds_dev_fixture", templatePath: template });
console.log(`[smoke] task=${task.task_id} dataset=ds_dev_fixture autoExecute=${autoExecute}`);

const started = Date.now();
const outcome = await createPlanner(config).runTask(task.task_id, {
  autoExecute,
  onEvent: (event) => console.log(`  → tool ${event.name}`),
});

const failures: string[] = [];
const check = (name: string, condition: boolean, detail = ""): void => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures.push(name);
};

const taskDir = path.dirname(task.template_path);
check("plan.json 已落盘", fs.existsSync(path.join(taskDir, "plan.json")));
check("validation.json 已落盘", fs.existsSync(path.join(taskDir, "validation.json")));
check("模型确实调用了工具", outcome.tool_calls.length > 0, `${outcome.tool_calls.length} 次`);
check(
  "调用了 inspect 与 submit 工具",
  outcome.tool_calls.some((c) => c.name === "inspect_xml_schema") && outcome.tool_calls.some((c) => c.name === "submit_resolved_plan"),
);
check("Dry-Run 允许执行", outcome.validation?.execution_allowed === true, String(outcome.validation?.status));
check(
  "五道 Gate 全通过",
  Object.values(outcome.validation?.gates ?? {}).every((gate) => gate === "pass"),
  JSON.stringify(outcome.validation?.gates),
);
if (autoExecute) {
  check("批量执行完成", ["COMPLETED", "COMPLETED_WITH_WARNINGS"].includes(outcome.status), outcome.status);
  const xlsx = outcome.output_files.filter((file) => file.endsWith(".xlsx"));
  check("一 SN 一文件", xlsx.length === 3, xlsx.join(", "));
  check("输出目录含 validation_report.json", outcome.output_files.includes("validation_report.json"));
} else {
  check("未执行（按要求停在 Dry-Run）", outcome.outputs === null);
}

console.log(`\n[smoke] status=${outcome.status} duration=${Date.now() - started}ms tools=${outcome.tool_calls.map((c) => c.name).join(" → ")}`);
console.log(`[smoke] 审计事件 ${readEvents(config, task.task_id).length} 条 → ${path.join(taskDir, "events.jsonl")}`);
console.log(`\n${outcome.reply}\n`);

if (failures.length > 0) {
  console.error(`[smoke] 失败 ${failures.length} 项: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("[smoke] 全部通过：探测 → 计划 → Dry-Run → 执行 → 汇报，全程无人值守。");
