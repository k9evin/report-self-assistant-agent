#!/usr/bin/env python3
"""生成"真实规模"的夹具：上万行 Case 的模板 + 每个 SN 一份同样量级的 XML 测试报告。

    python3 tests/make_big_fixture.py --out /tmp/report-big --sns 12 --rows 10000
    python3 tests/make_big_fixture.py --out /tmp/report-big-messy --sns 8 --rows 10000 --messy
    python3 tests/make_big_fixture.py --out /tmp/report-big-multifile --sns 6 --rows 10000 --stale-xml

与 tests/make_fixture.py（3 个 SN 的小夹具）的区别：小夹具验的是"链路对不对"，
这份验的是"上万行时还对不对、快不快、内存撑不撑得住"。

真实数据的复杂度体现在：
  · 模板上万行、多个 Sheet、表头合并、目标列附近有公式与非目标内容；
  · 每个 SN 一份 XML，task 数与模板行数同一量级；
  · --messy 再加：单个 SN 缺失的 task、XML 里多出来的 task、带前后空格的 Case 名、
    同一 task 重复出现、个别 task 缺 item —— 这些才是实际数据里真正会咬人的东西；
  · --stale-xml 再加：每个 SN 目录多一份更旧更小的历史报告，用来验 latest_mtime 真的取了最新。
"""
import argparse
import os
import random
import sys
import time

from openpyxl import Workbook

FIELDS = ("ge", "gr", "te", "nf")
TARGET = {"ge": "F", "gr": "H", "te": "J", "nf": "L"}


def case_name(index: int) -> str:
    """形状贴近真实：rt@ver_gain-e1lg_g5_inp<N>_sgt0_mc"""
    return f"rt@ver_gain-e1lg_g5_inp{index:05d}_sgt0_mc"


def build_template(path: str, rows: int) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "E1&2"
    ws.merge_cells("A1:P1")
    ws["A1"] = "FIR Report"
    ws["A3"], ws["B3"] = "No", "Test Item"
    for field, column in TARGET.items():
        ws[f"{column}3"] = field.upper()
    ws["P3"] = "Case"

    for index in range(rows):
        row = 5 + index
        ws[f"A{row}"] = index + 1
        ws[f"P{row}"] = case_name(index)
        # 非目标列上散落公式与固定文本：既制造真实体量，也验证它们不会被碰
        if index % 500 == 0:
            ws[f"G{row}"] = f"=F{row}*2"
        if index % 250 == 0:
            ws[f"M{row}"] = f"note-{index}"
        if index % 97 == 0:
            ws[f"B{row}"] = f"item-{index % 37}"

    # 第二个 Sheet：不该被回填的干扰项
    ws2 = wb.create_sheet("Summary")
    ws2["A1"] = "summary sheet"
    for index in range(50):
        ws2[f"P{2 + index}"] = f"summary-row-{index}"
    wb.save(path)


def build_xml(path: str, sn: str, rows: int, rng: random.Random, messy: bool) -> int:
    """流式写 XML：上万 task 时一次性拼字符串内存会很难看。"""
    base = rng.random()
    tasks = []
    rows_written = 0
    for index in range(rows):
        name = case_name(index)
        if messy:
            roll = rng.random()
            if roll < 0.005:                     # 模板里有、这份 XML 里没有
                continue
            if roll < 0.010:                     # 多余 task
                name = f"{case_name(index)}_extra"
            elif roll < 0.015:                   # Case 名带前后空格
                name = f"  {name} "
            elif roll < 0.018:                   # 同一 task 重复
                pass
        items = []
        for offset, field in enumerate(FIELDS):
            if messy and rng.random() < 0.002:   # 缺个别字段
                continue
            value = base + index * 0.001 + offset
            items.append(f'    <item name="{field}" value="{value:.12f}"/>')
        tasks.append(f'  <task name="{name}">\n' + "\n".join(items) + "\n  </task>")
        rows_written += 1
        if messy and rng.random() < 0.003:       # 重复一遍
            tasks.append(tasks[-1])
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(f'<test_report sn="{sn}">\n')
        fh.write("\n".join(tasks))
        fh.write("\n</test_report>\n")
    return rows_written


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", default="/tmp/report-big")
    parser.add_argument("--sns", type=int, default=12, help="SN 目录数")
    parser.add_argument("--rows", type=int, default=10000, help="模板数据行数 = 每个 SN 的 task 数")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--messy", action="store_true", help="注入真实数据里的脏情况")
    parser.add_argument("--stale-xml", action="store_true",
                        help="每个 SN 目录再放一份更旧、更小的历史报告，验 multiple_match_policy=latest_mtime")
    parser.add_argument("--stale-rows", type=int, default=0, help="历史报告的 task 数（默认取 --rows 的一半）")
    args = parser.parse_args()

    rng = random.Random(args.seed)
    started = time.time()
    dataset = os.path.join(args.out, "TD28")
    os.makedirs(dataset, exist_ok=True)

    build_template(os.path.join(args.out, "template.xlsx"), args.rows)
    template_seconds = time.time() - started

    sns = [f"K{7893981 + index}" for index in range(args.sns)]
    stale_rows = args.stale_rows or max(1, args.rows // 2)
    now = time.time()
    xml_bytes = 0
    for sn in sns:
        sn_dir = os.path.join(dataset, sn)
        os.makedirs(sn_dir, exist_ok=True)
        # 单个 SN 目录里可以有多份报告文件：真实数据里同目录多份，必须按 mtime 取最新
        path = os.path.join(sn_dir, f"{sn}_test_report.xml")
        build_xml(path, sn, args.rows, rng, args.messy)
        os.utime(path, (now, now))
        xml_bytes += os.path.getsize(path)
        if args.stale_xml:
            stale = os.path.join(sn_dir, f"{sn}_test_report_20240101.xml")
            build_xml(stale, sn, stale_rows, random.Random(args.seed + 1), False)
            # 明确把 mtime 压旧一小时：不靠写盘顺序这种碰运气的东西
            os.utime(stale, (now - 3600, now - 3600))

    total = time.time() - started
    print(f"fixture ready: {args.out}")
    print(f"  模板：{args.rows} 行 × 2 Sheet（{template_seconds:.1f}s）")
    print(f"  数据：{len(sns)} 个 SN × ~{args.rows} task，XML 合计 {xml_bytes / 1024 / 1024:.1f} MB（{total:.1f}s）")
    if args.messy:
        print("  脏数据：缺失 / 多余 / 前后空格 / 重复 task / 缺字段 已注入")
    if args.stale_xml:
        print(f"  历史报告：每个 SN 额外一份 ~{stale_rows} task 的旧文件（mtime 早 1 小时）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
