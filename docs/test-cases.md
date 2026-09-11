# 测试案例

案例定义在 `cases/*.json`，每一条自带期望（`expect`），判定逻辑只有一份（`src/cases.ts` 的 `evaluateCase`），
命令行、前端「测试案例」页签走的是同一条路径 —— 不存在"界面显示通过、实际没验"的可能。

```bash
npm run cases                                    # 全跑
npm run cases -- case-03-formula-overwrite       # 跑指定用例
# 也可以在 web 界面「测试案例」页签里逐条点运行，实时看工具调用与断言
```

两类用例：

- **模型用例**（`kind: "agent"`）：真的调用模型走完整链路，覆盖"模型能不能自己把需求编译成正确计划"。会产生 token 成本。
- **确定性用例**（`kind: "deterministic"`）：只跑确定性核，不花 token，用来守住安全边界。可以直接当回归基线放进 CI。

| ID | 类型 | 验的是什么 | 期望 |
|---|---|---|---|
| `case-01-four-fields` | 模型 | 基准场景：探测模板与 XML → 写计划 → Dry-Run → 执行 → 汇报 | 终态 `COMPLETED*`、Dry-Run 放行、五道 Gate 全通过、0 个阻断项、3 个 Excel、四个工具都被调用过 |
| `case-02-dry-run-only` | 模型 | 用户勾了「只做预演」时，必须停在 Dry-Run | 终态 `READY`、Gate 全通过，但 **没有** 调用 `execute_validated_plan`、0 个 Excel |
| `case-03-formula-overwrite` | 确定性 | 计划把 ge 也写进 G 列，而 G5/G8 有公式 | Dry-Run 拒绝、出现 `FORMULA_OVERWRITE`、Gate 不是全通过 |
| `case-04-unsupported-selector` | 确定性 | `record_selector` 写成 `.//task[@name]`（带谓词） | 拒绝并出现 `PLAN_SELECTOR_UNSUPPORTED` |
| `case-05-deterministic-backfill` | 确定性 | 已知正确的计划直接走 Dry-Run + 执行 | Gate 全通过、0 阻断项、3 个 Excel（回归基线） |
| `case-06-mount-missing` | 确定性 | 挂载根指向不存在的目录 | `MOUNT_NOT_FOUND`，任务不启动 |
| `case-07-dataset-escape` | 确定性 | 数据集相对路径写成 `../outside` | `DATASET_OUTSIDE_MOUNT_ROOT` |

### 真实规模用例（上万行）

生产上模板与 XML 都是万行量级，所以"对不对"必须在万行下验过，而不是靠小夹具外推。
夹具由 `tests/make_big_fixture.py` 生成（模板 10000 行 × 2 Sheet、表头合并、目标列附近混着公式与文本；
每个 SN 一份同量级 XML）：

```bash
python3 tests/make_big_fixture.py --out /tmp/report-big --sns 12 --rows 10000
python3 tests/make_big_fixture.py --out /tmp/report-big-messy --sns 8 --rows 10000 --messy
python3 tests/make_big_fixture.py --out /tmp/report-big-multifile --sns 6 --rows 10000 --stale-xml
```

| ID | 类型 | 验的是什么 | 期望 |
|---|---|---|---|
| `case-08-scale-backfill` | 确定性 | 12 个 SN × 1 万行，48 万个单元格全量回填 | Gate 全通过、0 阻断项、12 个 Excel、`cells_written = 480000`、`sn_failed = 0` |
| `case-09-scale-parallel` | 确定性 | 并行不能改变结果：同一批 4 个 SN 分别串行（`--workers 1`）与并行各跑一次 | 单元格总数与逐 SN 结论完全一致，且 `speedup ≥ 1.6×`（本机实测 ~2.9×） |
| `case-10-scale-resume` | 确定性 | 跑完后删掉一个产物模拟中途被杀，带 `--resume` 重跑 | 只补回缺失的那个 SN，其余 3 个被跳过（`resumed_sn = 3`），总数仍为 160000 |
| `case-11-scale-context` | 确定性 | 万行时探测证据会不会撑爆 Agent 上下文 | `inspect-template` 如实报告 10004 行，最大中间产物 ≤ 32 KB（实测 2.1 KB） |
| `case-12-messy-block` | 确定性 | 同一份脏数据，`duplicate_source_key_policy = "block"` | **在 Dry-Run 就被拦下**：`status = rejected`、`source_schema_valid = fail`、出现 `DUPLICATE_SOURCE_KEY`、0 个 Excel、不调用执行工具 |
| `case-13-messy-tolerate` | 确定性 | 同一份脏数据改为 `warning` 策略 | Gate 全通过、8 个 Excel、8 个 SN 全是 `ok_with_warnings`、`cells_written ≥ 300000`（实测 314602），且**执行报告里必须出现 `DUPLICATE_SOURCE_KEY` 警告** |
| `case-14-scale-multifile` | 确定性 | 一个 SN 目录里有两份报告（当天 1 万 task + 早 1 小时的历史 5000 task），`multiple_match_policy = latest_mtime` | 必须取当天那份：`cells_written = 160000`（取成历史文件会是 80000），0 失败 |

`case-12` 与 `case-13` 是同一份脏数据的两个策略面，合起来才说明问题：脏数据被容忍不等于可以被悄悄丢掉，
而该拦的时候拦阻点必须在预演——执行阶段压根不会启动，所以"执行时逐 SN 失败"不是这里的正确期望。

## 断言口径

- `error_codes` 给空数组 = **不允许出现任何阻断项**；给具体码 = **这些码必须出现**（允许确定性核追加同根因的下游错误码，例如 `FORMULA_OVERWRITE` 之后还有 `WRITE_READBACK_MISMATCH`）。
- `gates` 只有 `all_pass` 与 `not_all_pass` 两种，都不看具体是哪一道 —— 具体值会打在结果详情里供人判断。
- `output_xlsx` 数的是输出目录里的 `.xlsx`，这正是"一 SN 一文件"的可观测形式。
- 确定性用例每次在自己的草稿目录里跑（`work/case-<id>-<rand>/`），**不会**碰真实任务目录，也不会改动数据源与模板。
- 规模断言：`sn_total` / `cells_written` / `min_cells_written` / `sn_failed` / `failed_sn_error_codes` /
  `warning_codes` / `template_max_row` / `artifact_max_kb` / `min_speedup` / `resumed_sn`。
  其中 `min_speedup` 只在本机 ≥ 4 核时判定（否则记为该条跳过但通过，避免在弱机器上误红）；
  `cells_written` 用精确值而不是 `min_`，是因为它正是 `latest_mtime` 之类"选错输入"的唯一判别信号——取错文件会安静地少写一半。

## 加一条用例

在 `cases/` 里放一个 JSON 即可，不需要改代码：

```json
{
  "id": "case-08-my-scenario",
  "title": "一句话说明",
  "description": "它会验什么、为什么这条重要",
  "kind": "deterministic",
  "scenario": "validate-plan",
  "dataset_id": "ds_dev_fixture",
  "plan": { "...": "完整的 ResolvedPlan" },
  "expect": { "execution_allowed": false, "error_codes": ["SOME_GATE_ERROR"] }
}
```

现有 `scenario`：`validate-plan`（只 Dry-Run）、`validate-and-execute`（Dry-Run 后执行）、
`mount-not-found`、`dataset-escape`，以及规模用的 `scale-execute`、`scale-parallel`、`scale-resume`、`scale-inspect`。
`kind: "agent"` 的用例改用 `request` + `auto_execute` 描述场景。
保存后命令行与界面都会自动出现这条用例。
