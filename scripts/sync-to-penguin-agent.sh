#!/usr/bin/env bash
# 把本项目的"语义真源"同步到 PenguinHarness 里的 report_assistant Agent State。
#
#   scripts/sync-to-penguin-agent.sh            # 默认 --check：只报告漂移，不写任何文件
#   scripts/sync-to-penguin-agent.sh --write    # 应用同步（先备份被覆盖的文件）
#
# 同步什么、为什么：
#   persona.md  → AGENTS.md                 角色 / 决策规则 / 硬约束只有一份，避免两轨说法不一致
#   .agents/skills/<n>/SKILL.md → skills/<n>/SKILL.md   同上（附加该形态的 CLI 调用说明）
#   tools/report_tools.py → tools/report_tools.py       确定性核必须逐字节相同
#   config/datasets.json  → reference/datasets.json     数据集注册表口径一致
#
# 生成内容是确定性的：同样的输入跑两次结果相同，且不会改变 AGENTS.md 里由人维护的其它文件。
set -euo pipefail

MODE=check
for arg in "$@"; do
  case "$arg" in
    --write) MODE=write ;;
    --check) MODE=check ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 注意：不要用 PENGUIN_AGENT_ID —— PenguinHarness 会把它注入成"当前 Agent"，会指错目标。
PENGUIN_DATA_DIR="${PENGUIN_DATA_DIR:-$HOME/.penguin/data/default_project}"
AGENT_ID="${REPORT_SYNC_AGENT_ID:-report_assistant}"
AGENT_STATE="${REPORT_SYNC_AGENT_STATE:-$PENGUIN_DATA_DIR/agents/$AGENT_ID/agent_state}"

[[ -d "$AGENT_STATE" ]] || { echo "Agent State 不存在：$AGENT_STATE（先创建该 Agent，或用 REPORT_SYNC_AGENT_STATE 指定）" >&2; exit 2; }

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

python3 - "$PROJECT_ROOT" "$STAGING" <<'PY'
import json, os, pathlib, shutil, sys

project, staging = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])

CLI_NOTE = """

---

> 本节由 `scripts/sync-to-penguin-agent.sh` 生成。上面的规则来自项目里的 `persona.md` / `.agents/skills/`，
> 请勿在本文件里手改：改项目、再同步。

# 本 Agent 形态下怎么调用确定性工具

生产运行时把确定性层注册成 6 个结构化工具；在 PenguinHarness 这个形态里，你通过 shell 调用**同一个 CLI**
（`<agent_state>/tools/report_tools.py`），语义完全一致：

```bash
TOOLS="<agent_state>/tools/report_tools.py"

python3 "$TOOLS" check-dataset  --mount-root <挂载根> --relative <数据集相对路径> [--dataset-id <id>] [--out <json>]
python3 "$TOOLS" inspect-template --template <template.xlsx> --out <template-inspection.json> [--max-samples 3]
python3 "$TOOLS" inspect-xml    --dataset <只读数据集路径> --out <xml-inspection.json> [--pattern '<glob>'] [--sample-count 4]
python3 "$TOOLS" validate-plan  --plan <plan.json> --dataset <只读数据集路径> --template <template.xlsx> \\
                                --dry-run-dir <任务目录>/dryrun --out <validation.json>
python3 "$TOOLS" execute-plan   --plan <plan.json> --dataset <只读数据集路径> --template <template.xlsx> \\
                                --out-dir <任务目录>/outputs
```

对应关系：

| 生产运行时的工具 | 本形态下的做法 |
|---|---|
| `inspect_template()` | `inspect-template --out …` |
| `inspect_xml_schema()` | 先 `check-dataset`，再 `inspect-xml --out …` |
| `submit_resolved_plan({plan})` | 你自己把 ResolvedPlan 写成 `plan.json`（形状错误会在 `validate-plan` 里被明确指出） |
| `validate_report_plan()` | `validate-plan …`，读 `validation.json` 的 `gates` / `execution_allowed` |
| `execute_validated_plan({plan_sha256})` | `validate-plan` 输出 `execution_allowed: true` 后跑 `execute-plan …` |
| `get_task_status()` | 读 `validation.json` 与 `outputs/validation_report.json` |

数据集与挂载根以项目根目录 `config/datasets.json` 为准（同步副本见 `agent_state/reference/datasets.json`）；
挂载缺失、不可读或越界（`MOUNT_NOT_FOUND` / `DATASET_NOT_FOUND` / `DATASET_OUTSIDE_MOUNT_ROOT`）一律停下并告知用户。
"""

AGENTS_NOTE = CLI_NOTE


def strip_frontmatter(text: str) -> str:
    if not text.startswith("---"):
        return text
    end = text.index("\n---", 3)
    return text[end + 4:].lstrip("\n")


persona = (project / "persona.md").read_text(encoding="utf-8").rstrip() + "\n"
(staging / "AGENTS.md").write_text(persona + AGENTS_NOTE.lstrip("\n"), encoding="utf-8")

for skill_dir in sorted((project / ".agents" / "skills").iterdir()):
    skill_file = skill_dir / "SKILL.md"
    if not skill_file.is_file():
        continue
    body = (skill_dir / "SKILL.md").read_text(encoding="utf-8").rstrip()
    target = staging / "skills" / skill_dir.name
    target.mkdir(parents=True, exist_ok=True)
    (target / "SKILL.md").write_text(body + CLI_NOTE, encoding="utf-8")

(staging / "tools").mkdir(parents=True, exist_ok=True)
shutil.copy2(project / "tools" / "report_tools.py", staging / "tools" / "report_tools.py")

(staging / "reference").mkdir(parents=True, exist_ok=True)
raw = json.loads((project / "config" / "datasets.json").read_text(encoding="utf-8"))
(staging / "reference" / "datasets.json").write_text(
    json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
)

print(f"staged: AGENTS.md + {len(list((staging / 'skills').glob('*/SKILL.md')))} skills + report_tools.py + datasets.json")
PY

drift=0
report=""
while IFS= read -r rel; do
  src="$STAGING/$rel"
  dst="$AGENT_STATE/$rel"
  if [[ ! -f "$dst" ]]; then
    report+="  缺失  $rel"$'\n'; drift=1
  elif ! cmp -s "$src" "$dst"; then
    report+="  有差异 $rel"$'\n'; drift=1
  fi
done < <(cd "$STAGING" && find . -type f | sed 's|^\./||' | sort)

echo "项目：$PROJECT_ROOT"
echo "Agent State：$AGENT_STATE"
if [[ $drift -eq 0 ]]; then
  echo "结果：已一致（无需同步）"
  exit 0
fi

echo "结果：检测到漂移"
printf '%s' "$report"

if [[ "$MODE" != "write" ]]; then
  echo ""
  echo "只是检查，未改动任何文件。要应用：scripts/sync-to-penguin-agent.sh --write"
  exit 1
fi

backup="$AGENT_STATE/.sync-backup/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup"
while IFS= read -r rel; do
  dst="$AGENT_STATE/$rel"
  if [[ -f "$dst" ]]; then
    mkdir -p "$backup/$(dirname "$rel")"
    cp -p "$dst" "$backup/$rel"
  fi
  mkdir -p "$AGENT_STATE/$(dirname "$rel")"
  cp "$STAGING/$rel" "$dst"
  echo "  已写入 $rel"
done < <(cd "$STAGING" && find . -type f | sed 's|^\./||' | sort)

echo ""
echo "同步完成。被覆盖的原文件备份在：$backup"
