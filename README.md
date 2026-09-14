# 自动化测试报告智能助理（Report Self-Assistant Agent）

把业务用户的一句自然语言需求（"每个 SN 找到 test report，模板 P 列匹配 task name，把 ge/gr/te/nf 填到 F/H/J/L，一 SN 一个文件"）编译成**可被确定性程序验证并执行的结构化计划**，在只读挂载的测试数据库上批量回填 Excel 模板，并把结果如实汇报给不懂编程的人。

**无人值守**：全程没有审批弹窗、没有人点确认。模型只做规划与修正，真正的读写由确定性工具完成，安全边界不依赖模型自觉。

```
业务用户 ──自然语言+模板──► ① 规划层（模型，本仓库 src/）
                                  │  只调用 6 个结构化工具，没有 shell、没有文件读写
                                  ▼
                            ② 确定性核（tools/report_tools.py）
                                  │  探测 / 校验(Dry-Run 五道 Gate) / 执行 / 回读校验
                                  ▼
                            ③ 数据源：/mnt/... 只读挂载（SMB→CIFS，内核级 ro）
```

| 层 | 位置 | 职责 |
|---|---|---|
| ① 规划层 | `src/`（pi SDK） | 理解意图、看证据、写 ResolvedPlan、按结构化错误修正、汇报 |
| ② 确定性核 | `tools/report_tools.py` | 模板/XML 探测、五道 Gate 的 Dry-Run、批量执行、回读校验 |
| ③ 数据源 | `config/datasets.json` + `/mnt` 只读挂载 | `dataset_id` → 只读路径，越界与可写一律阻断 |

---

## 快速开始

```bash
pnpm install                       # 依赖（@earendil-works/pi-coding-agent 等）
python3 -m pip install openpyxl    # 确定性核依赖
npm run web:install                # 前端依赖（web/ 用自己的 npm 装）

cp .env.example .env               # 填模型 key（不要提交 .env）

npm run fixture                    # 造夹具：/tmp/report-fixture（3 个 SN + 模板）
npm run web:build                  # 构建前端到 web/dist
npm run serve                      # 启动控制面 → http://127.0.0.1:8787
```

打开 `http://127.0.0.1:8787` 就是给业务用户用的界面：「运行任务」页是对话式布局——需求写在底部输入区，
发出去之后变成右侧的输入气泡，执行过程（阶段 + 工具调用）与助理汇报依次出现在对话流里，下面是结果区；
跑完还能在同一轮上追问，追问会成为新的一轮对话。
「测试案例」页逐条跑内置用例并直接看到断言结果。同一个端口既提供 API 也托管前端，业务用户只需要一个网址。

只想在命令行验证链路：

```bash
npm run smoke                      # 端到端：探测 → 计划 → Dry-Run → 执行 → 汇报
npm run cases                      # 跑全部测试案例（含两条真调模型的）
npm run cases -- case-03-formula-overwrite   # 跑指定用例
```

`npm run smoke` 会真的调用模型、真的写工作表，最后逐项断言（计划落盘、Dry-Run 放行、五道 Gate 全通过、一 SN 一文件）。想只看计划不执行：

```bash
SMOKE_EXECUTE=0 npm run smoke
```

## 用真实数据跑

```bash
# 1) 宿主机会话里把共享只读挂上（幂等，且会拒绝可写状态）
sudo deploy/mount-mfs-readonly.sh
mount | grep mfs          # 期望出现 ro,...

# 2) 看数据集注册表解析到什么
npm run tools -- check-dataset --mount-root /mnt/mfs/mfs-srv.example.com/Data --relative TestData/WS01/WS1-OA-Module/10001/2000000001

# 3) 起任务
npm run plan -- --request "$(cat request.txt)" --dataset ds_example_10001_2000000001 --template ./模板.xlsx
npm run plan -- --request "..." --dataset <id> --template <xlsx> --no-execute   # 只到 Dry-Run

npm run ask -- --task task-20260910T131741-6604a2 --message "把 inp21 那行留空就行"
```

产物落在 `work/<task_id>/`：

```
task.json              状态机（CREATED→…→COMPLETED / COMPLETED_WITH_WARNINGS / FAILED）
plan.json              已提交的 ResolvedPlan（+ plan_sha256）
validation.json        Dry-Run 结果：五道 Gate、警告、阻断项、修复候选
template-inspection.json / xml-inspection.json   探测证据
events.jsonl           追加式审计：每次工具调用与状态迁移
outputs/<sn>_FIR.xlsx  一 SN 一文件
outputs/validation_report.json   逐 SN 的匹配/未匹配/缺失统计
```

