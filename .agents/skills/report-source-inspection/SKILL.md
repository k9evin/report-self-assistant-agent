---
name: report-source-inspection
description: Inspect a read-only mounted test-data tree, Excel template and representative XML reports to produce the evidence a ResolvedPlan needs — SN enumeration and report-file selection, per-sheet column statistics with key-column candidates, and XML record/key/field-model candidates under an explicit sampling strategy.
---

# 报告数据源探测

写任何 `ResolvedPlan` 之前先取证据。证据来自两个只读工具：`inspect_template`（模板）与 `inspect_xml_schema`（数据集 + XML）。**没有探测输出的判断一律不写进计划。**

## 工具契约

两个工具都返回 JSON 文本，`--` 之后的参数由后端解析，你只需给出参数：

```text
inspect_template({ template_path?: string, template_id?: string, max_samples?: number })
    -> { template_sha256, sheets:[{name, max_row, max_column, protected,
                                  key_column_candidates:[{column, semantic_hint, non_empty_count,
                                                          unique_ratio, samples}],
                                  formula_cells:[], merged_ranges:[], non_empty_columns:{}}],
         workbook_features:{contains_macros, contains_external_links} }

inspect_xml_schema({ dataset_id: string, pattern?: string, sample_count?: number })
    -> { sn_total, schema_fingerprints:[{fingerprint, sample_count}],
         record_candidates:[{record_selector, record_count,
                             key_candidates:[{selector, non_empty_ratio, unique_ratio, samples}],
                             field_models:[{item_selector, field_name_selector,
                                            field_value_selector, field_samples}]}],
         problems:[{sn, code, ...}] }
```

`dataset_id` 由后端映射到只读挂载路径；你不接触 UNC 与挂载路径。工具不可用或数据集不可读时，如实告知用户并停下。

## 只读纪律

- 数据源是只读挂载：不写、不移动、不改名、不删除；产物只落在任务输出目录。
- 挂载缺失/不可读/越界（`MOUNT_NOT_FOUND` / `DATASET_NOT_FOUND` / `DATASET_OUTSIDE_MOUNT_ROOT`）一律作为错误上报用户，不要改用其它路径试探。
- 挂载可写不是许可：即使系统显示可写，也绝不写源目录。

## 第 1 步：模板探测

读法：

- `key_column_candidates` 按「非空数 ≥ 最强列的一半、且取值近乎唯一」筛出匹配键候选；`semantic_hint` 只是从表头/取值猜的语义线索（`case` / `test_item` / `sn`），**不是结论**。用户说「按 Case 匹配」时，仍要用 `samples` 确认该列确实是 Case 名（前缀、格式一致性）。
- 多个 Sheet、多个候选互不相让 → 不要挑一个写死：用 `sheet_scope` 限定并说明，或请用户确认。
- `formula_cells` / `merged_ranges` 是 Write Safety Gate 的输入：映射的目标列若落在这些位置会被阻断，事先发现就能先请用户决定。

## 第 2 步：XML 结构探测

采样策略（不要只看第一个 SN）：按 mtime 取最早与最新，再取文件大小中位数，其余按 `sample_count` 补足；每个样本算结构指纹 `schema_fingerprints`，指纹不唯一说明存在多种结构，必须逐一确认或请用户澄清。

读法：

- 字段名/字段值按「记录内」语义判定：同一记录内取值互不相同的是**字段名**（如 `item/@name`），随记录变化的是**字段值**（如 `item/@value`）；子元素标签本身即字段名时 `field_name_selector` 为 `null`，取值用 `./child/text()`。
- `record_candidates` 已按「有 Key 且有字段模型」优先排序：首选通常是真正的记录节点，但必须用 `record_count` 与 `samples` 对照需求确认（需求说「每个 task 的 name」，就要看到 `@name` 的样例正是那些 case 名）。
- 排第一不保证正确：`.//item` 这类出现次数最多的节点常常只是字段行、没有 Key。
- 多个候选证据相似（都有 Key、都有字段模型）→ 停下来问用户，不要替用户决定。
- `problems` 里的 `FILE_NOT_FOUND`（SN 缺报告）与 `MULTIPLE_MATCH_LATEST_MTIME`（命中多份、按最新 mtime 选择）是要写进最终报告的异常：前者记警告不中断，后者留审计。

## 交叉核对（写计划前最后一道自检）

1. 模板 Key 列样例值与 XML Key 候选样例值是否**同一套命名**（长度、前缀、大小写、空格）？
2. 需求要的每个字段（如 ge/gr/te/nf）是否都能在 `field_samples` / `field_models` 里找到？
3. 目标列是否落在 `formula_cells` / `merged_ranges`（落在就是阻断风险）？
4. 采样样本的 `schema_fingerprints` 是否唯一？不唯一说明结构不一致。
5. 每个结论是否都能指向一条探测输出（selector / count / sample）？不能的删掉。

核对不过 → 回到探测或问用户；不要把「大概是这样」写进计划。
