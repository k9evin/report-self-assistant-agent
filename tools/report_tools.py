#!/usr/bin/env python3
"""Report Self-Assistant deterministic tool CLI.

Planner 侧工具（探测 + Dry-Run）与确定性 Workflow（单 SN / 批量回填）：

    check-dataset     --mount-root /mnt/mfs/... --relative <sub/path>   # 存在性/只读性/越界校验
    inspect-template  --template T.xlsx
    inspect-xml       --dataset DIR [--pattern '*_test_report*.xml']
    validate-plan     --plan plan.json --dataset DIR --template T.xlsx
    execute-plan      --plan plan.json --dataset DIR --template T.xlsx --out-dir OUT

只读铁律：本脚本对 --dataset / --template 只读；唯一可写位置是临时目录与 --out-dir。

Selector 语法（受限子集，只支持这些形式，其余一律返回 PLAN_SELECTOR_UNSUPPORTED）：

    .//tag          后代元素（用于 record_selector）
    ./tag / tag     直接子元素
    @attr           元素属性
    ./tag/@attr     子元素属性
    ./tag/text()    子元素文本
    text()          元素自身文本

tag / attr 按 local name 匹配（忽略 XML namespace 前缀）。
"""

import argparse
import concurrent.futures
import fnmatch
import hashlib
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone

import xml.etree.ElementTree as ET

from openpyxl import load_workbook
from openpyxl.utils import column_index_from_string, get_column_letter
from openpyxl.utils.cell import range_boundaries

TOOL_VERSION = "1.0"

FORMULA_PREFIX = "="
SCHEMA_ERROR = "PLAN_SELECTOR_UNSUPPORTED"


# --------------------------------------------------------------------------- #
# 小工具
# --------------------------------------------------------------------------- #

def local(tag):
    """去掉 namespace，取 local name。"""
    if not isinstance(tag, str):
        return ""
    return tag.rsplit("}", 1)[-1]


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def emit(obj, out_path=None):
    text = json.dumps(obj, ensure_ascii=False, indent=2)
    if out_path:
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
    print(text)


def die(code, message, **extra):
    emit({"status": "tool_error", "code": code, "message": message, **extra})
    sys.exit(2)


def col_letter(idx):
    return get_column_letter(idx)


def col_index(letter):
    return column_index_from_string(letter)


# --------------------------------------------------------------------------- #
# Selector 解析
# --------------------------------------------------------------------------- #

def parse_selector(selector):
    """把 selector 解析为 (axis, steps, leaf)。

    axis: 'descendant' (.//) | 'child' (./ or bare)
    steps: tuple of tag names
    leaf: ('element', None) | ('attr', name) | ('text', None)
    """
    if not isinstance(selector, str) or not selector.strip():
        raise ValueError("empty selector")
    sel = selector.strip()
    leaf = ("element", None)
    if sel.startswith("@"):
        # 裸属性 selector（如 "@name"）同样要校验属性名：否则 "@" / "@a/b" 会被静默接受却永远匹配不到。
        if not re.fullmatch(r"[A-Za-z_][\w.\-]*", sel[1:]):
            raise ValueError("unsupported attribute name: {!r}".format(sel[1:]))
        return ("self", (), ("attr", sel[1:]))
    if sel.endswith("/text()"):
        sel = sel[: -len("/text()")]
        leaf = ("text", None)
    elif sel in ("text()", "./text()", ".//text()"):
        return ("self", (), ("text", None))
    else:
        head, sep, tail = sel.rpartition("/@")
        if sep:
            sel, leaf = head, ("attr", tail)
    axis = "child"
    if sel.startswith(".//"):
        axis, sel = "descendant", sel[3:]
    elif sel.startswith("//"):
        axis, sel = "descendant", sel[2:]
    elif sel.startswith("./"):
        axis, sel = "child", sel[2:]
    elif sel.startswith("."):
        sel = sel[1:]
    steps = tuple(s for s in sel.split("/") if s not in ("", "."))
    if leaf[0] == "element" and not steps:
        raise ValueError("selector has no element step")
    for step in steps:
        if not re.fullmatch(r"[A-Za-z_][\w.\-]*", step):
            raise ValueError("unsupported selector step: {!r} (predicates, wildcards, "
                             "namespaces and XPath functions are not supported)".format(step))
    if leaf[0] == "attr" and not re.fullmatch(r"[A-Za-z_][\w.\-]*", leaf[1] or ""):
        raise ValueError("unsupported attribute name: {!r}".format(leaf[1]))
    return (axis, steps, leaf)


def elements_under(node, parsed):
    axis, steps, leaf = parsed
    if axis == "self":
        return [node]
    current = [node]
    for step in steps:
        nxt = []
        for el in current:
            if axis == "descendant":
                nxt.extend([c for c in el.iter() if c is not el and local(c.tag) == step])
            else:
                nxt.extend([c for c in list(el) if local(c.tag) == step])
        current = nxt
        if not current:
            return []
    return current


def get_attr(el, name):
    if name in el.attrib:
        return el.attrib[name]
    for key, value in el.attrib.items():
        if local(key) == name:
            return value
    return None


def selector_value(el, selector):
    """在元素上取值；返回 str 或 None。"""
    parsed = parse_selector(selector)
    axis, steps, leaf = parsed
    if axis == "self" and leaf[0] == "text":
        return (el.text or "").strip() or None
    nodes = elements_under(el, parsed)
    if leaf[0] == "element":
        if not nodes:
            return None
        return (nodes[0].text or "").strip() or None
    if not nodes:
        return None
    if leaf[0] == "attr":
        return get_attr(nodes[0], leaf[1])
    if leaf[0] == "text":
        return (nodes[0].text or "").strip() or None
    return None


def selector_elements(el, selector):
    return elements_under(el, parse_selector(selector))


# --------------------------------------------------------------------------- #
# dataset 侧：SN 枚举与源文件选择
# --------------------------------------------------------------------------- #

def enumerate_sn_dirs(dataset, limit=None):
    if not os.path.isdir(dataset):
        die("DATASET_NOT_FOUND", "dataset path is not a readable directory", dataset=dataset)
    sns = []
    for entry in sorted(os.scandir(dataset), key=lambda e: e.name):
        if entry.is_dir():
            sns.append(entry.path)
    return sns[:limit] if limit else sns


def select_report_file(sn_dir, pattern):
    """返回 (path, matches, note)。多个匹配默认取最新 mtime。"""
    matches = []
    for entry in os.scandir(sn_dir):
        if entry.is_file() and fnmatch.fnmatch(entry.name, pattern):
            matches.append(entry.path)
    if not matches:
        return None, [], "FILE_NOT_FOUND"
    matches.sort(key=lambda p: (os.path.getmtime(p), p))
    if len(matches) == 1:
        return matches[0], matches, None
    return matches[-1], matches, "MULTIPLE_MATCH_LATEST_MTIME"