## 数据源：只读挂载

生产环境是 Windows SMB，接入方式是在 Linux 侧只读挂载，**不给应用任何 UNC 或凭据**：

```bash
sudo mount -t cifs //mfs-srv.example.com/Data /mnt/mfs/mfs-srv.example.com/Data \
  -o ro,credentials=/etc/report-agent/smb.credentials,uid=1000,gid=1000,iocharset=utf8,vers=3.0,nobrl
```

挂载根按平台写在 `config/datasets.json`，可用环境变量覆盖，便于开发机：

| 环境变量 | 作用 |
|---|---|
| `REPORT_MOUNT_ROOT_<ID>` | 覆盖某个挂载根，如 `REPORT_MOUNT_ROOT_MFS=/Volumes/mfs/mfs-srv.example.com/Data`（macOS） |
| `REPORT_MOUNT_ROOT` | 覆盖全部挂载根 |
| `REPORT_CONFIG` | 指向另一份 `datasets.json` |
| `REPORT_WORK_DIR` | 任务目录位置（默认 `./work`） |

> **仓库里的示例已脱敏**：`config/datasets.json`、`deploy/` 与本文档里的主机名（`mfs-srv.example.com`）、
> 数据集 id（`ds_example_*`）和路径都是占位示例。真实的内网共享名、数据集 id 与路径请放在本地 `.env`
> （`REPORT_MOUNT_ROOT_*`）或用 `REPORT_CONFIG` 指向一份不进仓库的私有配置里，不要提交上来。

关于 `check-dataset` 会阻断的情况：`MOUNT_NOT_FOUND`（挂载不在）、`DATASET_NOT_FOUND`（路径不存在）、`DATASET_OUTSIDE_MOUNT_ROOT`（`../` 或符号链接逃逸）、`MOUNT_WRITABLE`（数据源竟然可写——不是许可，是告警）。

## 换模型（自定义模型）

模型用 `(provider, model_id)` 指定，两种方式：

```bash
# A. pi 内置 provider（默认）：只要 key
DEEPSEEK_API_KEY=sk-...            REPORT_PROVIDER=deepseek REPORT_MODEL_ID=deepseek-v4-pro

# B. 任意 OpenAI 兼容端点（公司内网 vLLM / Ollama / Qwen / 自建网关）
REPORT_LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
REPORT_LLM_API_KEY=sk-...
# 再在 .pi/agent/models.json 的 custom provider 下把 models[].id 改成你的模型名
```

`.pi/agent/models.json` 里 `baseUrl` / `apiKey` 写的是 `$REPORT_LLM_BASE_URL` / `$REPORT_LLM_API_KEY` 插值，**文件里没有明文密钥**；`compat` 用来关掉某些兼容端点不支持的字段（`supportsDeveloperRole` / `supportsReasoningEffort`）。密钥也可以放 `agents/<id>/agent_state/.vault.toml`（Agent 卡片 → 齿轮 → key vault），由运行时注入环境变量。

## 安全边界（为什么可以无人值守）

1. **模型没有 shell**：会话以 `noTools: "builtin"` 打开，模型只看得见 6 个注册工具，不能 `bash`、不能读写文件、不能拼路径。
2. **模型拿不到宿主路径**：只给 `dataset_id`，映射与越界校验在 `src/storage.ts`（`realpath` 之后判断是否在挂载根内，阻断 `../` 与符号链接）。
3. **写操作必须过闸**：`execute_validated_plan` 要求 —— 计划 hash 未被改动 + 模板 hash 未变 + `validation.json.execution_allowed=true` + 数据集授权有效 + 输出目录为空；任一不满足即拒绝。
4. **校验先于执行**：Dry-Run 在代表样本上真实走一遍"复制模板→Join→写单元格→保存→重开→回读"，五道 Gate 全 pass 才放行。
5. **工具串行**：6 个工具都标了 `executionMode: "sequential"`，避免提交/校验/执行被并发打乱。
6. **源数据只读**：内核级 `ro` 挂载 + 容器 `:ro`；应用层即使有 bug 也改不了源数据。
7. **能问就不猜**：需求与模板矛盾、一对多、候选相似、输出布局不明 —— 停下来把两个方案讲给用户；同一类错误连修 2 次不通过也停下。

