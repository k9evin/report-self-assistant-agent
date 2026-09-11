# 部署：只读数据源 + 执行容器

## 1. 挂数据源（宿主机，一次性）

```bash
sudo install -d -m 700 /etc/report-agent
sudo tee /etc/report-agent/smb.credentials >/dev/null <<'CRED'
username=<域账号>
password=<密码>
CRED
sudo chmod 600 /etc/report-agent/smb.credentials

sudo ./mount-mfs-readonly.sh          # 只读挂载 + 只读自检
mount | grep mfs                      # 期望看到 ro,...
```

脚本是幂等的，并且会**拒绝**在可写状态下继续：`mount -t cifs -o ro,...` 让它在内核层只读，随后的写入探测失败才认定成功。
生产建议把它放进 systemd 或 `/etc/fstab`（`ro,credentials=...,_netdev`），开机自动挂。

macOS 开发机：在 Finder「连接服务器」里挂载后取消可写，或用环境变量把挂载根指过去：

```bash
REPORT_MOUNT_ROOT_MFS=/Volumes/mfs/mfs-srv.example.com/Data npm run plan -- ...
```

## 2. 起执行容器

```bash
cd deploy && docker compose up -d --build
docker compose exec app ./node_modules/.bin/tsx src/cli.ts datasets
```

`docker-compose.yml` 里有两层只读保证：宿主机的只读 CIFS + 容器的 `:ro` 绑定；容器自身的根文件系统也是 `read_only: true`，只有 `/data/work`、`/data/templates` 与 `tmpfs:/tmp` 可写。

## 3. 业务平台怎么接

FastAPI 控制面按 `src/planner.ts` 的 `PlannerService` 契约调用（`createTask` → `runTask` → 可选 `ask`），
不需要走 CLI。容器以 `--profile api` 跑一个常驻进程即可；产物目录 `/data/work/<task_id>/` 直接给前端做下载源。

不要把模型 key 与 SMB 凭据写进镜像或 compose 文件；用 `env_file` / Docker secret / 宿主机的 `chmod 600` 文件。
