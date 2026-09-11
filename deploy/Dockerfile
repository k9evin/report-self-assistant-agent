# 运行镜像：Node 22（pi 运行时）+ Python 3（确定性核）+ openpyxl。
FROM node:22-bookworm-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip python3-venv tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依赖先装，利用镜像层缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod=false

COPY tsconfig.json ./
COPY src ./src
COPY tools ./tools
COPY config ./config
COPY .pi ./.pi
COPY persona.md ./
COPY .agents ./.agents

# 确定性核的第三方依赖（openpyxl）固定装在系统 Python 里，与应用镜像同生命周期
RUN python3 -m pip install --no-cache-dir --break-system-packages openpyxl

# 容器内仍然只读挂载数据源：compose 里以 :ro 绑定
ENV REPORT_WORK_DIR=/data/work

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./node_modules/.bin/tsx", "src/cli.ts", "datasets"]
