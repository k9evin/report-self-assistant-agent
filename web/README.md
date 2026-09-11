# web —— 自动化测试报告智能助理控制台

面向业务用户的前端：一个单页应用，两个页签（**运行任务** / **测试案例**）。
「运行任务」是对话式布局：输入固定在底部，过程与结果留在对话流里。
技术栈 Vite + React + TypeScript；样式是仓库内自带的 CSS + Tailwind v4，组件层用 shadcn/ui
（源码在 `src/components/ui/`，随仓库提交）。无 CDN、无字体、无分析脚本，页面不发起任何外部请求。

## 开发

```bash
cd web
npm install          # 用 npm，不要用 pnpm（本机 pnpm 会因构建脚本审批让 pnpm exec 退出 1）
npm run dev          # http://127.0.0.1:5173
```

开发服务器把 `/api` 代理到控制面 `http://127.0.0.1:8787`（见 `vite.config.ts` 的 `server.proxy`），
所以本地开发时先启动后端（仓库根目录 `npm run serve`），再开前端即可联调。

## 构建

```bash
cd web
npm run build        # tsc --noEmit 类型检查 + vite build → 产物在 web/dist
npm run typecheck    # 只做类型检查
npm run preview      # 本地预览构建产物（不带 /api 代理，仅看静态页面）
```

后端在同一个端口把 `web/dist` 当静态目录托管（`GET /`），所以：

- `base` 保持默认 `'/'`，资源用绝对路径引用；
- **不引入路由库**，两个页签用 `useState` 切换——服务端只对 `/` 做 SPA fallback，深链接会 404。

## 目录结构

```
web/
├── index.html                  # lang=zh-CN、viewport、标题，以及首屏前的主题脚本
├── vite.config.ts              # 端口 5173 + /api 代理到 127.0.0.1:8787
├── tsconfig.json               # 严格模式（strict + noUnusedLocals + noUncheckedIndexedAccess）
├── package.json                # 独立一份，npm 安装
└── src/
    ├── main.tsx                # 挂载入口
    ├── App.tsx                 # 外壳与页签切换
    ├── styles.css              # design tokens + Tailwind/shadcn 变量桥接 + 外壳（导航/骨架）样式
    ├── types.ts                # docs/api.md 的类型镜像
    ├── api.ts                  # fetch 封装、错误提取、SSE / 下载 URL 拼装
    ├── labels.ts               # 阶段 / 工具 / Gate 中文映射与 expect 摘要
    ├── useRunStream.ts         # 一次运行的实时状态（EventSource 增量累积）+ 按轮切分
    ├── theme.ts                # 深色模式读写（localStorage + prefers-color-scheme）
    └── components/
        ├── ui/                 # shadcn/ui 源码（button / card / badge / table / collapsible / select / …）
        ├── Nav.tsx             # 顶栏：品牌、页签、主题切换
        ├── RunTab.tsx          # 页签 1：对话流 + 底部输入区（composer）
        ├── Conversation.tsx    # 对话流：用户气泡 + 助理回合（执行过程 → 汇报）
        ├── Composer.tsx        # 底部输入区（IME 安全 Enter 发送）
        ├── CasesTab.tsx        # 页签 2：用例清单 + 逐行运行 + 行内结果
        ├── PhaseBar.tsx        # 阶段条（状态机 → 中文）
        ├── ToolTimeline.tsx    # 执行步骤时间线
        ├── ReportPanel.tsx     # 助理汇报：流式文本 + 少量行内标记排版
        ├── RunResult.tsx       # 五道 Gate、错误/警告、产物、计划/验证 JSON（对话框与用例行共用）
        ├── ResultBlock.tsx     # 结果区分节（分隔线 + 标题 + 可选右侧动作）
        ├── Checks.tsx          # 用例断言（✅ / ❌ + 总判定）
        ├── ToneBadge.tsx       # 状态药丸：StatusTone → Badge 配色（对话流与结果区共用一份映射）
        ├── States.tsx          # 加载 / 错误 / 空状态
        └── icons.tsx           # 内联 SVG 图标
```

