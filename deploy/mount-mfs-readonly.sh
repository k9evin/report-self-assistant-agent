#!/usr/bin/env bash
# 把制造测试数据的 SMB 共享以【只读】方式挂到挂载根。
#
#   sudo deploy/mount-mfs-readonly.sh                 # 用默认值与 /etc/report-agent/smb.credentials
#   sudo SMB_SHARE=//host/Data MOUNT_POINT=/mnt/mfs/host/Data deploy/mount-mfs-readonly.sh
#   sudo deploy/mount-mfs-readonly.sh --unmount
#
# 幂等：已挂载则先校验是否只读，再决定卸载重挂或直接退出。
set -euo pipefail

SMB_SHARE="${SMB_SHARE:-//mfs-srv.example.com/Data}"
MOUNT_POINT="${MOUNT_POINT:-/mnt/mfs/mfs-srv.example.com/Data}"
CREDENTIALS="${SMB_CREDENTIALS:-/etc/report-agent/smb.credentials}"
MOUNT_UID="${MOUNT_UID:-$(id -u)}"
MOUNT_GID="${MOUNT_GID:-$(id -g)}"
SMB_VERS="${SMB_VERS:-3.0}"

log() { printf '[mount-mfs] %s\n' "$*"; }
die() { printf '[mount-mfs] 错误：%s\n' "$*" >&2; exit 1; }

mounted_here() { mount | grep -F " on ${MOUNT_POINT} " >/dev/null 2>&1; }

is_read_only() {
  # 只读挂载的内核语义：在挂载点创建文件必然失败（EROFS / EACCES），且 mount 输出带 ro。
  mount | grep -F " on ${MOUNT_POINT} " | grep -qE '(^|[(,])ro([,)]|$)'
}

if [[ "${1:-}" == "--unmount" ]]; then
  mounted_here || { log "未挂载，无需卸载"; exit 0; }
  umount "$MOUNT_POINT"
  log "已卸载 $MOUNT_POINT"
  exit 0
fi

[[ "$(uname -s)" == "Linux" ]] || die "本脚本只适用于 Linux（当前 $(uname -s)）；macOS 请在 Finder 里以只读方式连接，或用 REPORT_MOUNT_ROOT_* 指向已有路径。"
[[ $EUID -eq 0 ]] || die "需要 root：请用 sudo 运行。"
[[ -f "$CREDENTIALS" ]] || die "凭据文件不存在：$CREDENTIALS（内容两行：username=... / password=...，权限 chmod 600）"
command -v mount.cifs >/dev/null || die "缺少 mount.cifs：apt-get install -y cifs-utils"

if mounted_here; then
  if is_read_only; then
    log "$MOUNT_POINT 已是只读挂载，跳过"
    exit 0
  fi
  log "$MOUNT_POINT 已挂载但不是只读，重新挂载"
  umount "$MOUNT_POINT"
fi

mkdir -p "$MOUNT_POINT"

# ro              : 内核层面拒绝一切写入，这是"绝不改源数据"的硬保证，不依赖应用自觉
# nobrl           : 不做 byte-range lock，避免部分 NAS 上的 IO 卡死
# noperm          : 权限位由服务端裁决（只读场景下避免本地 uid 映射噪音）
# actimeo=60      : 属性缓存，减少大量小文件上的往返
mount -t cifs "$SMB_SHARE" "$MOUNT_POINT" \
  -o "ro,credentials=${CREDENTIALS},uid=${MOUNT_UID},gid=${MOUNT_GID},iocharset=utf8,vers=${SMB_VERS},nobrl,actimeo=60,noserverino"

is_read_only || { umount "$MOUNT_POINT" || true; die "挂载结果不是只读，已卸载"; }

if touch "${MOUNT_POINT}/.report-agent-write-probe" 2>/dev/null; then
  rm -f "${MOUNT_POINT}/.report-agent-write-probe"
  die "写入探测竟然成功——拒绝以可写状态继续"
fi

log "已只读挂载 $SMB_SHARE → $MOUNT_POINT"
log "自检：$(python3 "$(dirname "$0")/../tools/report_tools.py" check-dataset --mount-root "$MOUNT_POINT" 2>&1 | tail -1 || echo '(跳过，report_tools.py 不可用)')"
