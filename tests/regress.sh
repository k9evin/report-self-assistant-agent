#!/usr/bin/env bash
# report_tools.py 回归测试：正常计划 / 错误 selector / 覆盖公式 / 不支持语法 / 批量执行 / 只读性
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
TPL_SHA_BEFORE="$(shasum -a 256 /dev/null | cut -d" " -f1)"
T="${HERE}/../tools/report_tools.py"
FIX=${1:-/tmp/report-fixture-regress}
rm -rf "$FIX" 2>/dev/null
python3 "$HERE/make_fixture.py" "$FIX" >/dev/null || exit 1
cd "$FIX" || exit 1

pass=0; fail=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "PASS  $1 => $3"; pass=$((pass+1));
  else echo "FAIL  $1 => got '$3' want '$2'"; fail=$((fail+1)); fi
}
jq_get() { python3 -c "import json,sys;d=json.load(open('$1'));v=eval('d'+sys.argv[1]);print(json.dumps(v) if isinstance(v,bool) else v)" "$2"; }

python3 "$T" inspect-template --template template.xlsx --out t.json || exit 1
check "inspect-template P 列语义" "case" \
  "$(python3 -c "import json;d=json.load(open('t.json'));print([c['semantic_hint'] for c in d['sheets'][0]['key_column_candidates'] if c['column']=='P'][0])")"
check "inspect-template 公式单元格" "G5,G8" \
  "$(python3 -c "import json;d=json.load(open('t.json'));print(','.join(d['sheets'][0]['formula_cells']))")"

python3 "$T" inspect-xml --dataset TD28 --out x.json || exit 1
check "inspect-xml 首选记录候选" ".//task" \
  "$(python3 -c "import json;d=json.load(open('x.json'));print(d['record_candidates'][0]['record_selector'])")"
check "inspect-xml 字段模型" "./item|@name|@value" \
  "$(python3 -c "import json;d=json.load(open('x.json'));f=d['record_candidates'][0]['field_models'][0];print('|'.join([f['item_selector'],f['field_name_selector'],f['field_value_selector']]))")"

python3 "$T" validate-plan --plan plan.json --dataset TD28 --template template.xlsx --dry-run-dir dry1 --out v-ok.json
check "正常计划 execution_allowed" "true" "$(jq_get v-ok.json "['execution_allowed']")"
check "正常计划状态" "pass_with_warnings" "$(jq_get v-ok.json "['status']")"
check "五道 Gate" "pass,pass,pass,pass,pass" \
  "$(python3 -c "import json;d=json.load(open('v-ok.json'));print(','.join(d['gates'][k] for k in ['source_schema_valid','template_structure_valid','join_valid','write_safe','output_integrity_valid']))")"

python3 "$T" validate-plan --plan plan-bad.json --dataset TD28 --template template.xlsx --dry-run-dir dry2 --out v-bad.json
check "错误 selector execution_allowed" "false" "$(jq_get v-bad.json "['execution_allowed']")"
check "错误 selector 返回候选" ".//task" \
  "$(python3 -c "import json;d=json.load(open('v-bad.json'));print(d['errors'][0]['record_candidates'][0]['selector'])")"
check "错误 selector 后置 Gate 未执行" "not_executed" "$(jq_get v-bad.json "['gates']['join_valid']")"

python3 "$T" validate-plan --plan plan-formula.json --dataset TD28 --template template.xlsx --dry-run-dir dry3 --out v-formula.json
check "覆盖公式被阻断" "FORMULA_OVERWRITE" \
  "$(python3 -c "import json;d=json.load(open('v-formula.json'));print(d['errors'][0]['code'])")"

python3 "$T" validate-plan --plan plan-predicate.json --dataset TD28 --template template.xlsx --dry-run-dir dry4 --out v-pred.json
check "不支持语法报 PLAN_SELECTOR_UNSUPPORTED" "PLAN_SELECTOR_UNSUPPORTED" \
  "$(python3 -c "import json;d=json.load(open('v-pred.json'));print(d['errors'][0]['code'])")"

python3 "$T" execute-plan --plan plan.json --dataset TD28 --template template.xlsx --out-dir out > exec.json || exit 1
check "批量执行 SN 数" "3" "$(jq_get exec.json "['totals']['sn_total']")"
check "批量执行失败数" "0" "$(jq_get exec.json "['totals']['sn_failed']")"
TPL_SHA="$(shasum -a 256 template.xlsx | cut -d' ' -f1)"
python3 - <<PY
TPL_SHA = "$TPL_SHA"
import hashlib, json, os
from openpyxl import load_workbook
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
out = sorted(f for f in os.listdir("out") if f.endswith(".xlsx"))
print("PASS  一 SN 一文件" if out == ["K7893981_FIR.xlsx", "K7893982_FIR.xlsx", "K7893983_FIR.xlsx"]
      else "FAIL  一 SN 一文件 => %s" % out)
wb = load_workbook("out/K7893981_FIR.xlsx")
ws = wb["E1&2"]
checks = [
    ("ge 回填 F5", ws["F5"].value, 0.0227052),
    ("nf 回填 L5", ws["L5"].value, 6.60765843),
    ("未匹配 Case 留空", ws["F8"].value, None),
    ("非目标公式保留", ws["G8"].value, "=F8*2"),
    ("非目标文本保留", ws["M9"].value, "keep-me"),
    ("Sheet 保留", wb.sheetnames, ["E1&2", "Summary"]),
    ("合并单元格保留", [str(r) for r in ws.merged_cells.ranges], ["A1:P1"]),
    ("模板未被改写", sha("template.xlsx"), TPL_SHA),
]
for name, got, want in checks:
    print(("PASS  " if got == want else "FAIL  ") + "%s => %r" % (name, got))
print("PASS  validation_report.json 存在" if os.path.exists("out/validation_report.json")
      else "FAIL  validation_report.json 缺失")
PY
echo; echo "shell checks: pass=$pass fail=$fail"