## 交互与契约要点

- 所有请求都是 `/api/...` 相对路径：开发走代理，生产与后端同源。
- 主流程：`POST /api/runs`（或 `POST /api/runs/case`）拿到 `run_id` 后立刻 `EventSource` 订阅
  `GET /api/runs/:id/stream`，按 `status` / `tool_start` / `tool_end` / `text` / `check` /
  `snapshot` / `done` / `error` 增量渲染。命名事件与 data-only 两种写法都接。
- `snapshot` 与 `done` 的载荷既支持 `{ run: RunView }` 也支持内联 RunView。
- 追问：`POST /api/runs/:id/ask` 成功后重新订阅同一个流，文字与步骤继续追加。
  服务端在追问的回复前会插入 `\n\n---\n\n`，`useRunStream` 用每次追问开始时的
  `reply.length` / `tools.length` 当基线把累积流切成「一轮」，`turnViews(state)` 即对话流的数据源；
  所以追问在界面上是**新的一轮对话**，而不是同一段文字往后接。
- 错误一律显示后端给的 `{ error: { code, message } }` 里的 `message`（SSE 的 `error` 事件同理），
  网络不通时提示无法连接后端，不会白屏。
- 产物下载：`GET /api/runs/:id/outputs/<file>`，路径逐段编码。
- 任务运行中主按钮与输入框 disabled，避免重复提交。
- 阶段、六个工具名、五道 Gate 的中文映射集中在 `src/labels.ts`。

## 视觉

- **唯一真源是 `src/styles.css` 顶部的 design tokens**（遵循 skill `web-design`）：
  `--bg/--surface/--border/--fg/--fg-muted/--brand-600/--accent-bg/--radius-control/--radius-card/--ease` 等；
  1px 边框而非阴影，系统字体栈（含 PingFang SC），主按钮是近黑/白而不是蓝色填充，
  标题 `font-weight: 600; letter-spacing: -0.025em`。
- shadcn/ui 的 CSS 变量在同一文件里用 `@theme inline` 桥接到这套 tokens
  （`--color-primary → var(--accent-bg)`、`--color-border → var(--border)`、`--radius-xl → var(--radius-card)`…），
  所以 Tailwind 工具类与仓库自带的类名取到的是同一批颜色与圆角。深色下另有一组语义色
  （`--ui-secondary` / `--ui-subtle` / `--ui-hover` / `--ui-ring`），因为 `--gray-100` 这类灰阶不随主题变。
- 界面主体（对话流、结果区、用例清单）全部用 shadcn 组件 + Tailwind 工具类书写，
  `@layer components` 里只剩导航与页面骨架这类没有对应组件的规则（`.nav` / `.tab` / `.btn-secondary`…）；
  两者取到的是同一批 tokens，所以不存在「组件一套颜色、旧样式另一套颜色」。
  加组件用 `npx shadcn@latest add <name>`，不要手工加 `clsx` / `tailwind-merge` / 逐个 `@radix-ui/*`。
- 浅色 + 纯黑深色两套主题，`<html class="dark">` 切换；首次跟随 `prefers-color-scheme`，
  用户选择写入 `localStorage` 的 `report-agent-theme`，导航栏右侧按钮切换。
- 窄屏（< 640px）单列、无横向滚动；`prefers-reduced-motion` 下关闭全部动画。
- 图标全部是内联 SVG（`components/icons.tsx`），页面不发起任何一个外部请求。
- 再加 shadcn 组件：`cd web && npx shadcn@latest add <component>`（会写进 `src/components/ui/`，
  并按本仓库已定的约定从 `cn` 包引入 `cn()`、从 `radix-ui` 引入 primitive）。

## 已知边界

- 只做前端，不修改仓库其它文件；后端契约以 `docs/api.md` 为准。
- 空状态基于 `run.validation` / `run.outputs` 的可选字段：这些字段缺失时按「未执行 / 0」渲染，不报错。
