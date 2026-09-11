/**
 * 本地开发/运维 CLI（不是业务用户入口）。
 * 业务用户入口是你们的平台前端 → 控制面 → PiPlanner。
 */
import fs from "node:fs";
import path from "node:path";

import { loadConfig } from "./config.ts";
import { createPlanner } from "./planner.ts";
import { resolveDataset } from "./storage.ts";
import { createTask, loadTask, readEvents } from "./tasks.ts";

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2);
      if (inline !== undefined) {
        flags[key!] = inline;
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          flags[key!] = next;
          i += 1;
        } else {
          flags[key!] = "true";
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function usage(): never {
  console.log(
    [
      "用法：",
      "  tsx src/cli.ts datasets",
      "  tsx src/cli.ts plan --request \"<需求>\" --dataset <dataset_id> --template <xlsx> [--no-execute] [--json]",
      "  tsx src/cli.ts ask --task <task_id> --message \"<追问>\"",
      "  tsx src/cli.ts status --task <task_id>",
      "  tsx src/cli.ts events --task <task_id>",
    ].join("\n"),
  );
  process.exit(0);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { flags } = parseArgs(rest);
  const config = loadConfig();

  switch (command) {
    case "datasets": {
      for (const record of config.datasets.values()) {
        const root = config.mountRoots.get(record.mount_root_id);
        let resolved = "(unresolved)";
        try {
          resolved = resolveDataset(config, record.dataset_id).resolvedPath;
        } catch (error) {
          resolved = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
        }
        console.log(`${record.dataset_id}\t${record.name}\tmount_root=${root?.resolvedRoot}\taccess=${record.access}\n  resolved=${resolved}`);
      }
      return;
    }
    case "plan": {
      const request = flags.request;
      const datasetId = flags.dataset;
      const template = flags.template;
      if (!request || !datasetId || !template) usage();
      const autoExecute = flags["no-execute"] === undefined;
      const task = createTask(config, {
        requestText: request,
        datasetId,
        templatePath: path.resolve(template),
      });
      console.error(`[task] ${task.task_id}  dataset=${datasetId}  template=${template}`);
      const planner = createPlanner(config);
      const outcome = await planner.runTask(task.task_id, {
        autoExecute,
        onEvent: (event) => console.error(`  → ${event.name}`),
      });
      if (flags.json === "true") {
        console.log(JSON.stringify(outcome, null, 2));
      } else {
        console.log(`\n状态：${outcome.status}`);
        if (outcome.plan_sha256) console.log(`计划 hash：${outcome.plan_sha256}`);
        if (outcome.validation) {
          console.log(`验证：${outcome.validation.status}  gates=${JSON.stringify(outcome.validation.gates)}`);
          for (const warning of outcome.validation.warnings ?? []) {
            console.log(`  warning ${warning.code} x${warning.count ?? ""}`);
          }
          for (const error of outcome.validation.errors ?? []) {
            console.log(`  error   ${error.code}`);
          }
        }
        if (outcome.outputs) console.log(`输出：${JSON.stringify(outcome.outputs)}`);
        console.log(`\n${outcome.reply}`);
      }
      return;
    }
    case "ask": {
      const taskId = flags.task;
      const message = flags.message;
      if (!taskId || !message) usage();
      const planner = createPlanner(config);
      const outcome = await planner.ask(taskId, message, {
        onEvent: (event) => console.error(`  → ${event.name}`),
      });
      console.log(outcome.reply);
      return;
    }
    case "status": {
      const taskId = flags.task;
      if (!taskId) usage();
      const task = loadTask(config, taskId);
      console.log(JSON.stringify(task, null, 2));
      return;
    }
    case "events": {
      const taskId = flags.task;
      if (!taskId) usage();
      for (const event of readEvents(config, taskId)) console.log(JSON.stringify(event));
      return;
    }
    default: {
      const taskId = flags.task;
      if (command === "outputs" && taskId) {
        const task = loadTask(config, taskId);
        const dir = path.dirname(task.template_path);
        console.log(fs.readdirSync(path.join(dir, "outputs")).join("\n"));
        return;
      }
      usage();
    }
  }
}

await main();
