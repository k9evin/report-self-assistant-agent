---
name: report-plan-authoring
description: Turn a natural-language report request plus inspection evidence into the three-stage Plan (IntentPlan / ResolvedPlan / ValidatedPlan), drive the deterministic Dry-Run, repair the plan from structured Validator errors, and only then hand the validated plan to execution.
---

# 报告计划编写与验证

证据采齐后，本技能负责：需求 → `IntentPlan` → `ResolvedPlan`（`submit_resolved_plan` 写入） → Dry-Run（`validate_report_plan`） → 按结构化错误修正 → 通过后执行（`execute_validated_plan`） → 汇报（`get_task_status`）。

计划由工具落盘（任务工作区的 `plan.json`），执行时会用它的 sha256 校验一致性：**先提交、再验证、最后执行**，不要跳过验证或在执行前改动计划。

## 1. IntentPlan（用户想做什么）

先把需求复述成这些槽位，缺哪个问哪个（不要替用户补）：

```json
{
  "output": {"mode": "one_file_per_sn", "filename_pattern": "{sn}_FIR.xlsx"},
  "source_file_intent": {"file_type": "xml", "name_hint": "test_report"},
  "template_intent": {"sheet_scope": "all",
                      "row_match_key": {"semantic_name": "case", "column_hint": "P"}},
  "field_intents": [{"source_semantic": "ge", "target_column_hint": "F"}]
}
```

槽位：输出粒度（一 SN 一文件 / 汇总）、源文件类型与名字线索、Sheet 范围、匹配键语义与列线索、字段→目标列。用户没说输出粒度时默认一 SN 一文件，并在汇报里说明这是默认。

## 2. ResolvedPlan（在当前模板和 XML 中怎么做）

```json
{
  "plan_version": 2,
  "dataset_id": "ds_example_10001_2000000001",
  "output": {"mode": "one_file_per_sn", "sn_source": "parent_directory_name",
             "filename_pattern": "{sn}_FIR.xlsx"},
  "source_file": {"pattern": "*_test_report*.xml", "multiple_match_policy": "latest_mtime"},
  "source_records": {
    "record_selector": ".//task",
    "key_selector": "@name",
    "field_storage": {"item_selector": "./item", "field_name_selector": "@name",
                      "field_value_selector": "@value"}
  },
  "template": {
    "sheet_scope": "all",
    "join": {"template_key_column": "P", "source_key": "task.@name", "match_mode": "normalized_exact"},
    "mappings": [{"source_field": "ge", "target_column": "F"}]
  },
  "normalization": {"trim_whitespace": true, "case_sensitive": true, "rules": []},
  "missing_value_policy": "leave_blank_and_report",
  "missing_case_policy": "warning",
  "duplicate_source_key_policy": "block"
}
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `output.mode` | `one_file_per_sn` | 唯一被执行的模式 |
| `output.sn_source` | `parent_directory_name` | SN 取 SN 目录名 |
| `output.filename_pattern` | `{sn}_FIR.xlsx` | `{sn}` 会被替换 |
| `source_file.pattern` | glob | 一个 SN 目录内的报告文件名 |
| `source_file.multiple_match_policy` | `latest_mtime` | 多份命中时的默认策略（留审计） |
| `record_selector` | `.//task` | 记录节点，取自 `record_candidates` |
| `key_selector` | `@name` | 记录键，取自 `key_candidates` |
| `field_storage.*` | 见上 | 取自 `field_models`；`field_name_selector: null` 表示用子元素标签当字段名 |
| `template.join.match_mode` | `normalized_exact` / `exact` | 默认 `normalized_exact`；**不得模糊匹配** |
| `normalization` | 见上 | 只允许 trim 与明确允许的大小写规则；改语义的规则先问用户 |
| `missing_value_policy` | `leave_blank_and_report` | 字段缺失留空并计数，不编造 |
| `missing_case_policy` | `warning` / `block` | 默认 `warning` 并列出清单 |
| `duplicate_source_key_policy` | `block` | 重复 Key 默认阻断，除非用户给了规则 |

Selector 受支持语法（超出即报 `PLAN_SELECTOR_UNSUPPORTED`）：`.//tag`、`./tag`、`tag`、`@attr`、`./tag/@attr`、`./tag/text()`、`text()`。**不支持 XPath 谓词 / 通配符 / 命名空间前缀 / 函数。**

