/** 顶部导航：无混淆 Logo、侧栏开关精准置左对齐、模式切换、主题与退出。 */
import { cn } from "cn";

import type { AppMode } from "../mode";
import type { Theme } from "../theme";
import {
  IconMoon,
  IconShieldCheck,
  IconSidebar,
  IconSun,
  IconTerminal,
} from "./icons";

export type TabKey = "run" | "cases";

export function Nav({
  tab,
  onChangeTab,
  theme,
  onToggleTheme,
  sidebarCollapsed,
  onToggleSidebar,
  mode,
  onModeChange,
  devModeAllowed = true,
  authRequired = false,
  onLogout,
}: {
  tab: TabKey;
  onChangeTab: (tab: TabKey) => void;
  theme: Theme;
  onToggleTheme: () => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  mode: AppMode;
  onModeChange: (mode: AppMode) => void;
  devModeAllowed?: boolean;
  authRequired?: boolean;
  onLogout?: () => void;
}) {
  const isDev = devModeAllowed && mode === "dev";

  // 生产/上线模式仅展示「运行任务」；开发模式才出现「测试案例」。
  const tabs: { key: TabKey; label: string }[] = isDev
    ? [
        { key: "run", label: "运行任务" },
        { key: "cases", label: "测试案例" },
      ]
    : [{ key: "run", label: "运行任务" }];

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border/40 bg-background/80 backdrop-blur-xl">
      {/* 全宽容器：侧栏开关对齐左侧边栏顶端，移除 max-w-7xl 居中造成的错位 */}
      <div className="flex h-14 w-full items-center justify-between px-4 sm:px-6">
        {/* 左侧区域：侧栏开关 + 系统名称 + 模式页签 */}
        <div className="flex items-center gap-3 min-w-0">
          {onToggleSidebar ? (
            <button
              type="button"
              className={cn(
                "group relative flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-card/80 text-muted-foreground transition-all duration-200 hover:border-brand/40 hover:bg-muted hover:text-foreground active:scale-95 cursor-pointer",
                !sidebarCollapsed && "bg-brand/10 text-brand border-brand/30",
              )}
              onClick={onToggleSidebar}
              aria-label={sidebarCollapsed ? "展开历史侧栏" : "收起历史侧栏"}
              title={sidebarCollapsed ? "展开历史侧栏" : "收起历史侧栏"}
            >
              <IconSidebar width={16} height={16} />
            </button>
          ) : null}

          {/* 纯净品牌标题（已移除与折叠侧栏图标相似的产品 Logo） */}
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-semibold tracking-tight text-foreground text-sm truncate">
              自动化测试报告智能助理
            </span>
            <span className="hidden sm:inline-flex rounded-full bg-muted/60 px-2 py-0.5 text-[10px] font-mono text-muted-foreground shrink-0">
              v2.0
            </span>
          </div>

          {/* 开发模式专属的 Tab 页签 */}
          {tabs.length > 1 ? (
            <nav className="ml-3 flex items-center gap-1 shrink-0" aria-label="开发模式导航">
              {tabs.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  className={cn(
                    "rounded-md px-3 py-1 text-xs font-medium transition-all cursor-pointer",
                    tab === entry.key
                      ? "bg-card text-foreground shadow-2xs border border-border/70 font-semibold"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                  )}
                  aria-current={tab === entry.key ? "page" : undefined}
                  onClick={() => onChangeTab(entry.key)}
                >
                  {entry.label}
                </button>
              ))}
            </nav>
          ) : null}
        </div>

        {/* 右侧工具栏：模式切换、退出、主题切换 */}
        <div className="flex items-center gap-2.5 shrink-0">
          {/* 开发 / 上线模式切换器 */}
          {devModeAllowed ? (
            <div
              className="flex items-center rounded-full border border-border/70 bg-muted/40 p-0.5 text-xs shadow-2xs"
              role="radiogroup"
              aria-label="模式切换"
            >
              <button
                type="button"
                className={cn(
                  "rounded-full px-3 py-1 font-medium transition-all text-xs cursor-pointer",
                  !isDev
                    ? "bg-card text-foreground shadow-2xs font-semibold"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => onModeChange("prod")}
                title="上线模式：面向业务与测试人员，隐藏调试功能与测试用例"
              >
                上线
              </button>
              <button
                type="button"
                className={cn(
                  "flex items-center gap-1 rounded-full px-2.5 py-1 font-medium transition-all text-xs cursor-pointer",
                  isDev
                    ? "bg-brand/15 text-brand shadow-2xs font-semibold"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => onModeChange("dev")}
                title="开发模式：开放内置测试用例库与原始执行 JSON 调试"
              >
                <IconTerminal width={12} height={12} />
                开发
              </button>
            </div>
          ) : null}

          {/* 鉴权退出登录 */}
          {authRequired && onLogout ? (
            <button
              type="button"
              className="flex h-8 items-center gap-1.5 rounded-full border border-border/70 bg-card/80 px-3 text-xs font-medium text-muted-foreground transition-all hover:bg-muted hover:text-foreground cursor-pointer"
              onClick={onLogout}
              title="退出当前访问口令认证"
            >
              <IconShieldCheck width={13} height={13} className="text-ok" />
              <span>退出</span>
            </button>
          ) : null}

          {/* 主题切换 */}
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-full border border-border/70 bg-card/80 text-foreground transition-all hover:bg-muted active:scale-95 shadow-2xs cursor-pointer"
            onClick={onToggleTheme}
            aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
            title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
          >
            {theme === "dark" ? <IconSun width={15} height={15} /> : <IconMoon width={15} height={15} />}
          </button>
        </div>
      </div>
    </header>
  );
}