## 接你自己的平台（FastAPI / Next.js）

`src/planner.ts` 导出的 `PlannerService` 就是契约，控制面直接嵌进来用，不必走 CLI：

```ts
import { createPlanner } from "./src/planner.ts";
import { createTask } from "./src/tasks.ts";

const task = createTask(config, { requestText, datasetId, templatePath });
const outcome = await createPlanner(config).runTask(task.task_id, { autoExecute: true });
// outcome: { status, plan, validation, outputs, output_files, reply, tool_calls, duration_ms }
```

| 方法 | 语义 |
|---|---|
| `buildIntentPlan(taskId)` | 只做需求理解，输出 IntentPlan（含缺槽位） |
| `buildResolvedPlan(taskId)` | 探测 → 写计划 → Dry-Run，返回 `{plan_sha256, plan}` |
| `replanFromErrors(taskId, errors)` | 按结构化错误重规划（闭环修正） |
| `runTask(taskId, {autoExecute})` | 一次跑完，返回完整 `TaskOutcome` |
| `ask(taskId, message)` | 追问/微调，同一任务目录同一份产物 |

前端只需展示 `TaskOutcome`：`status` / `validation.gates` / `outputs` / `reply`，产物目录 `work/<task_id>/outputs/` 直接作为下载源。

## 验证

```bash
npm run typecheck     # tsc --noEmit
npm run regress       # Python 确定性核回归（24 条断言）
npm run test:node     # node:test：数据源越界 / 计划形状 / selector 双侧一致性（13 条）
npm run smoke         # 真实模型的无人值守端到端
npm run cases         # 测试案例集（14 条，见下）
```

`tests/node/selector-parity.test.ts` 是一条不变量测试：TypeScript 的入口守卫与 `report_tools.py` 的 `parse_selector` 必须接受**完全相同**的 selector 集合，任何一侧放宽或收紧都会红灯。

### 测试案例

`cases/*.json` 里 14 条用例，每条自带期望；判定逻辑只有一份（`src/cases.ts` 的 `evaluateCase`），命令行与界面走同一条路径。
**模型用例**真调模型覆盖完整链路，**确定性用例**只跑确定性核、不花 token，可以直接进 CI。完整表格与断言口径见 [`docs/test-cases.md`](docs/test-cases.md)。

| ID | 验的是什么 |
|---|---|
| `case-01-four-fields` | 基准场景：探测 → 计划 → Dry-Run → 执行 → 汇报，五道 Gate 全通过、3 个 Excel |
| `case-02-dry-run-only` | 勾了「只做预演」时必须停在 Dry-Run，绝不调用执行工具 |
| `case-03-formula-overwrite` | 目标列覆盖公式 → `FORMULA_OVERWRITE`，拒绝执行 |
| `case-04-unsupported-selector` | `.//task[@name]` 这类谓词语法 → `PLAN_SELECTOR_UNSUPPORTED` |
| `case-05-deterministic-backfill` | 已知正确计划直接 Dry-Run + 执行（不花 token 的回归基线） |
| `case-06-mount-missing` | 挂载缺失 → `MOUNT_NOT_FOUND`，任务不启动 |
| `case-07-dataset-escape` | 数据集路径越界 → `DATASET_OUTSIDE_MOUNT_ROOT` |
| `case-08-scale-backfill` | **1 万行 × 12 个 SN、48 万个单元格**全量回填，0 失败 |
| `case-09-scale-parallel` | 并行与串行写出**完全一致**，且并行真的更快（实测 ~2.9×） |
| `case-10-scale-resume` | 中断后 `--resume` 只补缺失的 SN，不重做已完成的 |
| `case-11-scale-context` | 万行时中间产物仍是 KB 级，不会撑爆 Agent 上下文 |
| `case-12-messy-block` | 脏数据 + `block` 策略 → 在 **Dry-Run** 就被拦下，0 个 Excel |
| `case-13-messy-tolerate` | 同一份脏数据 + `warning` 策略 → 照常产出，但重复键必须留痕 |
| `case-14-scale-multifile` | 一个 SN 目录多份报告时，`latest_mtime` 必须取到最新那份 |

## 规模：上万行时还站得住吗

生产数据是万行量级，所以确定性核做过一次针对规模的处理与实测（8 核 / 16 GB）：