## 3. Dry-Run 与五道 Gate

`validate_report_plan` 在代表性样本 SN 上跑真实回填（复制模板 → Join → 写单元格 → 保存 → 重开 → 回读），返回 ValidatedPlan：

```json
{
  "validation": {"sample_sn_count": 3, "source_record_count": 9, "exact_match_count": 3,
                 "unmatched_key_count": 3, "formula_overwrite_count": 0,
                 "save_success": true, "reopen_success": true, "write_readback_mismatch_count": 0},
  "gates": {"source_schema_valid": "pass", "template_structure_valid": "pass",
            "join_valid": "pass", "write_safe": "pass", "output_integrity_valid": "pass"},
  "warnings": [{"code": "UNMATCHED_TEMPLATE_KEY", "count": 3, "samples": ["..."], "rows": ["..."]}],
  "errors": [], "status": "pass_with_warnings", "execution_allowed": true
}
```

- `status`：`pass`（无警告）/ `pass_with_warnings`（可执行但要汇报）/ `rejected`（禁止执行）。
- `gates`：`pass` / `fail` / `not_executed`（前面 fail 后，后面的 Gate 不再执行——**不要把 not_executed 读成通过**）。
- **只有 `execution_allowed=true` 才允许执行。**

## 4. 结构化错误 → 修正动作

证据型错误（按返回的候选改正后重验）：

| 错误码 | 修正动作 |
|---|---|
| `PLAN_SELECTOR_UNSUPPORTED` | 改写成受支持子集（去谓词/通配/前缀），或改用探测候选 |
| `RECORD_SELECTOR_NO_MATCH` | 用错误里 `record_candidates` 的 `record_selector` 替换 |
| `KEY_SELECTOR_EMPTY` | 换 `key_candidates` 的另一个 selector；仍为空说明该节点不是记录节点 |
| `FIELD_STRUCTURE_NO_MATCH` | 用 `field_model_candidates` 的 `item_selector` / `field_name_selector` / `field_value_selector` |
| `JOIN_NO_MATCH` | 对比 `template_key_samples` 与 `source_key_samples`：多半 Key 列选错，或两边命名/规范化不一致 |
| `TEMPLATE_KEY_COLUMN_EMPTY` / `TEMPLATE_KEY_COLUMN_MISSING` | 换匹配键列 |
| `SHEET_NOT_FOUND` | 修正 `sheet_scope` 的 Sheet 名 |
| `TARGET_COLUMN_MISSING` | 目标列超出模板范围，改列或确认模板版本 |
| `DUPLICATE_SOURCE_KEY` | 默认阻断：确认是否真的同名重复；需要取舍时问用户 |

安全型错误（**不要自己绕过，交回用户**）：`FORMULA_OVERWRITE`、`MERGED_CELL_CONFLICT`、`NON_TARGET_REGION_CHANGED`、`OUTPUT_SAVE_FAILED`、`OUTPUT_REOPEN_FAILED`、`WRITE_READBACK_MISMATCH`。给出冲突单元格、原公式/原值与受影响行数，并给两个可选方案（换目标列 / 接受覆盖）请用户选。

警告不阻断但必须汇报：`UNMATCHED_TEMPLATE_KEY`、`FILE_NOT_FOUND`、`MULTIPLE_MATCH_LATEST_MTIME`、`TEMPLATE_KEY_REPEATED`、`MISSING_VALUE_IN_SOURCE`、`TYPE_CONVERSION_ERROR`。

**修正上限**：同一类错误连续修正 2 次仍失败，或候选之间证据相似无法取舍 → 停下来问用户。

## 5. 通过之后：执行与汇报

`execute_validated_plan` 产出一 SN 一文件 + `validation_report.json`（每 SN 的 matched/unmatched/missing 计数、输出文件与源文件 hash、计划 hash）。输出目录已有报告时工具会拒绝重跑：换新任务或先与用户确认。

汇报固定三段：**计划摘要**（人话规则）、**验证结果**（五道 Gate + 警告/阻断）、**执行结果**（总数 / 成功 / 带警告 / 失败 + 未匹配 Case 与缺失字段汇总）。数字取自工具输出，失败与警告指名 SN。