def sample_sns(sn_dirs, count, pattern):
    """按 PRD 采样策略挑代表性 SN：最早、最新、文件中位数、结构指纹不同。"""
    if not sn_dirs:
        return []
    with_file = []
    for sn in sn_dirs:
        path, _, _ = select_report_file(sn, pattern)
        if path:
            with_file.append((sn, path, os.path.getsize(path)))
    if not with_file:
        return sn_dirs[:count]
    ordered = sorted(with_file, key=lambda t: os.path.getmtime(t[1]))
    picked = []
    for cand in (ordered[0], ordered[-1]):
        if cand[0] not in [p[0] for p in picked]:
            picked.append(cand)
    by_size = sorted(with_file, key=lambda t: t[2])
    mid = by_size[len(by_size) // 2]
    if mid[0] not in [p[0] for p in picked]:
        picked.append(mid)
    for cand in ordered:
        if len(picked) >= count:
            break
        if cand[0] not in [p[0] for p in picked]:
            picked.append(cand)
    return [p[0] for p in picked[:count]]


# --------------------------------------------------------------------------- #
# inspect-template
# --------------------------------------------------------------------------- #

def guess_semantic_hint(ws, col, values):
    """从表头行与列内取值猜测语义（case / test_item / sn），猜不出返回 None。"""
    keywords = (("test item", "test_item"), ("testitem", "test_item"), ("item", "test_item"),
                ("case", "case"), ("sn", "sn"), ("serial", "sn"))
    for row in range(1, min(4, (ws.max_row or 0) + 1)):
        value = ws.cell(row=row, column=col).value
        if not isinstance(value, str):
            continue
        text = value.strip().lower()
        if not text or len(text) > 40:
            continue
        for needle, hint in keywords:
            if needle in text:
                return hint
    lowered = [str(v).lower() for v in values]
    for needle, hint in (("case", "case"), ("sn", "sn")):
        hits = sum(1 for text in lowered if needle in text)
        if hits >= max(2, 0.3 * len(lowered)):
            return hint
    return None


def inspect_template(template_path, max_samples=3, max_formula_cells=20):
    if not os.path.isfile(template_path):
        die("TEMPLATE_NOT_FOUND", "template file does not exist", template=template_path)
    try:
        wb = load_workbook(template_path, data_only=False)
    except Exception as exc:  # noqa: BLE001
        die("TEMPLATE_UNREADABLE", f"cannot open workbook: {exc}", template=template_path)

    sheets = []
    for ws in wb.worksheets:
        max_row = ws.max_row or 0
        max_col = ws.max_column or 0
        column_stats = {}
        for col in range(1, max_col + 1):
            values = []
            for row in range(1, max_row + 1):
                value = ws.cell(row=row, column=col).value
                if value is None or (isinstance(value, str) and not value.strip()):
                    continue
                values.append(value)
            if values:
                column_stats[col_letter(col)] = values
        top = max((len(v) for v in column_stats.values()), default=0)
        key_candidates = []
        for letter, values in column_stats.items():
            if len(values) < 2 or len(values) < top * 0.5:
                continue
            unique_ratio = len(set(map(str, values))) / len(values)
            if unique_ratio < 0.8:
                continue
            key_candidates.append({
                "column": letter,
                "non_empty_count": len(values),
                "unique_ratio": round(unique_ratio, 4),
                "samples": [str(v) for v in values[:max_samples]],
                "semantic_hint": guess_semantic_hint(ws, col_index(letter), values),
            })
        key_candidates.sort(key=lambda c: -c["non_empty_count"])
        key_candidates = key_candidates[:5]

        formula_cells = []
        for row in ws.iter_rows():
            for cell in row:
                if isinstance(cell.value, str) and cell.value.startswith(FORMULA_PREFIX):
                    formula_cells.append(cell.coordinate)
                    if len(formula_cells) >= max_formula_cells:
                        break
            if len(formula_cells) >= max_formula_cells:
                break

        sheets.append({
            "name": ws.title,
            "max_row": max_row,
            "max_column": max_col,
            "key_column_candidates": key_candidates,
            "formula_cells": formula_cells,
            "merged_ranges": [str(r) for r in ws.merged_cells.ranges][:20],
            "protected": bool(ws.protection.sheet),
            "non_empty_columns": {k: len(v) for k, v in sorted(column_stats.items(), key=lambda kv: col_index(kv[0]))},
        })

    features = {
        "contains_macros": template_path.lower().endswith((".xlsm", ".xltm")),
        "contains_external_links": bool(getattr(wb, "_external_links", None)),
    }
    wb.close()
    return {
        "tool": "inspect_template",
        "tool_version": TOOL_VERSION,
        "template": os.path.abspath(template_path),
        "template_sha256": sha256_file(template_path),
        "sheets": sheets,
        "workbook_features": features,
    }


# --------------------------------------------------------------------------- #
# inspect-xml
# --------------------------------------------------------------------------- #

def attribute_stats(elements, attr):
    values = [get_attr(el, attr) for el in elements]
    non_empty = [v for v in values if v not in (None, "")]
    if not non_empty:
        return None
    return {
        "selector": "@" + attr,
        "non_empty_ratio": round(len(non_empty) / len(elements), 4),
        "unique_ratio": round(len(set(non_empty)) / len(non_empty), 4),
        "samples": non_empty[:3],
    }


def attribute_within_record_distinct(groups, attr):
    """记录内取值两两不同（字段名）的组占比；取值随记录变化（字段值）的组占比。"""
    if not groups:
        return 0.0, 0.0
    distinct, varying = 0, 0
    for group in groups:
        values = [get_attr(c, attr) for c in group]
        values = [v for v in values if v not in (None, "")]
        if values and len(set(values)) == len(values):
            distinct += 1
        if len(set(values)) > 1:
            varying += 1
    return distinct / len(groups), varying / len(groups)


def analyze_document(root):
    """通用探测：重复出现的记录候选 + Key 候选 + 字段模型候选。

    字段名/字段值按「记录内」语义判断：同一个记录内取值互不相同的是字段名（如 item@name），
    跨记录取值变化的是字段值（如 item@value）；子元素标签即字段名时 field_name_selector 为 null。
    """
    by_tag = {}
    for el in root.iter():
        name = local(el.tag)
        if name:
            by_tag.setdefault(name, []).append(el)

    record_candidates = []
    for tag, elements in by_tag.items():
        if len(elements) < 2:
            continue
        attrs = sorted({local(a) for el in elements for a in el.attrib})
        key_candidates = []
        for attr in attrs:
            stat = attribute_stats(elements, attr)
            if stat and stat["non_empty_ratio"] >= 0.9 and stat["unique_ratio"] >= 0.9:
                key_candidates.append(stat)

        child_tags = {}
        for el in elements:
            for child in list(el):
                child_tags[local(child.tag)] = child_tags.get(local(child.tag), 0) + 1

        field_models = []
        for child_tag, child_count in sorted(child_tags.items(), key=lambda kv: -kv[1]):
            groups = [[c for c in list(el) if local(c.tag) == child_tag] for el in elements]
            groups = [g for g in groups if g]
            if not groups:
                continue
            children = [c for g in groups for c in g]
            child_attrs = sorted({local(a) for c in children for a in c.attrib})

            name_attr, value_attr = None, None
            name_samples = []
            for attr in child_attrs:
                present = sum(1 for c in children if get_attr(c, attr) not in (None, ""))
                if present / len(children) < 0.9:
                    continue
                distinct_ratio, varying_ratio = attribute_within_record_distinct(groups, attr)
                if name_attr is None and distinct_ratio >= 0.9:
                    name_attr = attr
                    name_samples = [get_attr(c, attr) for c in children][:4]
                elif value_attr is None and value_attr != attr:
                    value_attr = attr
            if name_attr is not None and value_attr == name_attr:
                value_attr = None
            text_samples = [(c.text or "").strip() for c in children if (c.text or "").strip()]
            if value_attr:
                value_selector = "@" + value_attr
                samples = name_samples or [get_attr(c, value_attr) for c in children][:4]
            elif text_samples:
                value_selector = "./{}/text()".format(child_tag)
                samples = name_samples or text_samples[:4]
            else:
                continue
            field_models.append({
                "item_selector": "./" + child_tag,
                "field_name_selector": ("@" + name_attr) if name_attr else None,
                "field_value_selector": value_selector,
                "child_count": child_count,
                "field_samples": samples,
            })
        record_candidates.append({
            "record_selector": ".//" + tag,
            "record_count": len(elements),
            "key_candidates": key_candidates[:5],
            "field_models": field_models[:5],
        })

    # 有 Key 且有字段模型的候选优先（更可能是真正的记录节点），其余按出现次数排序。
    record_candidates.sort(key=lambda c: (bool(c["key_candidates"]) and bool(c["field_models"]),
                                          c["record_count"]), reverse=True)
    return record_candidates[:5]


def load_xml(path):
    """Parse XML bytes, recovering common Chinese encodings when declarations are wrong."""
    raw = open(path, "rb").read()
    try:
        return ET.fromstring(raw)
    except ET.ParseError as initial_error:
        failures = {"declared": str(initial_error)}
        for encoding in ("utf-8", "gb18030"):
            try:
                return ET.fromstring(raw.decode(encoding))
            except (UnicodeDecodeError, ET.ParseError) as exc:
                failures[encoding] = str(exc)
        raise ValueError(f"XML encoding or syntax error: {failures}") from initial_error


def structural_fingerprint(root):
    sig = []
    for el in root.iter():
        sig.append(local(el.tag) + ":" + ",".join(sorted(local(a) for a in el.attrib)))
    return hashlib.sha256("\n".join(sig).encode("utf-8")).hexdigest()[:16]


def inspect_xml(dataset, pattern, sample_count):
    sn_dirs = enumerate_sn_dirs(dataset)
    picked = sample_sns(sn_dirs, sample_count, pattern)
    if not picked:
        die("DATASET_EMPTY", "no SN directory found under dataset", dataset=dataset)

    fingerprints = {}
    candidates = {}
    record_counts = {}
    problems = []
    samples_used = []
    for sn_dir in picked:
        path, matches, note = select_report_file(sn_dir, pattern)
        if not path:
            problems.append({"sn": os.path.basename(sn_dir), "code": "FILE_NOT_FOUND", "pattern": pattern})
            continue
        if note:
            problems.append({"sn": os.path.basename(sn_dir), "code": note,
                             "matches": [os.path.basename(m) for m in matches]})
        try:
            root = load_xml(path)
        except Exception as exc:  # noqa: BLE001
            problems.append({"sn": os.path.basename(sn_dir), "code": "XML_PARSE_ERROR", "message": str(exc)})
            continue
        fp = structural_fingerprint(root)
        fingerprints[fp] = fingerprints.get(fp, 0) + 1
        samples_used.append({"sn": os.path.basename(sn_dir),
                             "file": os.path.basename(path),
                             "sha256": sha256_file(path),
                             "fingerprint": fp,
                             "size": os.path.getsize(path)})
        for cand in analyze_document(root):
            key = cand["record_selector"]
            bucket = candidates.setdefault(key, {"record_selector": key, "record_count": 0,
                                                 "key_candidates": {}, "field_models": {}})
            bucket["record_count"] += cand["record_count"]
            for kc in cand["key_candidates"]:
                cur = bucket["key_candidates"].get(kc["selector"], {"selector": kc["selector"], "samples": kc["samples"]})
                cur.setdefault("non_empty_ratio", kc["non_empty_ratio"])
                cur.setdefault("unique_ratio", kc["unique_ratio"])
                bucket["key_candidates"][kc["selector"]] = cur
            for fm in cand["field_models"]:
                fkey = "|".join([fm["item_selector"], str(fm["field_name_selector"]), fm["field_value_selector"]])
                bucket["field_models"][fkey] = {k: fm[k] for k in
                                                ("item_selector", "field_name_selector",
                                                 "field_value_selector", "field_samples")}
            record_counts[key] = record_counts.get(key, 0) + cand["record_count"]

    ordered = sorted(candidates.values(),
                     key=lambda c: (bool(c["key_candidates"]) and bool(c["field_models"]),
                                    c["record_count"]), reverse=True)
    for cand in ordered:
        cand["key_candidates"] = list(cand["key_candidates"].values())
        cand["field_models"] = list(cand["field_models"].values())
    return {
        "tool": "inspect_xml",
        "tool_version": TOOL_VERSION,
        "dataset": os.path.abspath(dataset),
        "pattern": pattern,
        "sn_total": len(sn_dirs),
        "sample_strategy": "earliest_mtime, latest_mtime, median_size",
        "samples": samples_used,
        "schema_fingerprints": [{"fingerprint": fp, "sample_count": n}
                                for fp, n in sorted(fingerprints.items(), key=lambda kv: -kv[1])],
        "record_candidates": ordered,
        "problems": problems,
    }


# --------------------------------------------------------------------------- #
# check-dataset：挂载与只读性校验（任务前必须先过这一关）
# --------------------------------------------------------------------------- #

def check_dataset(mount_root, relative="", dataset_id=None, pattern="*_test_report*.xml"):
    """校验数据集路径：存在、可读、且不越出挂载根（阻断 ../ 与符号链接逃逸）。"""
    problems, warnings = [], []
    report = {
        "tool": "check_dataset",
        "tool_version": TOOL_VERSION,
        "dataset_id": dataset_id,
        "mount_root": mount_root,
        "relative_path": relative or ".",
        "pattern": pattern,
    }
    if not os.path.isdir(mount_root):
        report.update({"ok": False, "resolved_path": None,
                       "problems": [{"code": "MOUNT_NOT_FOUND", "mount_root": mount_root}]})
        return report

    root_real = os.path.realpath(mount_root)
    requested = os.path.join(mount_root, relative) if relative else mount_root
    requested_real = os.path.realpath(requested)
    inside = requested_real == root_real or requested_real.startswith(root_real + os.sep)

    report["resolved_path"] = requested_real
    report["symlink_resolved"] = os.path.abspath(requested) != requested_real
    report["inside_mount_root"] = inside

    if not inside:
        problems.append({"code": "DATASET_OUTSIDE_MOUNT_ROOT",
                         "resolved_path": requested_real, "mount_root": root_real})
    if not os.path.exists(requested_real):
        problems.append({"code": "DATASET_NOT_FOUND", "resolved_path": requested_real})
    elif not os.path.isdir(requested_real):
        problems.append({"code": "DATASET_NOT_DIRECTORY", "resolved_path": requested_real})
    elif not os.access(requested_real, os.R_OK | os.X_OK):
        problems.append({"code": "DATASET_NOT_READABLE", "resolved_path": requested_real})

    if not problems:
        writable = os.access(requested_real, os.W_OK)
        report["writable_by_process"] = writable
        if writable:
            warnings.append({"code": "MOUNT_WRITABLE",
                             "message": "数据源对本进程可写，建议以 ro 挂载 + 只读账号双保险"})
        sn_dirs = [e.name for e in sorted(os.scandir(requested_real), key=lambda e: e.name) if e.is_dir()]
        report["sn_count"] = len(sn_dirs)
        report["sample_sn_dirs"] = sn_dirs[:5]
        sample_files = []
        for sn in sn_dirs[:3]:
            path, matches, note = select_report_file(os.path.join(requested_real, sn), pattern)
            sample_files.append({"sn": sn, "report_file": os.path.basename(path) if path else None,
                                 "matches": len(matches), "note": note})
        report["sample_report_files"] = sample_files
        if not sn_dirs:
            warnings.append({"code": "NO_SN_DIRECTORY", "message": "数据集下没有 SN 目录"})
    else:
        report["writable_by_process"] = None

    report["problems"] = problems
    report["warnings"] = warnings
    report["ok"] = not problems
    return report


# --------------------------------------------------------------------------- #
# plan 读取与校验
# --------------------------------------------------------------------------- #

REQUIRED_PLAN_KEYS = ("output", "source_file", "source_records", "template")


def load_plan(plan_path):
    if not os.path.isfile(plan_path):
        die("PLAN_NOT_FOUND", "plan file does not exist", plan=plan_path)
    with open(plan_path, encoding="utf-8") as fh:
        raw = fh.read()
    try:
        plan = json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        die("PLAN_INVALID", f"plan file is not valid JSON: {exc}", plan=plan_path)

    # 宽容化修复：如果 plan 是 JSON 字符串或包装了 Markdown 语法
    if isinstance(plan, str):
        clean = plan.strip()
        if clean.startswith("```"):
            clean = re.sub(r"^```(?:json)?\s*", "", clean)
            clean = re.sub(r"\s*```$", "", clean).strip()
        try:
            plan = json.loads(clean)
        except Exception:  # noqa: BLE001
            pass

    if isinstance(plan, dict):
        # 兼容顶层包装 { "plan": { ... } }
        if "plan" in plan and isinstance(plan["plan"], (dict, str)):
            inner = plan["plan"]
            if isinstance(inner, str):
                try:
                    inner = json.loads(inner)
                except Exception:  # noqa: BLE001
                    pass
            if isinstance(inner, dict):
                plan = inner

        # 兼容 plan_version 误填为字符串
        if isinstance(plan.get("plan_version"), str) and plan["plan_version"].isdigit():
            plan["plan_version"] = int(plan["plan_version"])

        # 兼容小模型将子对象序列化为字符串
        for subkey in ("output", "source_file", "source_records", "template", "normalization"):
            if isinstance(plan.get(subkey), str):
                try:
                    plan[subkey] = json.loads(plan[subkey])
                except Exception:  # noqa: BLE001
                    pass

        if isinstance(plan.get("template"), dict):
            tmpl = plan["template"]
            for subkey in ("join", "mappings"):
                if isinstance(tmpl.get(subkey), str):
                    try:
                        tmpl[subkey] = json.loads(tmpl[subkey])
                    except Exception:  # noqa: BLE001
                        pass

        if isinstance(plan.get("source_records"), dict):
            src = plan["source_records"]
            if isinstance(src.get("field_storage"), str):
                try:
                    src["field_storage"] = json.loads(src["field_storage"])
                except Exception:  # noqa: BLE001
                    pass

    if not isinstance(plan, dict):
        die("PLAN_INVALID", "plan must be a JSON object", plan=plan_path)

    missing = [k for k in REQUIRED_PLAN_KEYS if k not in plan]
    if missing:
        die("PLAN_INVALID", "plan is missing required keys", missing=missing)
    return plan


def plan_supported(plan):
    """检查 plan 里用到的 selector / match_mode 是否在工具支持范围内。"""
    problems = []
    src = plan["source_records"]
    for field, sel in (("record_selector", src.get("record_selector")),
                       ("key_selector", src.get("key_selector")),
                       ("item_selector", (src.get("field_storage") or {}).get("item_selector")),
                       ("field_name_selector", (src.get("field_storage") or {}).get("field_name_selector")),
                       ("field_value_selector", (src.get("field_storage") or {}).get("field_value_selector"))):
        try:
            parse_selector(sel)
        except Exception as exc:  # noqa: BLE001
            problems.append({"code": SCHEMA_ERROR, "field": field, "selector": sel, "message": str(exc)})
    mode = ((plan["template"].get("join") or {}).get("match_mode"))
    if mode not in (None, "normalized_exact", "exact"):
        problems.append({"code": SCHEMA_ERROR, "field": "template.join.match_mode", "value": mode,
                         "message": "only 'exact' and 'normalized_exact' are supported"})
    if plan["output"].get("mode") not in ("one_file_per_sn",):
        problems.append({"code": SCHEMA_ERROR, "field": "output.mode", "value": plan["output"].get("mode"),
                         "message": "only 'one_file_per_sn' is supported by this executor"})
    for idx, mapping in enumerate(plan["template"].get("mappings") or []):
        for key in ("source_field", "target_column"):
            if not mapping.get(key):
                problems.append({"code": SCHEMA_ERROR, "field": f"template.mappings[{idx}].{key}",
                                 "message": "required"})
    return problems


def build_case_index(xml_path, plan):
    src = plan["source_records"]
    root = load_xml(xml_path)
    record_sel = src["record_selector"]
    key_sel = src["key_selector"]
    storage = src.get("field_storage") or {}
    item_sel = storage.get("item_selector")
    name_sel = storage.get("field_name_selector")
    value_sel = storage.get("field_value_selector")

    records = []
    for record in selector_elements(root, record_sel):
        key = key_sel and selector_value(record, key_sel)
        fields = {}
        if item_sel:
            for item in selector_elements(record, item_sel):
                name = selector_value(item, name_sel) if name_sel else local(item.tag)
                value = selector_value(item, value_sel)
                if name:
                    fields[name] = value
        else:
            fields = None
        records.append({"key": key, "fields": fields})

    index, duplicates = {}, []
    for rec in records:
        key = rec["key"]
        if key is None or key == "":
            continue
        if key in index:
            duplicates.append(key)
            continue
        index[key] = rec["fields"]
    return {"root": root, "records": records, "index": index, "duplicates": duplicates,
            "record_count": len(records), "file": xml_path}


def normalize(value, plan):
    if value is None:
        return None
    text = str(value)
    if (plan.get("normalization") or {}).get("trim_whitespace", True):
        text = text.strip()
    if not (plan.get("normalization") or {}).get("case_sensitive", True):
        text = text.lower()
    return text


def plan_rows(ws, key_column):
    key_idx = col_index(key_column)
    rows = []
    for row in range(1, (ws.max_row or 0) + 1):
        value = ws.cell(row=row, column=key_idx).value
        if value is None or (isinstance(value, str) and not value.strip()):
            continue
        rows.append((row, value))
    return rows


def target_cells(ws, row, mappings):
    return [f"{m['target_column']}{row}" for m in mappings]


def merged_lookup(ws):
    lookup = {}
    for rng in ws.merged_cells.ranges:
        min_col, min_row, max_col, max_row = range_boundaries(str(rng))
        for row in range(min_row, max_row + 1):
            for col in range(min_col, max_col + 1):
                lookup[(row, col)] = (str(rng), (row == min_row and col == min_col))
    return lookup


def sheet_scope(plan, wb):
    """返回 (选中的 sheets, 缺失的 sheet 名)。sheet_scope 取值：'all' | 'A,B' | ['A']。"""
    scope = plan["template"].get("sheet_scope") or "all"
    if scope == "all":
        return list(wb.worksheets), []
    if isinstance(scope, list):
        wanted = [str(s).strip() for s in scope if str(s).strip()]
    else:
        wanted = [s.strip() for s in str(scope).split(",") if s.strip()]
    by_name = {ws.title: ws for ws in wb.worksheets}
    missing = [name for name in wanted if name not in by_name]
    return [by_name[n] for n in wanted if n in by_name], missing


def fill_workbook(wb, plan, index, merge_lookup_cache):
    """按 plan 回填，返回 (stats, issues)。不保存。"""
    template = plan["template"]
    join = template.get("join") or {}
    key_column = join.get("template_key_column")
    mappings = template.get("mappings") or []
    matched_records = set()
    stats = {
        "rows_scanned": 0, "rows_matched": 0, "rows_unmatched": 0,
        "cells_written": 0, "missing_values": 0, "type_conversion_errors": 0,
        "formula_conflicts": [], "merged_conflicts": [], "unmatched_keys": [],
    }
    sheets, missing_sheets = sheet_scope(plan, wb)
    stats["missing_sheets"] = missing_sheets
    for ws in sheets:
        merge_lookup = merge_lookup_cache.setdefault(ws.title, merged_lookup(ws))
        for row, raw_key in plan_rows(ws, key_column):
            stats["rows_scanned"] += 1
            key = normalize(raw_key, plan)
            record = index.get(key)
            if record is None and (plan.get("normalization") or {}).get("trim_whitespace", True):
                record = index.get(str(raw_key))
            if record is None:
                stats["rows_unmatched"] += 1
                if len(stats["unmatched_keys"]) < 20:
                    stats["unmatched_keys"].append({"sheet": ws.title, "row": row, "key": str(raw_key)})
                continue
            matched_records.add(key)
            stats["rows_matched"] += 1
            for mapping in mappings:
                field = mapping["source_field"]
                coordinate = f"{mapping['target_column']}{row}"
                cell = ws[coordinate]
                if merge_lookup.get((row, col_index(mapping["target_column"]))) and \
                        not merge_lookup[(row, col_index(mapping["target_column"]))][1]:
                    stats["merged_conflicts"].append({"sheet": ws.title, "cell": coordinate,
                                                      "range": merge_lookup[(row, col_index(mapping["target_column"]))][0]})
                    continue
                if isinstance(cell.value, str) and cell.value.startswith(FORMULA_PREFIX):
                    stats["formula_conflicts"].append({"sheet": ws.title, "cell": coordinate,
                                                       "formula": cell.value})
                    continue
                value = record.get(field)
                if value is None or value == "":
                    stats["missing_values"] += 1
                    continue
                cell.value = coerce_value(value, stats)
                stats["cells_written"] += 1
    stats["unmatched_record_keys"] = sorted(k for k in index if k not in matched_records)[:20]
    stats["unmatched_record_key_count"] = len([k for k in index if k not in matched_records])
    return stats


def coerce_value(value, stats):
    text = str(value).strip()
    try:
        return float(text)
    except ValueError:
        stats["type_conversion_errors"] += 1
        return text


def values_equal(a, b):
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    try:
        fa, fb = float(a), float(b)
        if fa == fb:
            return True
        scale = max(abs(fa), abs(fb), 1.0)
        return abs(fa - fb) <= 1e-9 * scale
    except (TypeError, ValueError):
        return str(a).strip() == str(b).strip()


def snapshot_workbook(wb, skip_cells=()):
    snap = {}
    skip = set(skip_cells)
    for ws in wb.worksheets:
        cells = {}
        for row in ws.iter_rows():
            for cell in row:
                if cell.coordinate in skip:
                    continue
                if cell.value is not None:
                    cells[cell.coordinate] = str(cell.value)
        snap[ws.title] = {"cells": cells, "merged": sorted(str(r) for r in ws.merged_cells.ranges)}
    return snap


def diff_snapshot(before, after, allowed_changes):
    differences = []
    for sheet, data in before.items():
        if sheet not in after:
            differences.append({"code": "SHEET_MISSING", "sheet": sheet})
            continue
        if data["merged"] != after[sheet]["merged"]:
            differences.append({"code": "MERGED_RANGE_CHANGED", "sheet": sheet})
        for coordinate, value in data["cells"].items():
            if coordinate in allowed_changes:
                continue
            now = after[sheet]["cells"].get(coordinate)
            if now != value:
                differences.append({"code": "NON_TARGET_CELL_CHANGED", "sheet": sheet,
                                    "cell": coordinate, "before": value, "after": now})
    return differences


# --------------------------------------------------------------------------- #
# validate-plan（Dry-Run）
# --------------------------------------------------------------------------- #

def validate_plan(plan, dataset, template_path, sample_count, work_dir):
    gates = {"source_schema_valid": "pass", "template_structure_valid": "pass",
             "join_valid": "pass", "write_safe": "pass", "output_integrity_valid": "pass"}
    errors = []
    warnings = []
    validation = {}

    unsupported = plan_supported(plan)
    if unsupported:
        for problem in unsupported:
            gates["source_schema_valid"] = "fail"
            errors.append(problem)
        return rejected(validation, gates, errors, warnings)

    sn_dirs = enumerate_sn_dirs(dataset)
    pattern = (plan["source_file"] or {}).get("pattern") or "*_test_report*.xml"
    picked = sample_sns(sn_dirs, sample_count, pattern)
    validation["sn_total"] = len(sn_dirs)
    validation["sample_sn_count"] = len(picked)
    validation["sample_sns"] = [os.path.basename(p) for p in picked]

    # ---- Gate 1: source schema（多个样本聚合证据，不做单样本结论） ----
    builds = []
    for sn_dir in picked:
        path, matches, note = select_report_file(sn_dir, pattern)
        if not path:
            warnings.append({"code": "FILE_NOT_FOUND", "sn": os.path.basename(sn_dir), "count": 1})
            continue
        if note:
            warnings.append({"code": note, "sn": os.path.basename(sn_dir),
                             "matches": [os.path.basename(m) for m in matches]})
        try:
            builds.append((os.path.basename(sn_dir), build_case_index(path, plan)))
        except ET.ParseError as exc:
            gates["source_schema_valid"] = "fail"
            errors.append({"code": "XML_PARSE_ERROR", "sn": os.path.basename(sn_dir), "message": str(exc)})

    if not builds:
        gates["source_schema_valid"] = "fail"
        errors.append({"code": "NO_SAMPLE_FILE", "message": "no sample XML could be read", "dataset": dataset})
        return rejected(validation, gates, errors, warnings)

    index = builds[0][1]
    key_sel = plan["source_records"].get("key_selector")
    validation["source_record_count"] = sum(b["record_count"] for _, b in builds)
    validation["samples_read"] = len(builds)
    empty_keys = sum(1 for _, b in builds for r in b["records"] if r["key"] in (None, ""))
    duplicates = [k for _, b in builds for k in b["duplicates"]]
    validation["empty_key_count"] = empty_keys
    validation["duplicate_source_key_count"] = len(duplicates)

    if any(b["record_count"] == 0 for _, b in builds):
        gates["source_schema_valid"] = "fail"
        inspection = inspect_xml(dataset, pattern, min(2, max(1, len(picked))))
        errors.append({
            "code": "RECORD_SELECTOR_NO_MATCH",
            "selector": plan["source_records"]["record_selector"],
            "matched_count": 0,
            "record_candidates": [{"selector": c["record_selector"], "record_count": c["record_count"],
                                   "key_candidates": [k["selector"] for k in c["key_candidates"]]}
                                  for c in inspection["record_candidates"]],
        })
    if empty_keys:
        gates["source_schema_valid"] = "fail"
        errors.append({"code": "KEY_SELECTOR_EMPTY", "selector": key_sel, "empty_count": empty_keys})
    if duplicates:
        policy = plan.get("duplicate_source_key_policy", "block")
        entry = {"code": "DUPLICATE_SOURCE_KEY", "count": len(duplicates), "samples": duplicates[:5]}
        if policy == "block":
            gates["source_schema_valid"] = "fail"
            errors.append(entry)
        else:
            warnings.append(entry)
    if all(r["fields"] in (None, {}) for _, b in builds for r in b["records"]):
        gates["source_schema_valid"] = "fail"
        inspection = inspect_xml(dataset, pattern, min(2, max(1, len(picked))))
        errors.append({
            "code": "FIELD_STRUCTURE_NO_MATCH",
            "selector": (plan["source_records"].get("field_storage") or {}).get("item_selector"),
            "matched_count": 0,
            "field_model_candidates": [fm for c in inspection["record_candidates"] for fm in c["field_models"]][:5],
        })
    if gates["source_schema_valid"] == "fail":
        return rejected(validation, gates, errors, warnings)

    # ---- Gate 2/3: template + join ----
    try:
        wb = load_workbook(template_path, data_only=False)
    except Exception as exc:  # noqa: BLE001
        gates["template_structure_valid"] = "fail"
        errors.append({"code": "TEMPLATE_UNREADABLE", "message": str(exc)})
        return rejected(validation, gates, errors, warnings)

    join = plan["template"].get("join") or {}
    key_column = join.get("template_key_column")
    if not key_column:
        gates["template_structure_valid"] = "fail"
        errors.append({"code": "TEMPLATE_KEY_COLUMN_MISSING", "message": "template.join.template_key_column is required"})
        return rejected(validation, gates, errors, warnings)

    sheets, missing_sheets = sheet_scope(plan, wb)
    if missing_sheets:
        gates["template_structure_valid"] = "fail"
        errors.append({"code": "SHEET_NOT_FOUND", "sheets": missing_sheets})

    template_keys = {}
    template_rows = 0
    for ws in sheets:
        rows = plan_rows(ws, key_column)
        template_rows += len(rows)
        for row, value in rows:
            key = normalize(value, plan)
            template_keys.setdefault(key, []).append((ws.title, row))
    validation["template_unique_key_count"] = len(template_keys)
    validation["template_key_row_count"] = template_rows
    if template_rows == 0:
        gates["template_structure_valid"] = "fail"
        errors.append({"code": "TEMPLATE_KEY_COLUMN_EMPTY", "column": key_column,
                       "sheets": [ws.title for ws in sheets]})
        return rejected(validation, gates, errors, warnings)

    duplicate_template_keys = {k: v for k, v in template_keys.items() if len(v) > 1}
    if duplicate_template_keys:
        warnings.append({"code": "TEMPLATE_KEY_REPEATED", "count": len(duplicate_template_keys),
                         "samples": list(duplicate_template_keys)[:5]})

    mappings = plan["template"].get("mappings") or []
    missing_columns = sorted({m["target_column"] for m in mappings
                              if col_index(m["target_column"]) > (max((ws.max_column or 0) for ws in sheets) or 0)})
    if missing_columns:
        gates["template_structure_valid"] = "fail"
        errors.append({"code": "TARGET_COLUMN_MISSING", "columns": missing_columns,
                       "max_column": max((ws.max_column or 0) for ws in sheets)})

    source_keys = set(index["index"])
    matched = len(set(template_keys) & source_keys)
    unmatched = len(set(template_keys) - source_keys)
    source_only = len(source_keys - set(template_keys))
    validation["exact_match_count"] = matched
    validation["unmatched_key_count"] = unmatched
    validation["source_only_key_count"] = source_only
    if matched == 0:
        gates["join_valid"] = "fail"
        errors.append({"code": "JOIN_NO_MATCH", "template_key_column": key_column,
                       "source_key": join.get("source_key"),
                       "template_key_samples": list(template_keys)[:3],
                       "source_key_samples": sorted(source_keys)[:3]})
    if unmatched:
        warnings.append({"code": "UNMATCHED_TEMPLATE_KEY", "count": unmatched,
                         "samples": sorted(set(template_keys) - source_keys)[:5],
                         "rows": None})

    # ---- Gate 4/5: dry-run fill on the first sample SN, save + reopen ----
    sample_sn, sample_index = builds[0]
    merge_cache = {}
    wb_dry = load_workbook(template_path, data_only=False)
    for ws in wb_dry.worksheets:
        merge_cache[ws.title] = merged_lookup(ws)
    stats = fill_workbook(wb_dry, plan, sample_index["index"], merge_cache)
    allowed = set()
    for ws in wb_dry.worksheets:
        for mapping in mappings:
            for row, _ in plan_rows(ws, key_column):
                allowed.add(f"{mapping['target_column']}{row}")
    wb_before = load_workbook(template_path, data_only=False)
    before = snapshot_workbook(wb_before, skip_cells=sorted(allowed))
    wb_before.close()
    if stats["formula_conflicts"]:
        gates["write_safe"] = "fail"
        errors.append({"code": "FORMULA_OVERWRITE", "count": len(stats["formula_conflicts"]),
                       "cells": stats["formula_conflicts"][:5]})
    if stats["merged_conflicts"]:
        gates["write_safe"] = "fail"
        errors.append({"code": "MERGED_CELL_CONFLICT", "count": len(stats["merged_conflicts"]),
                       "cells": stats["merged_conflicts"][:5]})
    if stats["type_conversion_errors"]:
        warnings.append({"code": "TYPE_CONVERSION_ERROR", "count": stats["type_conversion_errors"],
                         "policy": "write_raw_string"})
    if stats["missing_values"]:
        warnings.append({"code": "MISSING_VALUE_IN_SOURCE", "count": stats["missing_values"],
                         "policy": plan.get("missing_value_policy", "leave_blank_and_report")})
    for warning in warnings:
        if warning["code"] == "UNMATCHED_TEMPLATE_KEY":
            warning["rows"] = stats["unmatched_keys"][:5]

    validation["formula_overwrite_count"] = len(stats["formula_conflicts"])
    validation["merged_cell_conflict_count"] = len(stats["merged_conflicts"])
    validation["type_conversion_error_count"] = stats["type_conversion_errors"]
    validation["missing_value_count"] = stats["missing_values"]
    validation["cells_written_in_sample"] = stats["cells_written"]
    validation["dry_run_sn"] = sample_sn

    os.makedirs(work_dir, exist_ok=True)
    dry_path = os.path.join(work_dir, "dry_run_sample.xlsx")
    try:
        wb_dry.save(dry_path)
        validation["save_success"] = True
    except Exception as exc:  # noqa: BLE001
        validation["save_success"] = False
        gates["output_integrity_valid"] = "fail"
        errors.append({"code": "OUTPUT_SAVE_FAILED", "message": str(exc)})
        return rejected(validation, gates, errors, warnings)

    try:
        reopened = load_workbook(dry_path, data_only=False)
        validation["reopen_success"] = True
    except Exception as exc:  # noqa: BLE001
        validation["reopen_success"] = False
        gates["output_integrity_valid"] = "fail"
        errors.append({"code": "OUTPUT_REOPEN_FAILED", "message": str(exc)})
        return rejected(validation, gates, errors, warnings)

    after = snapshot_workbook(reopened, skip_cells=sorted(allowed))
    differences = diff_snapshot(before, after, allowed)
    if differences:
        gates["output_integrity_valid"] = "fail"
        errors.append({"code": "NON_TARGET_REGION_CHANGED", "count": len(differences),
                       "samples": differences[:5]})

    readback_errors = []
    for ws in reopened.worksheets:
        if ws.title not in [s.title for s in sheets]:
            continue
        for row, _ in plan_rows(ws, key_column):
            key = normalize(ws[f"{key_column}{row}"].value, plan)
            record = sample_index["index"].get(key)
            if record is None:
                continue
            for mapping in mappings:
                expected = record.get(mapping["source_field"])
                if expected in (None, ""):
                    continue
                actual = ws[f"{mapping['target_column']}{row}"].value
                if not values_equal(actual, expected):
                    readback_errors.append({"sheet": ws.title, "row": row,
                                            "cell": f"{mapping['target_column']}{row}",
                                            "expected": str(expected), "actual": str(actual)})
    validation["write_readback_mismatch_count"] = len(readback_errors)
    if readback_errors:
        gates["output_integrity_valid"] = "fail"
        errors.append({"code": "WRITE_READBACK_MISMATCH", "count": len(readback_errors),
                       "samples": readback_errors[:5]})

    validation["sample_sn_count"] = len(picked)
    validation["sheets"] = [ws.title for ws in sheets]
    return finish(validation, gates, errors, warnings)


def finish(validation, gates, errors, warnings):
    if errors:
        return rejected(validation, gates, errors, warnings)
    status = "pass_with_warnings" if warnings else "pass"
    return {
        "plan_version": 2,
        "validation": validation,
        "gates": gates,
        "warnings": warnings,
        "errors": [],
        "status": status,
        "execution_allowed": True,
        "generated_at": now_iso(),
        "tool": "validate_report_plan",
        "tool_version": TOOL_VERSION,
    }


def rejected(validation, gates, errors, warnings):
    for gate, value in list(gates.items()):
        if value == "fail":
            continue
        gates[gate] = "not_executed"
    return {
        "plan_version": 2,
        "validation": validation,
        "gates": gates,
        "warnings": warnings,
        "errors": errors,
        "status": "rejected",
        "execution_allowed": False,
        "generated_at": now_iso(),
        "tool": "validate_report_plan",
        "tool_version": TOOL_VERSION,
    }


# --------------------------------------------------------------------------- #
# execute-plan（确定性批量回填，一 SN 一文件）
# --------------------------------------------------------------------------- #

def execute_one_sn(job):
    """处理单个 SN：读源 → Join → 复制模板写单元格 → 保存 → 重开回读校验。

    必须是纯函数（参数全部可 pickle）：批量执行会把它分发到多个进程，
    每个进程独立加载模板、独立写自己的输出文件，互不共享状态。
    """
    (sn_dir, plan, template_path, out_dir, pattern, filename_pattern,
     mappings, key_column, limit_readback) = job
    sn = os.path.basename(sn_dir)
    entry = {"sn": sn, "status": "ok", "warnings": [], "errors": []}
    source, matches, note = select_report_file(sn_dir, pattern)
    if not source:
        entry["status"] = "failed"
        entry["errors"].append({"code": "FILE_NOT_FOUND", "pattern": pattern})
        return entry
    if note:
        entry["warnings"].append({"code": note, "matches": [os.path.basename(m) for m in matches]})
    entry["source_file"] = os.path.basename(source)
    entry["source_file_sha256"] = sha256_file(source)
    try:
        built = build_case_index(source, plan)
    except ET.ParseError as exc:
        entry["status"] = "failed"
        entry["errors"].append({"code": "XML_PARSE_ERROR", "message": str(exc)})
        return entry
    if built["duplicates"]:
        duplicate_entry = {"code": "DUPLICATE_SOURCE_KEY", "count": len(built["duplicates"]),
                           "samples": built["duplicates"][:3]}
        if plan.get("duplicate_source_key_policy", "block") == "block":
            entry["status"] = "failed"
            entry["errors"].append(duplicate_entry)
            return entry
        # 与 Dry-Run 同一口径：非阻断策略下也必须留痕。否则"重复键被静默按第一条处理"，
        # 用户拿到的文件里少了数据却看不到任何提示——这正是上万行数据里最容易出事的地方。
        duplicate_entry["resolution"] = "kept_first_occurrence"
        entry["warnings"].append(duplicate_entry)
    wb = load_workbook(template_path, data_only=False)
    merge_cache = {ws.title: merged_lookup(ws) for ws in wb.worksheets}
    stats = fill_workbook(wb, plan, built["index"], merge_cache)
    if stats["formula_conflicts"] or stats["merged_conflicts"]:
        entry["status"] = "failed"
        entry["errors"].append({"code": "WRITE_SAFETY_CONFLICT",
                                "formula_conflicts": stats["formula_conflicts"][:5],
                                "merged_conflicts": stats["merged_conflicts"][:5]})
        return entry
    out_name = filename_pattern.replace("{sn}", sn)
    out_path = os.path.join(out_dir, out_name)
    try:
        wb.save(out_path)
    except Exception as exc:  # noqa: BLE001
        entry["status"] = "failed"
        entry["errors"].append({"code": "OUTPUT_SAVE_FAILED", "message": str(exc)})
        return entry
    finally:
        wb.close()
    try:
        reopened = load_workbook(out_path, data_only=False)
    except Exception as exc:  # noqa: BLE001
        entry["status"] = "failed"
        entry["errors"].append({"code": "OUTPUT_REOPEN_FAILED", "message": str(exc)})
        return entry
    try:
        mismatch = 0
        checked = 0
        for ws in reopened.worksheets:
            if key_column is None or ws.max_row is None:
                continue
            for row, _ in plan_rows(ws, key_column):
                key = normalize(ws[f"{key_column}{row}"].value, plan)
                record = built["index"].get(key)
                if record is None:
                    continue
                for mapping in mappings:
                    expected = record.get(mapping["source_field"])
                    if expected in (None, ""):
                        continue
                    if not values_equal(ws[f"{mapping['target_column']}{row}"].value, expected):
                        mismatch += 1
                    checked += 1
                    if limit_readback and checked >= limit_readback:
                        break
                if limit_readback and checked >= limit_readback:
                    break
            if limit_readback and checked >= limit_readback:
                break
    finally:
        reopened.close()
    if mismatch:
        entry["status"] = "failed"
        entry["errors"].append({"code": "WRITE_READBACK_MISMATCH", "count": mismatch})
        return entry
    entry["stats"] = {
        "matched_case_count": stats["rows_matched"],
        "unmatched_case_count": stats["rows_unmatched"],
        "missing_value_count": stats["missing_values"],
        "cells_written": stats["cells_written"],
        "unmatched_case_samples": stats["unmatched_keys"][:5],
    }
    if stats["rows_unmatched"] or stats["missing_values"] or entry["warnings"]:
        entry["status"] = "ok_with_warnings"
    entry["output_file"] = out_name
    entry["output_sha256"] = sha256_file(out_path)
    entry["output_size"] = os.path.getsize(out_path)
    return entry


def default_workers(count):
    """每 SN 一个进程：模板加载与写单元格都是 CPU 密集的纯 Python，线程拿不到 GIL 之外的好处。

    保留 1 个核给调用方（Agent / 控制面）是有意的，避免一台机器上并发跑多个任务时互相拖死。
    """
    env = os.environ.get("REPORT_EXECUTE_WORKERS")
    if env:
        try:
            return max(1, int(env))
        except ValueError:
            pass
    cpu = os.cpu_count() or 1
    return max(1, min(cpu - 1, count, 8))


def _tally(entry, totals):
    status = entry.get("status")
    if status == "failed":
        totals["sn_failed"] += 1
        return
    if status == "ok_with_warnings":
        totals["sn_completed_with_warnings"] += 1
    else:
        totals["sn_completed"] += 1
    stats = entry.get("stats") or {}
    totals["cells_written"] += stats.get("cells_written", 0)
    totals["unmatched_case_total"] += stats.get("unmatched_case_count", 0)
    totals["missing_value_total"] += stats.get("missing_value_count", 0)


def load_progress(journal_path):
    """读取断点续跑日志：SN → 已完成的条目。日志可能因进程被杀而截断，坏行直接跳过。"""
    done = {}
    if not os.path.exists(journal_path):
        return done
    with open(journal_path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if record.get("sn"):
                done[record["sn"]] = record
    return done


def resume_usable(record, out_dir):
    """已完成条目能不能直接复用：输出了、没失败、文件还在、hash 没变。"""
    if record.get("status") == "failed":
        return False
    out_name = record.get("output_file")
    if not out_name:
        return False
    path = os.path.join(out_dir, out_name)
    if not os.path.exists(path):
        return False
    if record.get("output_sha256") and sha256_file(path) != record["output_sha256"]:
        return False
    return True


def execute_plan(plan, dataset, template_path, out_dir, limit=None, workers=None, resume=False,
                 progress=None, readback_limit=None):
    validation_path = os.path.join(out_dir, "validation_report.json")
    journal_path = os.path.join(out_dir, "_progress.jsonl")
    if os.path.exists(validation_path) and not resume:
        die("OUTPUT_DIR_NOT_EMPTY", "output directory already holds a validation_report.json", out=out_dir)
    if resume and not os.path.exists(journal_path):
        die("NOTHING_TO_RESUME", "no progress journal to resume from", out=out_dir)
    unsupported = plan_supported(plan)
    if unsupported:
        die("PLAN_UNSUPPORTED", "plan uses unsupported features", problems=unsupported)
    os.makedirs(out_dir, exist_ok=True)
    pattern = (plan["source_file"] or {}).get("pattern") or "*_test_report*.xml"
    filename_pattern = plan["output"].get("filename_pattern") or "{sn}.xlsx"
    mappings = plan["template"].get("mappings") or []
    key_column = (plan["template"].get("join") or {}).get("template_key_column")
    sn_dirs = enumerate_sn_dirs(dataset, limit)

    totals = {"sn_total": len(sn_dirs), "sn_completed": 0, "sn_completed_with_warnings": 0,
              "sn_failed": 0, "sn_resumed": 0, "cells_written": 0, "unmatched_case_total": 0,
              "missing_value_total": 0}
    template_sha = sha256_file(template_path)

    journal_done = load_progress(journal_path) if resume else {}
    results = [None] * len(sn_dirs)
    pending = []
    for position, sn_dir in enumerate(sn_dirs):
        sn = os.path.basename(sn_dir)
        record = journal_done.get(sn)
        if record is not None and resume_usable(record, out_dir):
            entry = dict(record)
            entry.setdefault("warnings", [])
            entry.setdefault("errors", [])
            results[position] = entry
            totals["sn_resumed"] += 1
            _tally(entry, totals)
            continue
        pending.append((position, sn_dir))

    started_at = now_iso()
    journal = open(journal_path, "a", encoding="utf-8")
    try:
        done_count = len(sn_dirs) - len(pending)
        if pending:
            jobs = [(sn_dir, plan, template_path, out_dir, pattern, filename_pattern,
                     mappings, key_column, readback_limit) for _, sn_dir in pending]
            worker_count = workers if workers is not None else default_workers(len(jobs))
            worker_count = max(1, min(worker_count, len(jobs)))
            if progress:
                progress(f"executing {len(jobs)} SN with {worker_count} worker(s) "
                         f"({done_count} resumed)")
            if worker_count == 1:
                iterator = (execute_one_sn(job) for job in jobs)
            else:
                executor = concurrent.futures.ProcessPoolExecutor(max_workers=worker_count)
                iterator = executor.map(execute_one_sn, jobs, chunksize=1)
            try:
                for (position, _), entry in zip(pending, iterator):
                    results[position] = entry
                    journal.write(json.dumps(entry, ensure_ascii=False) + "\n")
                    journal.flush()
                    _tally(entry, totals)
                    done_count += 1
                    if progress:
                        progress(f"[{done_count}/{len(sn_dirs)}] {entry['sn']} {entry['status']}")
            finally:
                if worker_count > 1:
                    executor.shutdown(wait=True)
    finally:
        journal.close()

    results = [entry for entry in results if entry is not None]
    report = {
        "task_id": plan.get("task_id"),
        "dataset": os.path.abspath(dataset),
        "template_sha256": template_sha,
        "plan_sha256": hashlib.sha256(json.dumps(plan, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest(),
        "started_at": started_at,
        "completed_at": now_iso(),
        "workers": workers if workers is not None else default_workers(max(1, len(pending))),
        "resumed": bool(resume),
        "tool": "execute_validated_plan",
        "tool_version": TOOL_VERSION,
        "totals": totals,
        "results": results,
    }
    with open(validation_path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    return report


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def main(argv=None):
    parser = argparse.ArgumentParser(description="Report Self-Assistant deterministic tools")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("check-dataset", help="校验挂载与只读性（任务前必跑）")
    p.add_argument("--mount-root", required=True)
    p.add_argument("--relative", default="")
    p.add_argument("--dataset-id")
    p.add_argument("--pattern", default="*_test_report*.xml")
    p.add_argument("--out")

    p = sub.add_parser("inspect-template", help="分析 Excel 模板结构")
    p.add_argument("--template", required=True)
    p.add_argument("--max-samples", type=int, default=3)
    p.add_argument("--out")

    p = sub.add_parser("inspect-xml", help="分析代表性 XML 结构")
    p.add_argument("--dataset", required=True)
    p.add_argument("--pattern", default="*_test_report*.xml")
    p.add_argument("--sample-count", type=int, default=4)
    p.add_argument("--out")

    p = sub.add_parser("validate-plan", help="Dry-Run 计划并生成验证证据")
    p.add_argument("--plan", required=True)
    p.add_argument("--dataset", required=True)
    p.add_argument("--template", required=True)
    p.add_argument("--sample-sns", type=int, default=3)
    p.add_argument("--dry-run-dir")
    p.add_argument("--out")

    p = sub.add_parser("execute-plan", help="执行已验证计划（一 SN 一文件）")
    p.add_argument("--plan", required=True)
    p.add_argument("--dataset", required=True)
    p.add_argument("--template", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--limit", type=int)
    p.add_argument("--workers", type=int, help="并行进程数，默认 min(CPU-1, 8)，1 表示串行")
    p.add_argument("--resume", action="store_true",
                   help="从 _progress.jsonl 断点续跑：已完成且产物 hash 未变的 SN 直接跳过")
    p.add_argument("--progress", action="store_true", help="把每个 SN 的进度打到 stderr")
    p.add_argument("--readback-limit", type=int,
                   help="回读校验最多核对多少个单元格（默认全量；用于超大表加速）")

    args = parser.parse_args(argv)

    if args.command == "check-dataset":
        result = check_dataset(args.mount_root, args.relative, args.dataset_id, args.pattern)
        emit(result, args.out)
        sys.exit(0 if result["ok"] else 1)
    elif args.command == "inspect-template":
        emit(inspect_template(args.template, args.max_samples), args.out)
    elif args.command == "inspect-xml":
        emit(inspect_xml(args.dataset, args.pattern, args.sample_count), args.out)
    elif args.command == "validate-plan":
        plan = load_plan(args.plan)
        work_dir = args.dry_run_dir or tempfile.mkdtemp(prefix="report-dryrun-")
        result = validate_plan(plan, args.dataset, args.template, args.sample_sns, work_dir)
        emit(result, args.out)
        sys.exit(0 if result["execution_allowed"] else 1)
    elif args.command == "execute-plan":
        plan = load_plan(args.plan)

        def progress(message):
            print(f"[execute] {message}", file=sys.stderr, flush=True)

        report = execute_plan(plan, args.dataset, args.template, args.out_dir, args.limit,
                              workers=args.workers, resume=args.resume,
                              progress=progress if args.progress else None,
                              readback_limit=args.readback_limit)
        emit(report)


if __name__ == "__main__":
    main()