- **并行**：`execute-plan` 按 SN 切分给 `ProcessPoolExecutor`，`--workers` 可覆盖，默认 `min(CPU-1, SN 数, 8)`；
  结果仍按 SN 顺序回填。12 个 SN × 1 万行：单线程 22.9s → 6.9s。
- **断点续跑**：`--resume` 依据 `_progress.jsonl` 跳过"产物在、未失败、源文件哈希未变"的 SN。
  三千个 SN 跑到一半被杀，不必从头再来。
- **超时**：执行工具默认超时 4 小时（`REPORT_EXECUTE_TIMEOUT_MS`），并把 `--progress` 的进度逐行落进 `events.jsonl`。
- **上下文安全**：探测与验证的产物都是 KB 级（警告只留前 5 条样本 + 总数聚合），
  1 万行时 `inspect-template` 输出 2.1 KB——Agent 不会被自己的工具输出淹掉。

```bash
python3 tests/make_big_fixture.py --out /tmp/report-big --sns 12 --rows 10000            # 真实规模
python3 tests/make_big_fixture.py --out /tmp/report-big-messy --sns 8 --rows 10000 --messy # 加脏数据
python3 tests/make_big_fixture.py --out /tmp/report-big-multifile --sns 6 --rows 10000 --stale-xml
npm run cases -- case-08-scale-backfill case-14-scale-multifile
```

## 目录

```
src/
  config.ts     项目路径、数据集注册表、挂载根解析、模型选择
  storage.ts    dataset_id → 只读路径（realpath allowlist，越界阻断）
  schemas.ts    三阶段 Plan 类型 + 入口场景守卫
  tools.ts      模型可见的 6 个工具（defineTool）
  planner.ts    PlannerService + pi 运行时（noTools:"builtin"）
  tasks.ts      任务目录 / 状态机 / 审计事件 / 模板只读副本
  python.ts     CLI 通道（execFile）
  cases.ts      测试案例的运行与断言（命令行与界面共用）
  server.ts     控制面 HTTP + SSE（node:http，零框架）
  cli.ts        运维 CLI；smoke.ts 端到端冒烟；run-cases.ts 案例入口
web/            React 控制台（Vite + React + TS + Tailwind v4 + shadcn/ui，构建到 web/dist）
cases/          测试案例定义（纯 JSON，加文件即加用例）
docs/api.md     控制面 API 契约（前端与 FastAPI 对接都以它为准）
docs/test-cases.md  案例清单与断言口径
tools/report_tools.py   确定性核（唯一真源，Agent 侧同步同一份文件）
tests/make_fixture.py       小夹具（3 个 SN，验链路）
tests/make_big_fixture.py   真实规模夹具（万行；--messy 脏数据 / --stale-xml 历史报告）
tests/regress.sh            确定性核回归（24 条断言）
.agents/skills/         给模型的工作方法（探测、写计划）
config/datasets.json    挂载根与数据集注册表
persona.md              规划层系统提示（角色 / 决策规则 / 硬约束）
deploy/                 只读 CIFS 挂载脚本 + 执行容器
scripts/sync-to-penguin-agent.sh  语义真源 → PenguinHarness Agent State
```

## 控制面 API

`npm run serve` 起的是完整控制面：`GET /api/datasets`、`GET /api/cases`、`POST /api/runs`、
`GET /api/runs/:id/stream`（SSE 实时事件）、产物下载与审计事件读取。
契约写在 [`docs/api.md`](docs/api.md)，你们自己的 FastAPI / Next.js 想接管前端时按它对接即可。
服务默认只监听 `127.0.0.1`；端口被占会自动往后找，不会去抢别人的端口。

```bash
curl -s http://127.0.0.1:8787/api/health
curl -s -X POST http://127.0.0.1:8787/api/runs/case -H 'content-type: application/json' \
     -d '{"case_id":"case-05-deterministic-backfill"}'
```

## 与 PenguinHarness 的双轨关系

生产运行时只用本仓库（pi SDK），PenguinHarness 那一侧的 `report_assistant` Agent 是**能力优化实验场**：用 benchmark / evaluation / optimization 给同一份 `persona.md` + 技能 + `report_tools.py` 打分、回滚。

两条轨道的语义真源都在本仓库，`scripts/sync-to-penguin-agent.sh` 负责不漂移：

```bash
scripts/sync-to-penguin-agent.sh          # 只报告差异（CI 可当门禁）
scripts/sync-to-penguin-agent.sh --write  # 应用（先备份被覆盖的文件）
```

## 许可

[MIT](LICENSE)。
